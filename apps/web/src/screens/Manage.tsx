import { resolveTransactionTags } from '../transaction-tags.js';
import { PayeeDirectory } from '../ui/PayeeDirectory.js';
import { withRememberedPayee } from '../payee-recording.js';
import { CategoryMark, EntityIcon } from '../ui/EntityIcon.js';
import { accountSessionStorage } from '../account-storage.js';
import { useCallback, useEffect, useState, type ReactNode } from 'react';
import { isDateInRange, nextUnhandledScheduleOccurrence, type Attachment, type Category, type FixedAssetCategory } from '@zichan/core';
import {
  archiveMasterData,
  disableSystemCategories,
  enableSystemCategories,
  mergeMasterData,
  previewMasterDataChange,
  restoreArchivedMasterData,
  type AttachmentReplicaBlobRow,
  type MasterDataImpact,
  type MasterDataKind,
  type SqlLedgerStore,
} from '@zichan/db';
import { useStore } from '../db/store.js';
import { useSnapshot, type Snapshot } from '../db/snapshot.js';
import { assetById } from '../db/derive.js';
import { EntityFormModal, type EntityFormSpec } from '../ui/EntityFormModal.js';
import {
  assetForm, accountForm, priceMarkForm, dcaPlanForm, gameForm, gameAccountForm, gameSeasonForm,
  categoryForm, fixedAssetCategoryForm, payeeForm, budgetCategoryForm, scheduledTransactionForm,
  transactionLocationForm, transactionTagForm, transactionTemplateForm,
} from '../forms.js';
import { card, th as thStyle, td as tdStyle } from '../ui/styles.js';
import { AccountSetupPanel } from '../ui/AccountSetupPanel.js';
import { QuickCategorySettings } from '../ui/QuickCategorySettings.js';
import { DateRangeBar, dateRangeValue } from '../ui/DateRangeBar.js';
import { useCompactView } from '../ui/useCompactView.js';
import { allCategories, availableExtensionCategories, CATEGORY_PACKS, categoryIsHidden, categoryLabel, categoryPackMemberState, categoryPackState, categoryPacksContaining, TYPE_LABEL, type CatalogCategory, type CategoryPack, type CategoryPackMemberState, type CategoryPackState } from '../transactionMeta.js';
import { ConfirmDialog } from '../ui/ConfirmDialog.js';
import { attachmentStorageStatus, reconcileAttachmentStorage } from '../db/attachment-storage.js';
import { ATTACHMENT_SYNC_STATE_EVENT, ensureAttachmentBlobAvailable } from '../attachment-sync.js';
import { loadSyncConnections } from '../sync-config.js';
import { useUndo } from '../ui/UndoToast.js';
import { AssetIcon } from '../ui/AssetIcon.js';
import { ASSET_PRESETS, ASSET_PRESET_GROUPS, ensureAssetPreset, type AssetPresetCode } from '../assetPresets.js';

const ASSET_TYPE_LABEL: Record<string, string> = {
  fiat: '法币', stablecoin: '稳定币', crypto: '加密货币', stock: '股票', fund: '基金 / ETF',
  bond: '债券 / 固收', precious_metal: '贵金属', game: '游戏货币', fixed: '物品资产',
};
const KIND_LABEL: Record<string, string> = {
  bank: '银行', cash: '现金', exchange: '交易所', wallet: '钱包', credit_card: '信用卡',
  loan: '贷款', game_platform: '游戏平台', other: '其他',
};
const norm = (value: unknown) => String(value ?? '').trim().toLowerCase();

type ManageTab = 'transactionCategories' | 'fixedCategories' | 'labels' | 'assets' | 'other';
type CategoryCenterMode = 'structure' | 'quick';
type ManageTarget = { tab?: ManageTab; categoryMode?: CategoryCenterMode };

const MANAGE_TARGET_KEY = 'zichan.manage.target';

function readManageTarget(): ManageTarget {
  try {
    const raw = accountSessionStorage.getItem(MANAGE_TARGET_KEY);
    return raw ? JSON.parse(raw) as ManageTarget : {};
  } catch {
    return {};
  }
}

export function Manage() {
  const { store, bump, preview } = useStore();
  const snap = useSnapshot('manage');
  const [accountSetupOpen, setAccountSetupOpen] = useState(false);
  const [editingAccount, setEditingAccount] = useState<import('@zichan/core').Account>();
  const [payeeView, setPayeeView] = useState<'mine' | 'catalog'>('mine');
  const [initialTarget] = useState(readManageTarget);
  const [tab, setTab] = useState<ManageTab>(initialTarget.tab ?? 'transactionCategories');
  const [categoryMode, setCategoryMode] = useState<CategoryCenterMode>(initialTarget.categoryMode ?? 'structure');
  const [categoryPackBusy, setCategoryPackBusy] = useState('');
  const [categoryPackNotice, setCategoryPackNotice] = useState('');
  const [categoryPackError, setCategoryPackError] = useState('');
  const [expandedPack, setExpandedPack] = useState('');
  const [addingAssetCode, setAddingAssetCode] = useState<AssetPresetCode | null>(null);
  const [assetCatalogError, setAssetCatalogError] = useState('');
  const undo = useUndo(store, () => bump());
  useEffect(() => {
    try {
      accountSessionStorage.removeItem(MANAGE_TARGET_KEY);
    } catch {
      // Session storage can be unavailable in hardened browser profiles.
    }
  }, []);
  if (!snap) return null;

  const codeOf = (id: string) => assetById(snap).get(id)?.code ?? id;
  const gameName = (id: string) => snap.games.find((g) => g.id === id)?.name ?? id;
  const usesAccounts = true;
  // Captured after the null guard so the hoisted pack helpers below do not have to
  // re-narrow the snapshot.
  const packCategories = snap.categories;

  async function saveCategoryPreferences(updates: Category[]) {
    await store.runInAuditBatch('调整快速记账分类', async (transactionStore) => {
      for (const category of updates) {
        const { catalogOnly: _catalogOnly, ...persisted } = category as Category & { catalogOnly?: boolean };
        await transactionStore.categories.put(persisted);
      }
    }, 'bulk_update');
    bump();
  }

  /** 仍被其他「已启用」扩展包引用的共享成员：停用本包时必须保留它们可用。 */
  function retainedPackMemberIds(pack: CategoryPack): string[] {
    const others = CATEGORY_PACKS.filter((other) =>
      other.id !== pack.id && categoryPackState(other, packCategories).status === 'enabled');
    return pack.categoryIds.filter((id) => others.some((other) => other.categoryIds.includes(id)));
  }

  async function setCategoryPackEnabled(pack: CategoryPack, enable: boolean) {
    setCategoryPackBusy(pack.id);
    setCategoryPackNotice('');
    setCategoryPackError('');
    try {
      if (enable) {
        const rows = await enableSystemCategories(store, pack.categoryIds);
        bump();
        setCategoryPackNotice(`已启用「${pack.name}」扩展包 ${rows.length} 项分类；现在可在新增记账中选择。`);
        undo.offer(`已启用「${pack.name}」扩展包`, async () => {
          await disableSystemCategories(store, pack.categoryIds, { retainIds: retainedPackMemberIds(pack) });
          bump();
        });
      } else {
        const result = await disableSystemCategories(store, pack.categoryIds, { retainIds: retainedPackMemberIds(pack) });
        bump();
        setCategoryPackNotice([
          `已停用「${pack.name}」扩展包 ${result.disabledIds.length} 项分类；新增记账将不再显示`,
          result.retainedUsedIds.length ? `${result.retainedUsedIds.length} 项仍保留历史引用` : '',
          result.retainedSharedIds.length ? `${result.retainedSharedIds.length} 项仍由其他扩展包使用，未改动` : '',
        ].filter(Boolean).join('；'));
        undo.offer(`已停用「${pack.name}」扩展包`, async () => {
          await enableSystemCategories(store, result.disabledIds);
          bump();
        });
      }
    } catch (error) {
      setCategoryPackError(error instanceof Error ? error.message : String(error));
    } finally {
      setCategoryPackBusy('');
    }
  }

  /** 单个成员开关：只影响这一项，不改动包内其他分类。 */
  async function togglePackMember(categoryId: string, enable: boolean) {
    setCategoryPackBusy(categoryId);
    setCategoryPackNotice('');
    setCategoryPackError('');
    try {
      if (enable) await enableSystemCategories(store, [categoryId]);
      else await disableSystemCategories(store, [categoryId]);
      bump();
    } catch (error) {
      setCategoryPackError(error instanceof Error ? error.message : String(error));
    } finally {
      setCategoryPackBusy('');
    }
  }

  async function addPresetAsset(code: AssetPresetCode) {
    setAddingAssetCode(code);
    setAssetCatalogError('');
    try {
      await ensureAssetPreset(store, code);
      bump();
    } catch (error) {
      setAssetCatalogError(error instanceof Error ? error.message : String(error));
    } finally {
      setAddingAssetCode(null);
    }
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 22 }}>
      <div>
        <div style={{ fontSize: 'var(--fs-heading)', fontWeight: 'var(--fw-bold)' }}>资产与资料中心</div>
        <div style={{ color: 'var(--text-tertiary)', fontSize: 'var(--fs-caption)', marginTop: 4 }}>在资产标签管理货币与资产的加入、停用和归档；其他标签维护分类与基础资料。</div>
      </div>

      <div role="tablist" aria-label="资产与资料中心" style={{ display: 'flex', gap: 4, borderBottom: '1px solid var(--border)', overflowX: 'auto' }}>
        {([
          ['transactionCategories', '收支分类'],
          ['fixedCategories', '物品分类'],
          ['labels', '标签与交易对象'],
          ['assets', '资产'],
          ['other', '其他资料'],
        ] as const).map(([id, label]) => (
          <button key={id} role="tab" aria-selected={tab === id} type="button" onClick={() => setTab(id)} style={manageTabButton(tab === id)}>{label}</button>
        ))}
      </div>

      {tab === 'transactionCategories' && (
        <>
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
            <button type="button" onClick={() => setCategoryMode('structure')} style={manageFilterButton(categoryMode === 'structure', true)}>结构管理</button>
            <button type="button" onClick={() => setCategoryMode('quick')} style={manageFilterButton(categoryMode === 'quick', true)}>快捷显示与排序</button>
          </div>
          {categoryMode === 'structure'
            ? <CategorySection snap={snap} store={store} bump={bump} />
            : (
              <>
                <div style={card}>
                  <div style={{ fontSize: 'var(--fs-title)', fontWeight: 'var(--fw-bold)' }}>扩展包</div>
                  <div style={{ marginTop: 4, color: 'var(--text-tertiary)', fontSize: 'var(--fs-caption)' }}>
                    扩展包只补充默认没有的可选分类：启用后可在新增记账中选用，停用后不再可选，不会删除历史分类、改动已有流水，也不会影响默认分类。
                    点开卡片名称可以查看包内每一项的当前状态，并单独启用或停用。
                  </div>
                  <div style={{ marginTop: 12, display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(230px, 1fr))', gap: 8 }}>
                    {CATEGORY_PACKS.map((pack) => {
                      const state = categoryPackState(pack, snap.categories);
                      const busy = categoryPackBusy === pack.id;
                      const expanded = expandedPack === pack.id;
                      return (
                        <div key={pack.id} data-testid={`category-pack-${pack.id}`} style={{ border: '1px solid var(--border)', borderRadius: 'var(--r-sm)', padding: 11, display: 'grid', gap: 8, alignContent: 'start' }}>
                          <button type="button" aria-expanded={expanded} aria-label={`查看${pack.name}扩展包成员`} onClick={() => setExpandedPack(expanded ? '' : pack.id)} style={packHeaderButton}>
                            <b style={{ fontSize: 'var(--fs-body)' }}>{pack.name}</b>
                            <span style={{ marginLeft: 'auto', fontSize: 'var(--fs-meta)', color: 'var(--text-tertiary)' }}>{packStatusLabel(state)}</span>
                          </button>
                          <div style={{ color: 'var(--text-secondary)', fontSize: 'var(--fs-meta)', minHeight: 30 }}>{pack.description}</div>
                          <div style={{ display: 'flex', gap: 7 }}>
                            <button type="button" aria-label={`启用${pack.name}扩展包`} disabled={busy || state.status === 'enabled'} onClick={() => void setCategoryPackEnabled(pack, true)} style={packButton(true)}>
                              {busy ? '处理中…' : state.status === 'enabled' ? '已启用' : state.status === 'disabled' ? '启用' : '补齐并启用'}
                            </button>
                            <button type="button" aria-label={`停用${pack.name}扩展包`} disabled={busy || state.enabledCount === 0} onClick={() => void setCategoryPackEnabled(pack, false)} style={packButton(false)}>
                              停用
                            </button>
                          </div>
                          {expanded && (
                            <div data-testid={`category-pack-members-${pack.id}`} style={{ display: 'grid', gap: 5, borderTop: '1px solid var(--border)', paddingTop: 8 }}>
                              {pack.categoryIds.map((categoryId) => {
                                const memberState = categoryPackMemberState(categoryId, snap.categories);
                                const selectable = memberState === 'disabled' || memberState === 'missing';
                                const label = categoryLabel(categoryId, snap.categories);
                                return (
                                  <div key={categoryId} style={{ display: 'flex', alignItems: 'center', gap: 6, minWidth: 0 }}>
                                    <span style={{ flex: 1, minWidth: 0, fontSize: 'var(--fs-meta)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{label}</span>
                                    <span style={{ fontSize: 'var(--fs-meta)', color: memberState === 'enabled' ? 'var(--positive)' : 'var(--text-tertiary)', whiteSpace: 'nowrap' }}>{PACK_MEMBER_LABEL[memberState]}</span>
                                    <button type="button" aria-label={`${selectable ? '启用' : '停用'}${label}`} disabled={categoryPackBusy === categoryId} onClick={() => void togglePackMember(categoryId, selectable)} style={packMemberButton}>
                                      {selectable ? '启用' : '停用'}
                                    </button>
                                  </div>
                                );
                              })}
                            </div>
                          )}
                        </div>
                      );
                    })}
                  </div>
                  {categoryPackNotice && <div style={{ marginTop: 10, color: 'var(--positive)', fontSize: 'var(--fs-caption)', fontWeight: 'var(--fw-medium)' }}>{categoryPackNotice}</div>}
                  {categoryPackError && <div role="alert" style={{ marginTop: 10, color: 'var(--negative)', fontSize: 'var(--fs-caption)', fontWeight: 'var(--fw-medium)' }}>扩展包操作失败：{categoryPackError}</div>}
                </div>
                <div style={card}><QuickCategorySettings categories={snap.categories} onSave={saveCategoryPreferences} /></div>
              </>
            )}
        </>
      )}

      {tab === 'fixedCategories' && <FixedCategorySection snap={snap} store={store} bump={bump} />}

      {tab === 'labels' && (
        <>
          <Section
            title="标签" headers={['名称', '分组', '颜色', '排序']}
            items={snap.transactionTags}
            row={(t) => [t.name, t.groupName ?? '—', t.color ?? '—', String(t.sortOrder ?? '')]}
            duplicateKey={(t) => `${norm(t.groupName)}:${norm(t.name)}`}
            makeSpec={() => transactionTagForm()}
            put={(transactionStore, entity) => transactionStore.transactionTags.put(entity)}
            bump={bump} masterKind="tag"
            lifecycleCandidates={snap.transactionTags.filter((row) => row.isActive).map((row) => ({ id: row.id, label: row.groupName ? `${row.groupName} / ${row.name}` : row.name }))}
          />
          <Section
            title="地点" headers={['名称', '地址', '经纬度']}
            items={snap.transactionLocations}
            row={(l) => [l.name, l.address ?? '—', l.latitude && l.longitude ? `${l.latitude}, ${l.longitude}` : '—']}
            duplicateKey={(l) => norm(l.name)}
            makeSpec={() => transactionLocationForm()}
            put={(transactionStore, entity) => transactionStore.transactionLocations.put(entity)}
            bump={bump} masterKind="location"
            lifecycleCandidates={snap.transactionLocations.filter((row) => row.isActive).map((row) => ({ id: row.id, label: row.name }))}
          />
          <div role="tablist" aria-label="交易对象视图" style={{ display: 'flex', gap: 8 }}>
            <button role="tab" aria-selected={payeeView === 'mine'} onClick={() => setPayeeView('mine')} style={manageFilterButton(payeeView === 'mine', true)}>我的交易对象</button>
            <button role="tab" aria-selected={payeeView === 'catalog'} onClick={() => setPayeeView('catalog')} style={manageFilterButton(payeeView === 'catalog', true)}>平台目录</button>
          </div>
          {payeeView === 'catalog' ? <PayeeDirectory snap={snap} /> : <Section
            title="交易对象" headers={usesAccounts ? ['名称', '默认分类', '默认账户', '别名'] : ['名称', '默认分类', '别名']}
            items={snap.payees}
            itemLabel={(p) => p.name}
            searchText={(p) => [p.name, ...(p.aliases ?? []), p.defaultCategory ? categoryLabel(p.defaultCategory, snap.categories) : '', snap.accounts.find((a) => a.id === p.defaultAccountId)?.name ?? ''].join(' ')}
            row={(p) => usesAccounts
              ? [<span className="zc-entity-name"><EntityIcon icon={p.icon} platformId={p.id} platformName={p.name} fallback="store" />{p.name}</span>, p.defaultCategory ? categoryLabel(p.defaultCategory, snap.categories) : '—', p.defaultAccountId ? snap.accounts.find((a) => a.id === p.defaultAccountId)?.name ?? p.defaultAccountId : '—', p.aliases?.join(' / ') ?? '—']
              : [<span className="zc-entity-name"><EntityIcon icon={p.icon} platformId={p.id} platformName={p.name} fallback="store" />{p.name}</span>, p.defaultCategory ? categoryLabel(p.defaultCategory, snap.categories) : '—', p.aliases?.join(' / ') ?? '—']}
            duplicateKey={(p) => norm(p.name)}
            makeSpec={() => payeeForm(snap)}
            put={(transactionStore, entity) => transactionStore.payees.put(entity)}
            bump={bump} masterKind="payee"
            lifecycleCandidates={snap.payees.filter((row) => row.isActive).map((row) => ({ id: row.id, label: row.name }))}
          />}
        </>
      )}

      {editingAccount && <AccountSetupPanel initial={editingAccount} store={store} assets={snap.assets} accounts={snap.accounts} setting={snap.setting} onClose={() => setEditingAccount(undefined)} onSaved={() => { setEditingAccount(undefined); bump(); }} />}
      {accountSetupOpen && <AccountSetupPanel store={store} assets={snap.assets} accounts={snap.accounts} setting={snap.setting} onClose={() => setAccountSetupOpen(false)} onSaved={() => { setAccountSetupOpen(false); bump(); }} />}
      {tab === 'assets' && (
        <>
          <Section
            title="资产" headers={['代码', '名称', '类型', '精度', '状态']}
            items={snap.assets}
            itemLabel={(a) => a.code}
            row={(a) => [<span><span className="zc-entity-name"><AssetIcon code={a.code} symbol={a.symbol} size={22} />{a.code}</span><small className="zc-manage-asset-status-mobile">{a.isDeleted ? '已归档' : a.isActive ? '可用' : '已停用'}</small></span>, a.name, ASSET_TYPE_LABEL[a.type] ?? a.type, String(a.decimals), a.isDeleted ? <span style={stateBadge('inactive')}>已归档</span> : !a.isActive ? <span style={stateBadge('inactive')}>已停用</span> : <span style={stateBadge('available')}>可用</span>]}
            searchText={(a) => `${a.code} ${a.name} ${a.isDeleted ? '已归档' : a.isActive ? '可用' : '已停用'}`}
            duplicateKey={(a) => norm(a.code)}
            makeSpec={() => assetForm()}
            put={(transactionStore, entity) => transactionStore.assets.put(entity)}
            bump={bump} masterKind="asset"
            lifecycleCandidates={snap.assets.filter((row) => !row.isDeleted && row.isActive).map((row) => ({ id: row.id, label: `${row.code} · ${row.name}` }))}
          />
          <details style={card}>
            <summary style={{ color: 'var(--accent)', fontSize: 'var(--fs-title)', fontWeight: 'var(--fw-bold)', cursor: 'pointer' }}>添加常用资产</summary>
            <div style={{ marginTop: 8, color: 'var(--text-secondary)', fontSize: 'var(--fs-caption)' }}>预设不会自动加入账本。选中后只添加资产定义，不生成余额或交易；已停用和已归档的资产可在这里重新启用。</div>
            {ASSET_PRESET_GROUPS.map((group) => <div key={group.label}>
              <div className="zc-asset-preset-group-title">{group.label}</div>
              <div className="zc-asset-preset-grid">
                {ASSET_PRESETS.filter((preset) => group.codes.includes(preset.code)).map((preset) => {
                  const existing = snap.assets.find((row) => !row.mergedIntoId && row.code.trim().toUpperCase() === preset.code);
                  const active = existing && !existing.isDeleted && existing.isActive;
                  const status = active ? '已加入' : existing?.isDeleted ? '已归档' : existing ? '已停用' : '未加入';
                  return <button key={preset.code} type="button" className="zc-asset-preset-button" disabled={!!active || !!addingAssetCode} onClick={() => void addPresetAsset(preset.code)} aria-label={`${active ? '已加入' : existing ? '重新启用' : '加入资产'} ${preset.code}`}>
                    <AssetIcon code={preset.code} symbol={preset.symbol} size={30} />
                    <span><strong>{preset.code} · {preset.name}</strong><small>{status}{!active ? ' · 点击加入资产' : ''}</small></span>
                  </button>;
                })}
              </div>
            </div>)}
            {assetCatalogError && <div role="alert" style={{ marginTop: 10, color: 'var(--negative)' }}>{assetCatalogError}</div>}
          </details>
        </>
      )}

      {tab === 'other' && (
        <>
          {usesAccounts && (
            <Section
              title="账户" headers={['名称', '类型', '平台', '账单 / 期限']}
              items={snap.accounts}
              row={(a) => [
                a.name,
                KIND_LABEL[a.kind] ?? a.kind,
                a.platform ?? '—',
                a.kind === 'credit_card'
                  ? `${a.statementDay ?? '—'} 日出账 · ${a.paymentDueDay ?? '—'} 日还款`
                  : a.kind === 'loan'
                    ? `${a.loanStartDate ?? '—'} 至 ${a.loanEndDate ?? '—'}`
                    : '—',
              ]}
              duplicateKey={(a) => `${norm(a.kind)}:${norm(a.platform)}:${norm(a.name)}`}
              onAdd={() => setAccountSetupOpen(true)} onEdit={setEditingAccount}
              makeSpec={() => accountForm()}
              put={(transactionStore, entity) => transactionStore.accounts.put(entity)}
              bump={bump} masterKind="account"
              lifecycleCandidates={snap.accounts.filter((row) => row.isActive !== false).map((row) => ({ id: row.id, label: row.name }))}
            />
          )}
          <Section title="交易模板" headers={['名称', '类型', '分类', '金额']} items={snap.transactionTemplates} row={(t) => [t.name, TYPE_LABEL[t.type], categoryLabel(t.category, snap.categories), t.amount ?? '—']} duplicateKey={(t) => norm(t.name)} makeSpec={() => transactionTemplateForm(snap, { usesAccounts })} put={async (transactionStore, entity) => transactionStore.transactionTemplates.put({ ...await withRememberedPayee(transactionStore, entity), tagIds: await resolveTransactionTags(transactionStore, entity.tagIds) })} bump={bump} />
          <Section title="价格与折算率" headers={['资产', '每单位价格', '计价币种', '日期']} items={snap.priceMarks} row={(m) => [codeOf(m.assetId), m.price, codeOf(m.quoteAssetId), m.date]} dateOf={(m) => m.date} duplicateKey={(m) => `${m.assetId}:${m.quoteAssetId}:${m.date}`} makeSpec={() => priceMarkForm(snap)} put={(transactionStore, entity) => transactionStore.priceMarks.put(entity)} bump={bump} />
          <Section title="定投计划" headers={['名称', '目标', '金额', '频率', '状态']} items={snap.dcaPlans} row={(p) => [p.name, codeOf(p.targetAssetId), `${p.plannedAmount} ${codeOf(p.baseCurrencyAssetId)}`, p.frequency, p.status]} duplicateKey={(p) => norm(p.name)} makeSpec={() => dcaPlanForm(snap)} put={(transactionStore, entity) => transactionStore.dcaPlans.put(entity)} bump={bump} />
          <Section title="分类预算" headers={['月份', '分类', '预算', '币种', '结转']} items={snap.budgetCategories} row={(b) => [b.month, categoryLabel(b.category, snap.categories), b.plannedAmount, codeOf(b.assetId), b.rolloverMode === 'none' ? '不结转' : b.rolloverMode === 'positive_only' ? '仅结余' : '含超支']} duplicateKey={(b) => `${b.month}:${b.category}`} makeSpec={() => budgetCategoryForm(snap)} put={(transactionStore, entity) => transactionStore.budgetCategories.put(entity)} bump={bump} />
          <Section title="定期交易" headers={['名称', '类型', '金额', '下次日期', '状态']} items={snap.scheduledTransactions} row={(s) => [s.name, TYPE_LABEL[s.type], `${s.amount} ${codeOf(s.assetId)}`, nextUnhandledScheduleOccurrence(s, snap.scheduledExecutions)?.date ?? '已结束', s.status]} duplicateKey={(s) => norm(s.name)} makeSpec={() => scheduledTransactionForm(snap)} put={async (transactionStore, entity) => transactionStore.scheduledTransactions.put(await withRememberedPayee(transactionStore, entity))} bump={bump} />
          <Section
            title="游戏" headers={['名称', '平台', '区服']} items={snap.games}
            row={(g) => [g.name, g.platform ?? '—', g.serverName ?? '—']}
            duplicateKey={(g) => `${norm(g.name)}:${norm(g.platform)}:${norm(g.serverName)}`}
            makeSpec={() => gameForm()} put={(transactionStore, entity) => transactionStore.games.put(entity)} bump={bump} masterKind="game"
            lifecycleCandidates={snap.games.filter((row) => row.isActive !== false).map((row) => ({ id: row.id, label: row.name }))}
          />
          <Section
            title="游戏账号" headers={['游戏', '账号', '状态']} items={snap.gameAccounts}
            row={(a) => [gameName(a.gameId), a.accountName, a.status]}
            duplicateKey={(a) => `${a.gameId}:${norm(a.serverName)}:${norm(a.accountName)}`}
            makeSpec={() => gameAccountForm(snap)} put={(transactionStore, entity) => transactionStore.gameAccounts.put(entity)} bump={bump} masterKind="game_account"
            lifecycleCandidates={snap.gameAccounts.filter((row) => row.status === 'active').map((row) => ({ id: row.id, label: `${gameName(row.gameId)} / ${row.serverName ? row.serverName + ' / ' : ''}${row.accountName}` }))}
          />
          <Section
            title="游戏赛季" headers={['游戏', '赛季', '开始', '状态']} items={snap.seasons}
            row={(season) => [gameName(season.gameId), season.name, season.startDate ?? '—', season.status]}
            dateOf={(season) => season.startDate ?? season.endDate ?? ''}
            duplicateKey={(season) => `${season.gameId}:${norm(season.name)}`}
            makeSpec={() => gameSeasonForm(snap)} put={(transactionStore, entity) => transactionStore.gameSeasons.put(entity)} bump={bump} masterKind="game_season"
            lifecycleCandidates={snap.seasons.filter((row) => row.status !== 'ended').map((row) => ({ id: row.id, label: `${gameName(row.gameId)} / ${row.name}` }))}
          />
          <AttachmentSection
            items={snap.attachments}
            preview={Boolean(preview)}
            onDelete={async (attachment) => {
              await store.runInAuditBatch(`删除附件“${attachment.fileName}”`, async (transactionStore) => {
                await transactionStore.attachments.remove(attachment.id, attachment.version);
              });
              await reconcileAttachmentStorage(store);
              bump();
            }}
          />
        </>
      )}
    </div>
  );
}

function manageTabButton(active: boolean) {
  return {
    border: 'none',
    borderBottom: `2px solid ${active ? 'var(--accent)' : 'transparent'}`,
    background: active ? 'var(--accent-soft)' : 'transparent',
    color: active ? 'var(--accent)' : 'var(--fg-muted)',
    padding: '10px 16px',
    fontSize: 'var(--fs-body)',
    fontWeight: 'var(--fw-bold)',
    cursor: 'pointer',
    whiteSpace: 'nowrap',
  } as const;
}

type CategoryTypeFilter = 'all' | Category['type'];
type CategoryVisibilityFilter = 'all' | 'frequent' | 'hidden' | 'inactive';

function CategorySection({ snap, store, bump }: {
  snap: Snapshot;
  store: SqlLedgerStore;
  bump: () => void;
}) {
  const compactView = useCompactView();
  const categories = allCategories(snap.categories, { includeInactive: true });
  const parents = categories.filter((category) => !category.parentId);
  const undo = useUndo(store, () => bump());
  const [availableBusy, setAvailableBusy] = useState('');
  const [availableError, setAvailableError] = useState('');
  const [editing, setEditing] = useState<Category | 'new' | null>(null);
  const [lifecycle, setLifecycle] = useState<Category | null>(null);
  const [query, setQuery] = useState('');
  const [typeFilter, setTypeFilter] = useState<CategoryTypeFilter>('all');
  const [parentFilter, setParentFilter] = useState('all');
  const [visibilityFilter, setVisibilityFilter] = useState<CategoryVisibilityFilter>('all');
  const [showDuplicates, setShowDuplicates] = useState(false);
  const [expandedParents, setExpandedParents] = useState<Set<string>>(() => new Set());

  const duplicateKeys = new Map<string, number>();
  for (const category of categories) {
    const key = `${category.type}:${category.parentId ?? ''}:${norm(category.name)}`;
    duplicateKeys.set(key, (duplicateKeys.get(key) ?? 0) + 1);
  }
  const duplicateCount = [...duplicateKeys.values()].filter((count) => count > 1).length;
  const isDuplicate = (category: Category) => duplicateKeys.get(`${category.type}:${category.parentId ?? ''}:${norm(category.name)}`)! > 1;
  const q = norm(query);
  const parentChoices = parents.filter((parent) => typeFilter === 'all' || parent.type === typeFilter);

  const categoryMatches = (category: Category, parent: Category) => {
    if (typeFilter !== 'all' && category.type !== typeFilter) return false;
    if (parentFilter !== 'all' && parent.id !== parentFilter) return false;
    if (showDuplicates && !isDuplicate(category)) return false;
    if (visibilityFilter === 'frequent' && (category.isActive === false || categoryIsHidden(category))) return false;
    if (visibilityFilter === 'hidden' && !categoryIsHidden(category)) return false;
    if (visibilityFilter === 'inactive' && category.isActive !== false) return false;
    if (q && !norm(`${parent.name} ${category.name} ${category.id}`).includes(q)) return false;
    return true;
  };

  /**
   * 目录里存在、账本里还没有的扩展分类，按一级分类分组。
   *
   * 扩展包只收录“会被同一类人成组需要”的分类；剩下的大量细分项（早餐、检查化验、
   * KTV……）需要一条浏览入口：用户不必先知道名字才能找到它。搜索框同时过滤这张
   * 清单，所以输入“KTV”会直接把「休闲娱乐」展开到它所在的位置。
   */
  const parentNameById = new Map(parents.map((parent) => [parent.id, parent.name]));
  const availableByParent = new Map<string, CatalogCategory[]>();
  // 只在没有按显示状态筛选（或只看重复）时列出“可添加”：这些目录项既不是“隐藏”
  // 也不是“已停用”，在那些筛选视图里冒出来只会打架。
  const showAvailable = visibilityFilter === 'all' && !showDuplicates;
  if (showAvailable) {
    for (const category of availableExtensionCategories(snap.categories)) {
      if (!category.parentId) continue;
      if (q && !norm(`${parentNameById.get(category.parentId) ?? ''} ${category.name} ${category.id}`).includes(q)) continue;
      const rows = availableByParent.get(category.parentId);
      if (rows) rows.push(category);
      else availableByParent.set(category.parentId, [category]);
    }
  }

  const groups = parents.map((parent) => {
    const children = categories.filter((category) => category.parentId === parent.id);
    const visibleChildren = children.filter((category) => categoryMatches(category, parent));
    const parentMatches = categoryMatches(parent, parent);
    const availableChildren = availableByParent.get(parent.id) ?? [];
    return { parent, children, visibleChildren, availableChildren, parentMatches };
  }).filter(({ parent, visibleChildren, availableChildren, children, parentMatches }) => (
    (typeFilter === 'all' || parent.type === typeFilter)
    && (parentFilter === 'all' || parent.id === parentFilter)
    && (visibleChildren.length > 0 || availableChildren.length > 0 || (children.length === 0 && parentMatches))
  ));

  const groupedIds = new Set(parents.map((parent) => parent.id));
  const orphanRows = categories.filter((category) => category.parentId && !groupedIds.has(category.parentId));
  const visibleOrphanRows = orphanRows.filter((category) => categoryMatches(category, category));
  const forceOpen = Boolean(q) || parentFilter !== 'all' || visibilityFilter !== 'all' || showDuplicates;
  const allExpanded = groups.length > 0 && groups.every(({ parent }) => expandedParents.has(parent.id));
  const open = editing !== null;
  const initial = editing === 'new' ? undefined : (editing ?? undefined);

  const toggleExpanded = (id: string, nextOpen: boolean) => {
    setExpandedParents((current) => {
      const next = new Set(current);
      if (nextOpen) next.add(id);
      else next.delete(id);
      return next;
    });
  };

  const toggleHidden = async (category: Category) => {
    await store.runInAuditBatch(
      `${categoryIsHidden(category) ? '显示' : '隐藏'}分类“${category.name}”`,
      (transactionStore) => transactionStore.categories.put({ ...category, isHidden: !categoryIsHidden(category) }),
    );
    bump();
  };

  /**
   * 添加目录里的扩展分类。
   *
   * 只传「账本里还没有」的 id，所以这批行必定是本次新建的：撤销时按 id 停用
   * 即可回到添加前的状态，不会误伤用户原有的分类。
   */
  const addExtensionCategories = async (ids: readonly string[], label: string) => {
    if (ids.length === 0) return;
    setAvailableBusy(ids.length === 1 ? ids[0]! : label);
    setAvailableError('');
    try {
      const rows = await enableSystemCategories(store, ids);
      bump();
      undo.offer(`已添加${label}（${rows.length} 项）`, async () => {
        await disableSystemCategories(store, rows.map((row) => row.id));
        bump();
      });
    } catch (error) {
      setAvailableError(error instanceof Error ? error.message : String(error));
    } finally {
      setAvailableBusy('');
    }
  };

  return (
    <div style={card}>
      <div className="zc-responsive-header" style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 16, marginBottom: 14 }}>
        <div>
          <div style={{ fontSize: 'var(--fs-title)', fontWeight: 'var(--fw-bold)' }}>
            收支分类
            <span style={{ fontSize: 'var(--fs-caption)', color: 'var(--text-tertiary)', marginLeft: 8, fontWeight: 'var(--fw-medium)' }}>{categories.length}</span>
          </div>
          <div style={{ fontSize: 'var(--fs-meta)', color: 'var(--text-tertiary)', marginTop: 4 }}>按一级分类折叠管理；隐藏分类仍可通过搜索找到。</div>
          {duplicateCount > 0 && <div style={{ fontSize: 'var(--fs-meta)', color: 'var(--negative)', marginTop: 3 }}>发现 {duplicateCount} 组可能重复分类。</div>}
        </div>
        <button onClick={() => setEditing('new')} style={{ padding: '8px 14px', borderRadius: 'var(--r-sm)', border: '1px solid var(--accent)', background: 'var(--accent)', color: 'var(--on-accent)', fontWeight: 'var(--fw-bold)', fontSize: 'var(--fs-body)', cursor: 'pointer', whiteSpace: 'nowrap' }}>+ 新增分类</button>
      </div>

      <div className="zc-category-manage-toolbar">
        <input aria-label="搜索收支分类" className="zc-input" value={query} onChange={(e) => setQuery(e.target.value)} placeholder="搜索分类名称或 ID" />
        <select aria-label="分类类型" className="zc-select" value={typeFilter} onChange={(e) => { setTypeFilter(e.target.value as CategoryTypeFilter); setParentFilter('all'); }}>
          <option value="all">全部类型</option>
          <option value="expense">支出</option>
          <option value="income">收入</option>
        </select>
        <select aria-label="一级分类" className="zc-select" value={parentFilter} onChange={(e) => setParentFilter(e.target.value)}>
          <option value="all">全部一级分类</option>
          {parentChoices.map((parent) => <option key={parent.id} value={parent.id}>{parent.name}</option>)}
        </select>
        <select aria-label="显示状态" className="zc-select" value={visibilityFilter} onChange={(e) => setVisibilityFilter(e.target.value as CategoryVisibilityFilter)}>
          <option value="all">全部显示状态</option>
          <option value="frequent">高频分类</option>
          <option value="hidden">隐藏分类</option>
          <option value="inactive">已停用</option>
        </select>
      </div>

      <div className="zc-responsive-action-row" style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 10, margin: '10px 0 4px' }}>
        <div style={{ fontSize: 'var(--fs-caption)', color: 'var(--text-tertiary)' }}>找到 {groups.reduce((sum, group) => sum + group.visibleChildren.length, 0)} 个二级分类，分布在 {groups.length} 个一级分类中</div>
        <div style={{ display: 'flex', gap: 8 }}>
          <button
            onClick={() => setShowDuplicates((value) => !value)}
            disabled={duplicateCount === 0}
            style={manageFilterButton(showDuplicates, duplicateCount > 0)}
          >
            {showDuplicates ? '显示全部' : '只看重复'}
          </button>
          <button
            onClick={() => setExpandedParents(allExpanded ? new Set() : new Set(groups.map(({ parent }) => parent.id)))}
            style={manageFilterButton(allExpanded, true)}
          >
            {allExpanded ? '全部收起' : '全部展开'}
          </button>
        </div>
      </div>

      {availableError && <div style={{ fontSize: 'var(--fs-caption)', color: 'var(--negative)', fontWeight: 'var(--fw-medium)', marginBottom: 8 }}>{availableError}</div>}
      <div style={{ borderBottom: '1px solid var(--border)' }}>
        {groups.map(({ parent, children, visibleChildren, availableChildren }) => {
          const hiddenCount = children.filter(categoryIsHidden).length;
          const inactiveCount = children.filter((category) => category.isActive === false).length;
          const availableLabel = `${parent.name}细分分类`;
          const isOpen = forceOpen || expandedParents.has(parent.id);
          return (
            <details
              key={parent.id}
              open={isOpen}
              onToggle={(event) => { if (!forceOpen) toggleExpanded(parent.id, event.currentTarget.open); }}
              style={{ borderTop: '1px solid var(--border)' }}
            >
              <summary className="zc-category-group-summary">
                <CategoryMark id={parent.id} categories={snap.categories} />
                <span className="zc-category-group-name" title={parent.name} style={{ fontWeight: 'var(--fw-bold)', color: 'var(--text-primary)' }}>{parent.name}</span>
                <span style={typeBadge(parent.type)}>{parent.type === 'income' ? '收入' : '支出'}</span>
                <span style={{ fontSize: 'var(--fs-meta)', color: 'var(--text-tertiary)' }}>{visibleChildren.length}/{children.length} 项</span>
                {hiddenCount > 0 && <span style={stateBadge('hidden')}>隐藏 {hiddenCount}</span>}
                {inactiveCount > 0 && <span style={stateBadge('inactive')}>停用 {inactiveCount}</span>}
                {availableChildren.length > 0 && <span style={stateBadge('available')}>可添加 {availableChildren.length}</span>}
                <span className="zc-category-summary-spacer" style={{ flex: '1 1 auto' }} />
                <button type="button" onClick={(event) => { event.preventDefault(); event.stopPropagation(); setLifecycle(parent); }} style={editLinkButton}>归档/合并</button>
                <button type="button" onClick={(event) => { event.preventDefault(); event.stopPropagation(); setEditing(parent); }} style={{ ...editLinkButton, marginLeft: 12 }}>编辑一级分类</button>
              </summary>
              {compactView ? <div className="zc-manage-category-list">
                {visibleChildren.map((category) => <article className="zc-manage-category-item" key={category.id}>
                  <div className="zc-manage-category-head">
                    <CategoryMark id={category.id} categories={snap.categories} />
                    <strong>{category.name}</strong>
                    {category.isActive === false
                      ? <span style={stateBadge('inactive')}>已停用</span>
                      : categoryIsHidden(category) ? <span style={stateBadge('hidden')}>隐藏</span> : <span style={stateBadge('frequent')}>高频</span>}
                  </div>
                  <details className="zc-manage-category-more">
                    <summary>资料与操作</summary>
                    <div>预算：{category.budgetable ? '纳入' : '不纳入'} · 排序：{category.sortOrder ?? '—'}</div>
                    <div className="zc-manage-category-id">分类 ID：{category.id}</div>
                    <div className="zc-manage-category-actions">
                      <button type="button" onClick={() => void toggleHidden(category)}>{categoryIsHidden(category) ? '设为高频' : '设为隐藏'}</button>
                      <button type="button" onClick={() => setLifecycle(category)}>归档/合并</button>
                      <button type="button" onClick={() => setEditing(category)}>编辑</button>
                    </div>
                  </details>
                </article>)}
                {visibleChildren.length === 0 && <div className="zc-meta">{availableChildren.length > 0 ? '该一级分类下没有匹配的已有分类' : '该一级分类下没有匹配的二级分类'}</div>}
              </div> : <div style={{ overflowX: 'auto' }}>
                <table style={{ width: '100%', borderCollapse: 'collapse' }}>
                  <thead><tr><th style={thStyle}>二级分类</th><th style={thStyle}>显示状态</th><th style={thStyle}>预算</th><th style={thStyle}>排序</th><th style={{ ...thStyle, textAlign: 'right' }}>操作</th></tr></thead>
                  <tbody>
                    {visibleChildren.map((category) => (
                      <tr key={category.id}>
                        <td style={tdStyle}>
                          <span style={{ display: 'inline-flex', alignItems: 'center', gap: 8 }}>
                            <CategoryMark id={category.id} categories={snap.categories} />
                            <span style={{ fontWeight: 'var(--fw-bold)' }}>{category.name}</span>
                            {isDuplicate(category) && <span style={stateBadge('duplicate')}>重复</span>}
                          </span>
                          <div style={{ fontSize: 'var(--fs-meta)', color: 'var(--text-tertiary)', marginTop: 2 }}>{category.id}</div>
                        </td>
                        <td style={tdStyle}>
                          {category.isActive === false
                            ? <span style={stateBadge('inactive')}>已停用</span>
                            : categoryIsHidden(category)
                              ? <span style={stateBadge('hidden')}>隐藏</span>
                              : <span style={stateBadge('frequent')}>高频</span>}
                        </td>
                        <td style={tdStyle}>{category.budgetable ? '纳入' : '不纳入'}</td>
                        <td style={tdStyle}>{category.sortOrder ?? '—'}</td>
                        <td style={{ ...tdStyle, textAlign: 'right', whiteSpace: 'nowrap' }}>
                          <button type="button" onClick={() => void toggleHidden(category)} style={editLinkButton}>
                            {categoryIsHidden(category) ? '设为高频' : '设为隐藏'}
                          </button>
                          <button type="button" onClick={() => setLifecycle(category)} style={{ ...editLinkButton, marginLeft: 12 }}>归档/合并</button>
                          <button type="button" onClick={() => setEditing(category)} style={{ ...editLinkButton, marginLeft: 12 }}>编辑</button>
                        </td>
                      </tr>
                    ))}
                    {visibleChildren.length === 0 && <tr><td style={{ ...tdStyle, color: 'var(--text-tertiary)' }} colSpan={5}>{availableChildren.length > 0 ? '该一级分类下没有匹配的已有分类' : '该一级分类下没有匹配的二级分类'}</td></tr>}
                  </tbody>
                </table>
              </div>}
              {availableChildren.length > 0 && (
                <div style={{ padding: '0 8px 12px' }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap', fontSize: 'var(--fs-meta)', color: 'var(--text-tertiary)' }}>
                    <span>目录里还有 {availableChildren.length} 个细分分类未被使用，点一下即可加入：</span>
                    <span style={{ flex: '1 1 auto' }} />
                    <button
                      type="button"
                      aria-label={`全部添加${availableLabel}`}
                      disabled={Boolean(availableBusy)}
                      onClick={() => void addExtensionCategories(availableChildren.map((row) => row.id), availableLabel)}
                      style={editLinkButton}
                    >
                      {availableBusy === availableLabel ? '添加中…' : `全部添加（${availableChildren.length}）`}
                    </button>
                  </div>
                  <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginTop: 8 }}>
                    {availableChildren.map((row) => {
                      // 同一个分类可能既在包里、也可以单独添加（只想要其中一项时不必开整包）。
                      // 标明归属，避免用户看到两处入口时困惑。
                      const owners = categoryPacksContaining(row.id);
                      const hint = owners.length
                        ? `也能通过「${owners.map((pack) => pack.name).join('、')}」扩展包批量添加`
                        : '来自目录，尚未写入账本';
                      return (
                        <button
                          key={row.id}
                          type="button"
                          aria-label={`添加细分分类 ${row.name}`}
                          title={`${row.id} · ${hint}`}
                          disabled={Boolean(availableBusy)}
                          onClick={() => void addExtensionCategories([row.id], `分类“${row.name}”`)}
                          style={packButton(false)}
                        >
                          {availableBusy === row.id ? '添加中…' : `＋ ${row.name}`}
                        </button>
                      );
                    })}
                  </div>
                </div>
              )}
            </details>
          );
        })}
        {groups.length === 0 && <div style={{ borderTop: '1px solid var(--border)', padding: '22px 8px', color: 'var(--text-tertiary)', fontSize: 'var(--fs-body)' }}>没有匹配的分类，请调整搜索或筛选条件。</div>}
        {visibleOrphanRows.length > 0 && (
          <details open={forceOpen} style={{ borderTop: '1px solid var(--border)' }}>
            <summary className="zc-category-group-summary" style={{ color: 'var(--negative)' }}>父级缺失 · {visibleOrphanRows.length} 项</summary>
            <div style={{ padding: '0 8px 10px' }}>
              {visibleOrphanRows.map((category) => (
                <div key={category.id} style={{ display: 'flex', alignItems: 'center', gap: 10, minHeight: 40, borderTop: '1px solid var(--border)' }}>
                  <span style={{ fontWeight: 'var(--fw-bold)' }}>{category.name}</span>
                  <span style={{ color: 'var(--text-tertiary)', fontSize: 'var(--fs-meta)' }}>{category.id} · 父级 {category.parentId}</span>
                  <span style={{ flex: '1 1 auto' }} />
                  <button type="button" onClick={() => setEditing(category)} style={editLinkButton}>修正</button>
                </div>
              ))}
            </div>
          </details>
        )}
      </div>

      {open && (
        <EntityFormModal
          spec={categoryForm(snap)}
          initial={initial}
          onSave={async (entity) => {
            await store.runInAuditBatch(
              `${initial ? '编辑' : '新增'}分类“${entity.name}”`,
              (transactionStore) => transactionStore.categories.put(entity),
            );
            bump();
          }}
          onClose={() => setEditing(null)}
        />
      )}
      {lifecycle && (
        <MasterDataLifecycleDialog
          store={store}
          kind="category"
          source={{ id: lifecycle.id, label: lifecycle.name, version: lifecycle.version }}
          candidates={categories
            .filter((row) => row.id !== lifecycle.id && row.isActive && row.type === lifecycle.type && !!row.parentId === !!lifecycle.parentId)
            .map((row) => ({ id: row.id, label: row.parentId ? `${categories.find((parent) => parent.id === row.parentId)?.name ?? '父级缺失'} / ${row.name}` : row.name }))}
          onClose={() => setLifecycle(null)}
          onDone={() => { setLifecycle(null); bump(); }}
        />
      )}
    </div>
  );
}

function FixedCategorySection({ snap, store, bump }: {
  snap: Snapshot;
  store: SqlLedgerStore;
  bump: () => void;
}) {
  const compactView = useCompactView();
  const categories = snap.fixedAssetCategories.filter((category) => !category.isDeleted);
  const parents = categories.filter((category) => !category.parentId).sort((a, b) => (a.sortOrder ?? 100) - (b.sortOrder ?? 100));
  const [editing, setEditing] = useState<FixedAssetCategory | 'new' | null>(null);
  const [lifecycle, setLifecycle] = useState<FixedAssetCategory | null>(null);
  const [query, setQuery] = useState('');
  const [visibility, setVisibility] = useState<'all' | 'frequent' | 'hidden' | 'inactive'>('all');
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set());
  const q = norm(query);
  const forceOpen = !!q || visibility !== 'all';
  const visible = (category: FixedAssetCategory, parent: FixedAssetCategory) => {
    if (visibility === 'frequent' && (category.isHidden || !category.isActive)) return false;
    if (visibility === 'hidden' && !category.isHidden) return false;
    if (visibility === 'inactive' && category.isActive) return false;
    return !q || norm(`${parent.name} ${category.name}`).includes(q);
  };
  const groups = parents.map((parent) => {
    const children = categories.filter((category) => category.parentId === parent.id).sort((a, b) => (a.sortOrder ?? 100) - (b.sortOrder ?? 100));
    return { parent, children, shown: children.filter((category) => visible(category, parent)) };
  }).filter((group) => group.shown.length > 0 || (group.children.length === 0 && visible(group.parent, group.parent)));
  const allExpanded = groups.length > 0 && groups.every((group) => expanded.has(group.parent.id));
  /**
   * 展开状态必须先从句柄里读出来再交给 updater：`event.currentTarget` 只在事件分发
   * 期间有效，React 在监听器返回后把它置为 null，而 updater 会在后续渲染阶段才执行，
   * 那时读它就会抛 TypeError（读 null 的 open）并把整页打进错误边界。
   */
  const toggleExpanded = (id: string, nextOpen: boolean) => {
    setExpanded((current) => {
      const next = new Set(current);
      if (nextOpen) next.add(id);
      else next.delete(id);
      return next;
    });
  };
  const toggleHidden = async (category: FixedAssetCategory) => {
    await store.runInAuditBatch(
      `${category.isHidden ? '显示' : '隐藏'}物品分类“${category.name}”`,
      (transactionStore) => transactionStore.fixedAssetCategories.put({ ...category, isHidden: !category.isHidden }),
    );
    bump();
  };
  return (
    <div style={card}>
      <div className="zc-responsive-header" style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 12, marginBottom: 12 }}>
        <div>
          <div style={{ fontSize: 'var(--fs-title)', fontWeight: 'var(--fw-bold)' }}>物品资产分类<span style={{ fontSize: 'var(--fs-caption)', color: 'var(--text-tertiary)', marginLeft: 8 }}>{categories.length}</span></div>
          <div style={{ fontSize: 'var(--fs-meta)', color: 'var(--text-tertiary)', marginTop: 4 }}>一级分类稳定，二级分类可搜索、隐藏和排序；新建物品必须选择二级分类。</div>
        </div>
        <button onClick={() => setEditing('new')} style={{ padding: '8px 14px', border: '1px solid var(--accent)', background: 'var(--accent)', color: 'var(--on-accent)', fontWeight: 'var(--fw-bold)', fontSize: 'var(--fs-body)', cursor: 'pointer' }}>+ 新增物品分类</button>
      </div>
      <div className="zc-manage-toolbar" style={{ display: 'grid', gridTemplateColumns: '1fr 180px auto', gap: 10, marginBottom: 10 }}>
        <input aria-label="搜索物品资产分类" className="zc-input" value={query} onChange={(event) => setQuery(event.target.value)} placeholder="搜索一级或二级分类" />
        <select aria-label="物品分类显示状态" className="zc-select" value={visibility} onChange={(event) => setVisibility(event.target.value as typeof visibility)}>
          <option value="all">全部显示状态</option><option value="frequent">高频</option><option value="hidden">隐藏</option><option value="inactive">停用</option>
        </select>
        <button onClick={() => setExpanded(allExpanded ? new Set() : new Set(groups.map((group) => group.parent.id)))} style={manageFilterButton(allExpanded, true)}>{allExpanded ? '全部收起' : '全部展开'}</button>
      </div>
      <div style={{ borderBottom: '1px solid var(--border)' }}>
        {groups.map(({ parent, children, shown }) => {
          const open = forceOpen || expanded.has(parent.id);
          return (
            <details key={parent.id} open={open} onToggle={(event) => { if (!forceOpen) toggleExpanded(parent.id, event.currentTarget.open); }} style={{ borderTop: '1px solid var(--border)' }}>
              <summary className="zc-category-group-summary">
                <span style={{ width: 10, height: 10, borderRadius: 'var(--r-sm)', background: parent.color ?? 'var(--accent)' }} />
                <b className="zc-category-group-name" title={parent.name}>{parent.name}</b><span style={{ fontSize: 'var(--fs-meta)', color: 'var(--text-tertiary)' }}>{shown.length}/{children.length} 项</span>
                <span className="zc-category-summary-spacer" style={{ flex: 1 }} /><button type="button" onClick={(event) => { event.preventDefault(); event.stopPropagation(); setLifecycle(parent); }} style={editLinkButton}>归档/合并</button><button type="button" onClick={(event) => { event.preventDefault(); event.stopPropagation(); setEditing(parent); }} style={{ ...editLinkButton, marginLeft: 12 }}>编辑一级分类</button>
              </summary>
              {compactView ? <div className="zc-manage-category-list">
                {shown.map((category) => <article className="zc-manage-category-item" key={category.id}>
                  <div className="zc-manage-category-head">
                    <strong>{category.name}</strong>
                    {!category.isActive ? <span style={stateBadge('inactive')}>停用</span> : category.isHidden ? <span style={stateBadge('hidden')}>隐藏</span> : <span style={stateBadge('frequent')}>高频</span>}
                  </div>
                  <details className="zc-manage-category-more">
                    <summary>资料与操作</summary>
                    <div>排序：{category.sortOrder ?? 100}</div>
                    <div className="zc-manage-category-id">分类 ID：{category.id}</div>
                    <div className="zc-manage-category-actions">
                      <button type="button" onClick={() => void toggleHidden(category)}>{category.isHidden ? '设为高频' : '设为隐藏'}</button>
                      <button type="button" onClick={() => setLifecycle(category)}>归档/合并</button>
                      <button type="button" onClick={() => setEditing(category)}>编辑</button>
                    </div>
                  </details>
                </article>)}
                {shown.length === 0 && <div className="zc-meta">没有匹配的二级分类</div>}
              </div> : <div className="zc-scroll-x"><table style={{ width: '100%', borderCollapse: 'collapse' }}>
                <thead><tr><th style={thStyle}>二级分类</th><th style={thStyle}>显示</th><th style={thStyle}>排序</th><th style={{ ...thStyle, textAlign: 'right' }}>操作</th></tr></thead>
                <tbody>
                  {shown.map((category) => <tr key={category.id}>
                    <td style={tdStyle}><b>{category.name}</b><div style={{ fontSize: 'var(--fs-meta)', color: 'var(--text-tertiary)' }}>{category.id}</div></td>
                    <td style={tdStyle}>{!category.isActive ? <span style={stateBadge('inactive')}>停用</span> : category.isHidden ? <span style={stateBadge('hidden')}>隐藏</span> : <span style={stateBadge('frequent')}>高频</span>}</td>
                    <td style={tdStyle}>{category.sortOrder ?? 100}</td>
                    <td style={{ ...tdStyle, textAlign: 'right' }}><button onClick={() => void toggleHidden(category)} style={editLinkButton}>{category.isHidden ? '设为高频' : '设为隐藏'}</button><button onClick={() => setLifecycle(category)} style={{ ...editLinkButton, marginLeft: 12 }}>归档/合并</button><button onClick={() => setEditing(category)} style={{ ...editLinkButton, marginLeft: 12 }}>编辑</button></td>
                  </tr>)}
                  {shown.length === 0 && <tr><td colSpan={4} style={{ ...tdStyle, color: 'var(--text-tertiary)' }}>没有匹配的二级分类</td></tr>}
                </tbody>
              </table></div>}
            </details>
          );
        })}
        {groups.length === 0 && <div style={{ borderTop: '1px solid var(--border)', padding: 20, color: 'var(--text-tertiary)', fontSize: 'var(--fs-caption)' }}>没有匹配的物品分类</div>}
      </div>
      {editing !== null && <EntityFormModal
        spec={fixedAssetCategoryForm(snap)}
        initial={editing === 'new' ? undefined : editing}
        onSave={async (category) => {
          await store.runInAuditBatch(
            `${editing === 'new' ? '新增' : '编辑'}物品分类“${category.name}”`,
            (transactionStore) => transactionStore.fixedAssetCategories.put(category),
          );
          bump();
        }}
        onClose={() => setEditing(null)}
      />}
      {lifecycle && <MasterDataLifecycleDialog
        store={store}
        kind="fixed_category"
        source={{ id: lifecycle.id, label: lifecycle.name, version: lifecycle.version }}
        candidates={categories.filter((row) => row.id !== lifecycle.id && row.isActive && !!row.parentId === !!lifecycle.parentId).map((row) => ({ id: row.id, label: row.parentId ? `${categories.find((parent) => parent.id === row.parentId)?.name ?? '父级缺失'} / ${row.name}` : row.name }))}
        onClose={() => setLifecycle(null)}
        onDone={() => { setLifecycle(null); bump(); }}
      />}
    </div>
  );
}

function MasterDataLifecycleDialog(props: {
  store: SqlLedgerStore;
  kind: MasterDataKind;
  source: { id: string; label: string; version: number };
  candidates: { id: string; label: string }[];
  onClose: () => void;
  onDone: () => void;
}) {
  const undo = useUndo(props.store, props.onDone);
  const [mode, setMode] = useState<'archive' | 'merge'>('archive');
  const [targetId, setTargetId] = useState(props.candidates[0]?.id ?? '');
  const [impact, setImpact] = useState<MasterDataImpact | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  useEffect(() => {
    let active = true;
    setImpact(null);
    setError('');
    void previewMasterDataChange(props.store, props.kind, props.source.id, mode === 'merge' ? targetId : undefined)
      .then((value) => { if (active) setImpact(value); })
      .catch((reason) => { if (active) setError(reason instanceof Error ? reason.message : String(reason)); });
    return () => { active = false; };
  }, [mode, props.kind, props.source.id, props.store, targetId]);
  const confirm = async () => {
    if (!impact || impact.blockedReasons.length || (mode === 'merge' && !targetId)) return;
    setBusy(true);
    setError('');
    try {
      if (mode === 'archive') {
        const compensation = await archiveMasterData(props.store, props.kind, props.source.id, props.source.version);
        undo.offer(`${props.source.label} 已归档`, async () => {
          await restoreArchivedMasterData(props.store, compensation);
          props.onDone();
        });
      } else {
        await mergeMasterData(props.store, props.kind, props.source.id, targetId, props.source.version);
      }
      props.onDone();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setBusy(false);
    }
  };
  return (
    <ConfirmDialog
      title={`归档或合并：${props.source.label}`}
      confirmLabel={mode === 'archive' ? '确认归档' : '确认合并并迁移'}
      cancelLabel="取消"
      tone={mode === 'archive' ? 'danger' : 'normal'}
      busy={busy}
      onCancel={props.onClose}
      onConfirm={confirm}
    >
      <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
        <div style={{ display: 'flex', gap: 8 }}>
          <button type="button" onClick={() => setMode('archive')} style={manageFilterButton(mode === 'archive', true)}>仅归档</button>
          <button type="button" onClick={() => setMode('merge')} style={manageFilterButton(mode === 'merge', props.candidates.length > 0)} disabled={!props.candidates.length}>合并并迁移</button>
        </div>
        {mode === 'merge' && <label>目标记录<select className="zc-select" value={targetId} onChange={(event) => setTargetId(event.target.value)} style={{ marginTop: 5 }}><option value="">请选择目标</option>{props.candidates.map((candidate) => <option key={candidate.id} value={candidate.id}>{candidate.label}</option>)}</select></label>}
        <div style={{ padding: 10, background: 'var(--surface-2)', border: '1px solid var(--border)' }}>
          {impact ? <>
            <b>{mode === 'archive' ? '历史引用全部保留' : `将迁移 ${impact.total} 项引用`}</b>
            {Object.entries(impact.references).filter(([, value]) => value > 0).map(([key, value]) => <div key={key}>{key}: {value}</div>)}
          </> : '正在检查引用…'}
        </div>
        {impact?.blockedReasons.map((reason) => <div key={reason} style={{ color: 'var(--negative)', fontWeight: 'var(--fw-bold)' }}>{reason}</div>)}
        {error && <div style={{ color: 'var(--negative)', fontWeight: 'var(--fw-bold)' }}>{error}</div>}
      </div>
    </ConfirmDialog>
  );
}

function manageFilterButton(active: boolean, enabled: boolean) {
  return {
    padding: '6px 10px',
    borderRadius: 'var(--r-sm)',
    border: '1px solid var(--border)',
    background: active ? 'var(--accent-soft)' : 'var(--surface)',
    color: active ? 'var(--accent)' : 'var(--fg-muted)',
    fontWeight: 'var(--fw-medium)',
    fontSize: 'var(--fs-caption)',
    cursor: enabled ? 'pointer' : 'not-allowed',
    opacity: enabled ? 1 : 0.5,
  } as const;
}

const PACK_MEMBER_LABEL: Record<CategoryPackMemberState, string> = {
  enabled: '可用',
  hidden: '已隐藏',
  disabled: '已停用',
  missing: '未加入',
};

function packStatusLabel(state: CategoryPackState): string {
  if (state.status === 'enabled') return `${state.total} 项全部可用`;
  if (state.status === 'partial') return `已启用 ${state.enabledCount}/${state.total}`;
  return `未启用 · 可选 ${state.total} 项`;
}

const packHeaderButton = {
  display: 'flex',
  alignItems: 'baseline',
  gap: 8,
  width: '100%',
  padding: 0,
  border: 'none',
  background: 'transparent',
  color: 'inherit',
  textAlign: 'left',
  cursor: 'pointer',
} as const;

const packMemberButton = {
  minHeight: 24,
  padding: '1px 7px',
  borderRadius: 'var(--r-sm)',
  border: '1px solid var(--border)',
  background: 'var(--surface)',
  color: 'var(--fg-muted)',
  fontSize: 'var(--fs-meta)',
  cursor: 'pointer',
} as const;

function packButton(primary: boolean) {
  return {
    minHeight: 32,
    padding: '5px 9px',
    borderRadius: 'var(--r-sm)',
    border: `1px solid ${primary ? 'var(--accent)' : 'var(--border)'}`,
    background: primary ? 'var(--accent)' : 'var(--surface)',
    color: primary ? 'var(--on-accent)' : 'var(--fg-muted)',
    fontSize: 'var(--fs-meta)',
    fontWeight: 'var(--fw-bold)',
    cursor: 'pointer',
  } as const;
}

const editLinkButton = {
  border: 'none',
  background: 'transparent',
  color: 'var(--accent)',
  padding: 0,
  fontSize: 'var(--fs-caption)',
  fontWeight: 'var(--fw-medium)',
  cursor: 'pointer',
} as const;

function typeBadge(type: Category['type']) {
  return {
    borderRadius: 'var(--r-pill)',
    padding: '2px 7px',
    color: type === 'income' ? 'var(--positive)' : 'var(--negative)',
    background: type === 'income' ? 'rgba(63,143,107,.13)' : 'rgba(194,96,74,.13)',
    fontSize: 'var(--fs-meta)',
    fontWeight: 'var(--fw-medium)',
  } as const;
}

function stateBadge(kind: 'frequent' | 'hidden' | 'inactive' | 'duplicate' | 'available') {
  const colors = kind === 'frequent'
    ? { color: 'var(--positive)', background: 'rgba(63,143,107,.13)' }
    : kind === 'duplicate'
      ? { color: 'var(--negative)', background: 'rgba(194,96,74,.13)' }
      : kind === 'available'
        ? { color: 'var(--accent)', background: 'var(--accent-soft)' }
        : { color: 'var(--text-tertiary)', background: 'var(--surface-2)' };
  return {
    border: '1px solid var(--border)',
    borderRadius: 'var(--r-pill)',
    padding: '2px 7px',
    ...colors,
    fontSize: 'var(--fs-meta)',
    fontWeight: 'var(--fw-medium)',
    whiteSpace: 'nowrap',
  } as const;
}

function Section<T extends { id: string; version: number }>(props: {
  title: string;
  headers: string[];
  items: T[];
  row: (t: T) => ReactNode[];
  itemLabel?: (t: T) => string;
  searchText?: (t: T) => string;
  dateOf?: (t: T) => string;
  duplicateKey?: (t: T) => string | undefined;
  onAdd?: () => void;
  onEdit?: (item: T) => void;
  makeSpec: () => EntityFormSpec<T>;
  put: (store: SqlLedgerStore, entity: T) => Promise<unknown>;
  bump: () => void;
  masterKind?: MasterDataKind;
  lifecycleCandidates?: { id: string; label: string }[];
}) {
  const compactView = useCompactView();
  const { store } = useStore();
  const { title, headers, items, row, dateOf, duplicateKey, makeSpec, put, bump, masterKind, lifecycleCandidates = [] } = props;
  const [editing, setEditing] = useState<T | 'new' | null>(null);
  const [lifecycle, setLifecycle] = useState<T | null>(null);
  const [query, setQuery] = useState('');
  const [showDuplicates, setShowDuplicates] = useState(false);
  const [dateRange, setDateRange] = useState(() => dateRangeValue('all'));
  const open = editing !== null;
  const initial = editing === 'new' ? undefined : (editing ?? undefined);
  const spec = makeSpec();
  const duplicateKeys = new Map<string, number>();
  for (const item of items) {
    const key = duplicateKey?.(item) ?? norm(row(item)[0]);
    if (key) duplicateKeys.set(key, (duplicateKeys.get(key) ?? 0) + 1);
  }
  const duplicateCount = [...duplicateKeys.values()].filter((count) => count > 1).length;
  const filteredByQuery = (query.trim()
    ? items.filter((item) => (props.searchText?.(item) ?? row(item).filter((cell) => typeof cell === 'string' || typeof cell === 'number').join(' ')).toLowerCase().includes(query.trim().toLowerCase()))
    : items).filter((item) => !dateOf || isDateInRange(dateOf(item), dateRange));
  const filteredItems = showDuplicates
    ? filteredByQuery.filter((item) => duplicateKeys.get(duplicateKey?.(item) ?? norm(row(item)[0]))! > 1)
    : filteredByQuery;

  return (
    <div style={card}>
      <div className="zc-manage-toolbar" style={{ display: 'grid', gridTemplateColumns: '1fr minmax(180px, 280px) auto auto', alignItems: 'center', gap: 10, marginBottom: 12 }}>
        <div>
          <div style={{ fontSize: 'var(--fs-title)', fontWeight: 'var(--fw-bold)' }}>{title}<span style={{ fontSize: 'var(--fs-caption)', color: 'var(--text-tertiary)', marginLeft: 8, fontWeight: 'var(--fw-medium)' }}>{items.length}</span></div>
          {duplicateCount > 0 && <div style={{ fontSize: 'var(--fs-meta)', color: 'var(--negative)', marginTop: 3 }}>发现 {duplicateCount} 组可能重复记录，可筛出后编辑合并或停用。</div>}
        </div>
        <input aria-label={`搜索${title}`} className="zc-input" value={query} onChange={(e) => setQuery(e.target.value)} placeholder={`搜索${title}`} />
        <button
          onClick={() => setShowDuplicates((v) => !v)}
          disabled={duplicateCount === 0}
          style={{ padding: '7px 12px', borderRadius: 'var(--r-sm)', border: '1px solid var(--border)', background: showDuplicates ? 'var(--accent-soft)' : 'var(--surface)', color: showDuplicates ? 'var(--accent)' : 'var(--fg-muted)', fontWeight: 'var(--fw-bold)', fontSize: 'var(--fs-body)', cursor: duplicateCount ? 'pointer' : 'not-allowed', whiteSpace: 'nowrap', opacity: duplicateCount ? 1 : 0.5 }}
        >
          {showDuplicates ? '显示全部' : '只看重复'}
        </button>
        <button onClick={() => props.onAdd ? props.onAdd() : setEditing('new')} style={{ padding: '7px 14px', borderRadius: 'var(--r-sm)', border: '1px solid var(--accent)', background: 'var(--accent)', color: 'var(--on-accent)', fontWeight: 'var(--fw-bold)', fontSize: 'var(--fs-body)', cursor: 'pointer', whiteSpace: 'nowrap' }}>+ 新增{title}</button>
      </div>
      {dateOf && <div style={{ marginBottom: 12 }}><DateRangeBar value={dateRange} onChange={setDateRange} compact /></div>}
      {compactView ? <div className="zc-manage-mobile-list">
        {filteredItems.map((item) => {
          const cells = row(item);
          const edit = () => props.onEdit ? props.onEdit(item) : setEditing(item);
          const label = props.itemLabel?.(item) ?? (typeof cells[0] === 'string' ? cells[0] : item.id);
          return <article className="zc-manage-mobile-item" key={item.id}>
            <button type="button" className="zc-manage-mobile-main" aria-label={`编辑${title} ${label}`} onClick={edit}>
              <span>{cells[0]}</span>
              {cells.length > 1 && <small>{cells[1]}</small>}
            </button>
            {(cells.length > 2 || masterKind) && <details>
              <summary>更多资料与操作</summary>
              {cells.slice(2).map((cell, index) => <div className="zc-manage-mobile-fact" key={headers[index + 2] ?? index}><span>{headers[index + 2]}</span><span>{cell}</span></div>)}
              {masterKind && <button type="button" className="zc-btn zc-btn--outline" onClick={() => setLifecycle(item)}>归档/合并</button>}
            </details>}
          </article>;
        })}
        {filteredItems.length === 0 && <div className="zc-meta">{items.length === 0 ? '暂无数据' : '没有匹配的记录'}</div>}
      </div> : <div style={{ overflowX: 'auto' }}>
        <table style={{ width: '100%', borderCollapse: 'collapse' }}>
          <thead><tr>{headers.map((h) => <th key={h} style={thStyle}>{h}</th>)}<th style={thStyle}></th></tr></thead>
          <tbody>
            {filteredItems.map((t) => (
              <tr key={t.id} onClick={() => props.onEdit ? props.onEdit(t) : setEditing(t)} style={{ cursor: 'pointer' }}>
                {row(t).map((c, i) => <td key={i} style={tdStyle}>{c}</td>)}
                <td style={{ ...tdStyle, textAlign: 'right', color: 'var(--text-tertiary)', whiteSpace: 'nowrap' }}>
                  {masterKind && <button type="button" onClick={(event) => { event.stopPropagation(); setLifecycle(t); }} style={{ ...editLinkButton, marginRight: 12 }}>归档/合并</button>}
                  <button type="button" aria-label={`编辑${title} ${props.itemLabel?.(t) ?? (typeof row(t)[0] === 'string' ? row(t)[0] : t.id)}`} onClick={(event) => { event.stopPropagation(); if (props.onEdit) props.onEdit(t); else setEditing(t); }} style={editLinkButton}>编辑</button>
                </td>
              </tr>
            ))}
            {filteredItems.length === 0 && <tr><td style={{ ...tdStyle, color: 'var(--text-tertiary)' }} colSpan={headers.length + 1}>{items.length === 0 ? '暂无数据' : '没有匹配的记录'}</td></tr>}
          </tbody>
        </table>
      </div>}
      {open && (
        <EntityFormModal
          spec={spec}
          initial={initial}
          onSave={async (e) => {
            const key = duplicateKey?.(e) ?? norm(row(e)[0]);
            const duplicate = key && items.some((item) => item.id !== e.id && (duplicateKey?.(item) ?? norm(row(item)[0])) === key);
            if (duplicate && !spec.identityKind) throw new Error(`已存在相同的${title}，请修改名称或关联信息`);
            await store.runInAuditBatch(
              `${initial ? '编辑' : '新增'}${title}`,
              (transactionStore) => put(transactionStore, e),
            );
            bump();
          }}
          onClose={() => setEditing(null)}
        />
      )}
      {masterKind && lifecycle && <MasterDataLifecycleDialog
        store={store}
        kind={masterKind}
        source={{ id: lifecycle.id, label: props.itemLabel?.(lifecycle) ?? String(row(lifecycle)[0] ?? lifecycle.id), version: lifecycle.version }}
        candidates={lifecycleCandidates.filter((candidate) => candidate.id !== lifecycle.id)}
        onClose={() => setLifecycle(null)}
        onDone={() => { setLifecycle(null); bump(); }}
      />}
    </div>
  );
}

function AttachmentSection({ items, preview, onDelete }: { items: Attachment[]; preview: boolean; onDelete: (attachment: Attachment) => Promise<void> }) {
  const { store, downloadPreviewAttachment } = useStore();
  const [query, setQuery] = useState('');
  const [deleting, setDeleting] = useState<Attachment | null>(null);
  const [localStates, setLocalStates] = useState<Record<string, 'ready' | 'trash' | 'missing'>>({});
  const [replicas, setReplicas] = useState<AttachmentReplicaBlobRow[]>([]);
  const [fetching, setFetching] = useState('');
  const [message, setMessage] = useState('');
  // Both columns below describe *this device*: which blobs it has downloaded, and which sync
  // profiles it has saved. In a preview neither belongs to the user whose ledger is on screen,
  // and "按需下载 / 尚未同步" would read as a statement about their data. The preview shows the
  // metadata it actually has — which is what the server handed over.
  const profileNames = preview ? {} : Object.fromEntries(loadSyncConnections().map((profile) => [profile.id, profile.alias]));
  const refreshStates = useCallback(async () => {
    if (preview) return;
    const entries = await Promise.all(items.map(async (attachment) => [attachment.sha256, await attachmentStorageStatus(attachment.sha256)] as const));
    setLocalStates(Object.fromEntries(entries));
    setReplicas(await store.attachmentState.listReplicaBlobs());
  }, [items, store, preview]);
  useEffect(() => {
    if (preview) return;
    let active = true;
    const refresh = () => void refreshStates().catch(() => undefined);
    void (async () => {
      const entries = await Promise.all(items.map(async (attachment) => [attachment.sha256, await attachmentStorageStatus(attachment.sha256)] as const));
      const nextReplicas = await store.attachmentState.listReplicaBlobs();
      if (active) {
        setLocalStates(Object.fromEntries(entries));
        setReplicas(nextReplicas);
      }
    })();
    window.addEventListener(ATTACHMENT_SYNC_STATE_EVENT, refresh);
    return () => {
      active = false;
      window.removeEventListener(ATTACHMENT_SYNC_STATE_EVENT, refresh);
    };
  }, [items, refreshStates, store, preview]);
  const fetchBody = async (attachment: Attachment) => {
    setFetching(attachment.id);
    setMessage('');
    try {
      if (preview) {
        // A preview has no local attachment store and no sync profile of its own: the only way to
        // the bytes is the server decrypting them, which is what this route does.
        if (!downloadPreviewAttachment) throw new Error('当前预览不支持下载附件');
        const file = await downloadPreviewAttachment(attachment.sha256);
        const url = URL.createObjectURL(file.blob);
        try {
          const anchor = document.createElement('a');
          anchor.href = url;
          anchor.download = file.fileName || attachment.fileName;
          document.body.appendChild(anchor);
          anchor.click();
          anchor.remove();
        } finally {
          URL.revokeObjectURL(url);
        }
        setMessage(`已下载 ${file.fileName || attachment.fileName}`);
        return;
      }
      await ensureAttachmentBlobAvailable(store, {
        sha256: attachment.sha256,
        sizeBytes: attachment.sizeBytes,
        mimeType: attachment.mimeType || 'application/octet-stream',
      });
      await refreshStates();
      setMessage(`已取回 ${attachment.fileName}`);
    } catch (error) {
      setMessage(`取回失败：${error instanceof Error ? error.message : String(error)}`);
    } finally {
      setFetching('');
    }
  };
  const q = norm(query);
  const visible = q
    ? items.filter((item) => `${item.fileName} ${item.entityType} ${item.entityId} ${item.mimeType ?? ''} ${item.sha256}`.toLowerCase().includes(q))
    : items;
  return (
    <div style={card}>
      <div className="zc-manage-toolbar" style={{ display: 'grid', gridTemplateColumns: '1fr minmax(180px, 280px)', alignItems: 'center', gap: 10, marginBottom: 12 }}>
        <div>
          <div style={{ fontSize: 'var(--fs-title)', fontWeight: 'var(--fw-bold)' }}>附件<span style={{ fontSize: 'var(--fs-caption)', color: 'var(--text-tertiary)', marginLeft: 8, fontWeight: 'var(--fw-medium)' }}>{items.length}</span></div>
          <div style={{ fontSize: 'var(--fs-meta)', color: 'var(--text-tertiary)', marginTop: 3 }}>正文保存在平台文件存储中，此处只管理元数据。</div>
        </div>
        <input aria-label="搜索附件" className="zc-input" value={query} onChange={(event) => setQuery(event.target.value)} placeholder="搜索文件、关联对象或校验和" />
      </div>
      {message && <div style={{ marginBottom: 10, fontSize: 'var(--fs-caption)', fontWeight: 'var(--fw-medium)', color: message.startsWith('取回失败') ? 'var(--negative)' : 'var(--positive)' }}>{message}</div>}
      <div className="zc-scroll-x">
        <table style={{ width: '100%', borderCollapse: 'collapse' }}>
          <thead><tr><th style={thStyle}>文件</th><th style={thStyle}>关联</th><th style={thStyle}>大小</th><th style={thStyle}>本机</th><th style={thStyle}>服务器副本</th><th style={thStyle}>SHA-256</th><th style={thStyle}></th></tr></thead>
          <tbody>
            {visible.map((attachment) => {
              const local = localStates[attachment.sha256] ?? 'missing';
              const remote = replicas.filter((row) => row.sha256 === attachment.sha256);
              return <tr key={attachment.id}>
                <td style={tdStyle}><b>{attachment.fileName}</b><div style={{ fontSize: 'var(--fs-meta)', color: 'var(--text-tertiary)', marginTop: 3 }}>{attachment.mimeType ?? '未知类型'} · 内容寻址对象</div></td>
                <td style={tdStyle}>{attachment.entityType} · {attachment.entityId.slice(0, 8)}</td>
                <td style={tdStyle}>{attachment.sizeBytes > 1024 * 1024 ? `${(attachment.sizeBytes / 1024 / 1024).toFixed(1)} MB` : `${Math.max(1, Math.round(attachment.sizeBytes / 1024))} KB`}</td>
                <td style={{ ...tdStyle, color: preview ? 'var(--text-tertiary)' : local === 'ready' ? 'var(--positive)' : local === 'trash' ? 'var(--accent)' : 'var(--negative)', fontWeight: 'var(--fw-bold)' }}>{preview ? '预览不适用' : local === 'ready' ? '可用' : local === 'trash' ? '回收区' : '按需下载'}</td>
                <td style={{ ...tdStyle, fontSize: 'var(--fs-meta)', color: 'var(--text-secondary)', maxWidth: 220 }}>
                  {preview ? '预览不显示同步状态' : remote.length ? remote.map((row) => `${profileNames[row.profileId] ?? row.profileId.slice(0, 8)}：${replicaStateLabel(row.state)}`).join(' · ') : '尚未同步'}
                </td>
                <td style={{ ...tdStyle, fontFamily: 'monospace', fontSize: 'var(--fs-meta)' }}>{attachment.sha256.slice(0, 16)}...</td>
                <td style={{ ...tdStyle, textAlign: 'right', whiteSpace: 'nowrap' }}>
                  {/* Fetching a body normally downloads it into this device's attachment store.
                      A preview cannot do that — the body is the user's, and only the server can
                      decrypt it — so there it downloads the decrypted file instead. Deleting edits
                      the ledger, which a preview never does. */}
                  {local !== 'ready' && <button type="button" disabled={fetching === attachment.id} onClick={() => void fetchBody(attachment)} style={{ border: '1px solid var(--border)', background: 'transparent', color: 'var(--text-secondary)', minHeight: 34, padding: '6px 10px', cursor: 'pointer', marginRight: 6 }}>{fetching === attachment.id ? (preview ? '下载中…' : '取回中…') : (preview ? '下载' : '取回正文')}</button>}
                  {preview ? null : <button type="button" onClick={() => setDeleting(attachment)} style={{ border: '1px solid var(--negative)', background: 'transparent', color: 'var(--negative)', minHeight: 34, padding: '6px 10px', cursor: 'pointer' }}>删除</button>}
                </td>
              </tr>
            })}
            {visible.length === 0 && <tr><td style={{ ...tdStyle, color: 'var(--text-tertiary)' }} colSpan={7}>没有匹配的附件</td></tr>}
          </tbody>
        </table>
      </div>
      {deleting && (
        <ConfirmDialog title="删除附件" confirmLabel="删除" cancelLabel="取消" tone="danger" onCancel={() => setDeleting(null)} onConfirm={async () => { await onDelete(deleting); setDeleting(null); }}>
          将同时删除文件正文和缩略图，且操作会写入历史。确定删除“{deleting.fileName}”？
        </ConfirmDialog>
      )}
    </div>
  );
}

function replicaStateLabel(state: AttachmentReplicaBlobRow['state']): string {
  const labels: Record<AttachmentReplicaBlobRow['state'], string> = {
    missing: '缺失',
    queued: '待上传',
    uploading: '上传中',
    available: '可用',
    downloading: '下载中',
    deleting: '删除中',
    trash: '回收区',
    error: '失败',
  };
  return labels[state];
}
