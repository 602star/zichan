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
import { QuickCategorySettings } from '../ui/QuickCategorySettings.js';
import { DateRangeBar, dateRangeValue } from '../ui/DateRangeBar.js';
import { allCategories, CATEGORY_PACKS, categoryIsHidden, categoryLabel, TYPE_LABEL } from '../transactionMeta.js';
import { ConfirmDialog } from '../ui/ConfirmDialog.js';
import { attachmentStorageStatus, reconcileAttachmentStorage } from '../db/attachment-storage.js';
import { ATTACHMENT_SYNC_STATE_EVENT, ensureAttachmentBlobAvailable } from '../attachment-sync.js';
import { loadSyncConnections } from '../sync-config.js';
import { useUndo } from '../ui/UndoToast.js';

const ASSET_TYPE_LABEL: Record<string, string> = {
  fiat: '法币', stablecoin: '稳定币', crypto: '加密货币', stock: '股票', fund: '基金 / ETF',
  bond: '债券 / 固收', precious_metal: '贵金属', game: '游戏货币', fixed: '物品资产',
};
const KIND_LABEL: Record<string, string> = {
  bank: '银行', cash: '现金', exchange: '交易所', wallet: '钱包', credit_card: '信用卡',
  loan: '贷款', game_platform: '游戏平台', other: '其他',
};
const norm = (value: unknown) => String(value ?? '').trim().toLowerCase();

type ManageTab = 'transactionCategories' | 'fixedCategories' | 'labels' | 'other';
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
  const { store, bump } = useStore();
  const snap = useSnapshot('manage');
  const [initialTarget] = useState(readManageTarget);
  const [tab, setTab] = useState<ManageTab>(initialTarget.tab ?? 'transactionCategories');
  const [categoryMode, setCategoryMode] = useState<CategoryCenterMode>(initialTarget.categoryMode ?? 'structure');
  const [categoryPackBusy, setCategoryPackBusy] = useState('');
  const [categoryPackNotice, setCategoryPackNotice] = useState('');
  const [categoryPackError, setCategoryPackError] = useState('');
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
  const usesAccounts = (snap.setting?.ledgerMode ?? 'spending') !== 'spending';

  async function saveCategoryPreferences(updates: Category[]) {
    await store.runInAuditBatch('调整快速记账分类', async (transactionStore) => {
      for (const category of updates) {
        const { catalogOnly: _catalogOnly, ...persisted } = category as Category & { catalogOnly?: boolean };
        await transactionStore.categories.put(persisted);
      }
    }, 'bulk_update');
    bump();
  }

  async function enableCategoryPack(packId: string, categoryIds: readonly string[]) {
    setCategoryPackBusy(packId);
    setCategoryPackNotice('');
    setCategoryPackError('');
    try {
      await enableSystemCategories(store, categoryIds);
      bump();
      setCategoryPackNotice(`已启用 ${categoryIds.length} 个分类；现在可在新增记账中选择。`);
    } catch (error) {
      setCategoryPackError(error instanceof Error ? error.message : String(error));
    } finally {
      setCategoryPackBusy('');
    }
  }

  async function disableCategoryPack(packId: string, categoryIds: readonly string[]) {
    setCategoryPackBusy(packId);
    setCategoryPackNotice('');
    setCategoryPackError('');
    try {
      const result = await disableSystemCategories(store, categoryIds);
      bump();
      setCategoryPackNotice(
        `已停用 ${result.disabledIds.length} 个分类；新增记账将不再显示`
        + (result.retainedUsedIds.length ? `；其中 ${result.retainedUsedIds.length} 个分类仍保留历史引用` : ''),
      );
    } catch (error) {
      setCategoryPackError(error instanceof Error ? error.message : String(error));
    } finally {
      setCategoryPackBusy('');
    }
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 22 }}>
      <div>
        <div style={{ fontSize: 'var(--fs-heading)', fontWeight: 'var(--fw-bold)' }}>分类与资料中心</div>
        <div style={{ color: 'var(--text-tertiary)', fontSize: 'var(--fs-caption)', marginTop: 4 }}>分类的结构、快速显示和排序统一在这里维护。</div>
      </div>

      <div role="tablist" aria-label="分类与资料中心" style={{ display: 'flex', gap: 4, borderBottom: '1px solid var(--border)', overflowX: 'auto' }}>
        {([
          ['transactionCategories', '收支分类'],
          ['fixedCategories', '物品分类'],
          ['labels', '标签与商户'],
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
                  <div style={{ fontSize: 'var(--fs-title)', fontWeight: 'var(--fw-bold)' }}>按需分类包</div>
                  <div style={{ marginTop: 4, color: 'var(--text-tertiary)', fontSize: 'var(--fs-caption)' }}>
                    启用后分类会出现在新增记账中；停用后不再可选，但不会删除历史分类或改动已有流水。
                  </div>
                  <div style={{ marginTop: 12, display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(230px, 1fr))', gap: 8 }}>
                    {CATEGORY_PACKS.map((pack) => {
                      const enabled = pack.categoryIds.filter((id) =>
                        snap.categories.some((category) => category.id === id && !category.isDeleted && category.isActive),
                      ).length;
                      const busy = categoryPackBusy === pack.id;
                      return (
                        <div key={pack.id} data-testid={`category-pack-${pack.id}`} style={{ border: '1px solid var(--border)', borderRadius: 'var(--r-sm)', padding: 11, display: 'grid', gap: 8 }}>
                          <div style={{ display: 'flex', alignItems: 'baseline', gap: 8 }}>
                            <b style={{ fontSize: 'var(--fs-body)' }}>{pack.name}</b>
                            <span style={{ marginLeft: 'auto', fontSize: 'var(--fs-meta)', color: 'var(--text-tertiary)' }}>已启用 {enabled}/{pack.categoryIds.length}</span>
                          </div>
                          <div style={{ color: 'var(--text-secondary)', fontSize: 'var(--fs-meta)', minHeight: 30 }}>{pack.description}</div>
                          <div style={{ display: 'flex', gap: 7 }}>
                            <button type="button" aria-label={`启用${pack.name}分类包`} disabled={busy || enabled === pack.categoryIds.length} onClick={() => void enableCategoryPack(pack.id, pack.categoryIds)} style={packButton(true)}>
                              {busy ? '处理中…' : enabled === pack.categoryIds.length ? '已启用' : enabled > 0 ? '补齐并启用' : '启用'}
                            </button>
                            <button type="button" aria-label={`停用${pack.name}分类包`} disabled={busy || enabled === 0} onClick={() => void disableCategoryPack(pack.id, pack.categoryIds)} style={packButton(false)}>
                              停用
                            </button>
                          </div>
                        </div>
                      );
                    })}
                  </div>
                  {categoryPackNotice && <div style={{ marginTop: 10, color: 'var(--positive)', fontSize: 'var(--fs-caption)', fontWeight: 'var(--fw-bold)' }}>{categoryPackNotice}</div>}
                  {categoryPackError && <div role="alert" style={{ marginTop: 10, color: 'var(--negative)', fontSize: 'var(--fs-caption)', fontWeight: 'var(--fw-bold)' }}>分类包操作失败：{categoryPackError}</div>}
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
          <Section
            title="商户" headers={usesAccounts ? ['名称', '默认分类', '默认账户', '别名'] : ['名称', '默认分类', '别名']}
            items={snap.payees}
            row={(p) => usesAccounts
              ? [p.name, p.defaultCategory ? categoryLabel(p.defaultCategory, snap.categories) : '—', p.defaultAccountId ? snap.accounts.find((a) => a.id === p.defaultAccountId)?.name ?? p.defaultAccountId : '—', p.aliases?.join(' / ') ?? '—']
              : [p.name, p.defaultCategory ? categoryLabel(p.defaultCategory, snap.categories) : '—', p.aliases?.join(' / ') ?? '—']}
            duplicateKey={(p) => norm(p.name)}
            makeSpec={() => payeeForm(snap)}
            put={(transactionStore, entity) => transactionStore.payees.put(entity)}
            bump={bump} masterKind="payee"
            lifecycleCandidates={snap.payees.filter((row) => row.isActive).map((row) => ({ id: row.id, label: row.name }))}
          />
        </>
      )}

      {tab === 'other' && (
        <>
          <Section
            title="资产" headers={['代码', '名称', '类型', '精度']}
            items={snap.assets}
            row={(a) => [a.code, a.name, ASSET_TYPE_LABEL[a.type] ?? a.type, String(a.decimals)]}
            duplicateKey={(a) => norm(a.code)}
            makeSpec={() => assetForm()}
            put={(transactionStore, entity) => transactionStore.assets.put(entity)}
            bump={bump} masterKind="asset"
            lifecycleCandidates={snap.assets.filter((row) => row.isActive).map((row) => ({ id: row.id, label: `${row.code} · ${row.name}` }))}
          />
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
              makeSpec={() => accountForm()}
              put={(transactionStore, entity) => transactionStore.accounts.put(entity)}
              bump={bump} masterKind="account"
              lifecycleCandidates={snap.accounts.filter((row) => row.isActive !== false).map((row) => ({ id: row.id, label: row.name }))}
            />
          )}
          <Section title="交易模板" headers={['名称', '类型', '分类', '金额']} items={snap.transactionTemplates} row={(t) => [t.name, TYPE_LABEL[t.type], categoryLabel(t.category, snap.categories), t.amount ?? '—']} duplicateKey={(t) => norm(t.name)} makeSpec={() => transactionTemplateForm(snap, { usesAccounts })} put={(transactionStore, entity) => transactionStore.transactionTemplates.put(entity)} bump={bump} />
          <Section title="价格与折算率" headers={['资产', '每单位价格', '计价币种', '日期']} items={snap.priceMarks} row={(m) => [codeOf(m.assetId), m.price, codeOf(m.quoteAssetId), m.date]} dateOf={(m) => m.date} duplicateKey={(m) => `${m.assetId}:${m.quoteAssetId}:${m.date}`} makeSpec={() => priceMarkForm(snap)} put={(transactionStore, entity) => transactionStore.priceMarks.put(entity)} bump={bump} />
          <Section title="定投计划" headers={['名称', '目标', '金额', '频率', '状态']} items={snap.dcaPlans} row={(p) => [p.name, codeOf(p.targetAssetId), `${p.plannedAmount} ${codeOf(p.baseCurrencyAssetId)}`, p.frequency, p.status]} duplicateKey={(p) => norm(p.name)} makeSpec={() => dcaPlanForm(snap)} put={(transactionStore, entity) => transactionStore.dcaPlans.put(entity)} bump={bump} />
          <Section title="分类预算" headers={['月份', '分类', '预算', '币种', '结转']} items={snap.budgetCategories} row={(b) => [b.month, categoryLabel(b.category, snap.categories), b.plannedAmount, codeOf(b.assetId), b.rolloverMode === 'none' ? '不结转' : b.rolloverMode === 'positive_only' ? '仅结余' : '含超支']} duplicateKey={(b) => `${b.month}:${b.category}`} makeSpec={() => budgetCategoryForm(snap)} put={(transactionStore, entity) => transactionStore.budgetCategories.put(entity)} bump={bump} />
          <Section title="定期交易" headers={['名称', '类型', '金额', '下次日期', '状态']} items={snap.scheduledTransactions} row={(s) => [s.name, TYPE_LABEL[s.type], `${s.amount} ${codeOf(s.assetId)}`, nextUnhandledScheduleOccurrence(s, snap.scheduledExecutions)?.date ?? '已结束', s.status]} duplicateKey={(s) => norm(s.name)} makeSpec={() => scheduledTransactionForm(snap)} put={(transactionStore, entity) => transactionStore.scheduledTransactions.put(entity)} bump={bump} />
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
            duplicateKey={(a) => `${a.gameId}:${norm(a.accountName)}`}
            makeSpec={() => gameAccountForm(snap)} put={(transactionStore, entity) => transactionStore.gameAccounts.put(entity)} bump={bump} masterKind="game_account"
            lifecycleCandidates={snap.gameAccounts.filter((row) => row.status === 'active').map((row) => ({ id: row.id, label: `${gameName(row.gameId)} / ${row.accountName}` }))}
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
  const categories = allCategories(snap.categories, { includeInactive: true });
  const parents = categories.filter((category) => !category.parentId);
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

  const groups = parents.map((parent) => {
    const children = categories.filter((category) => category.parentId === parent.id);
    const visibleChildren = children.filter((category) => categoryMatches(category, parent));
    const parentMatches = categoryMatches(parent, parent);
    return { parent, children, visibleChildren, parentMatches };
  }).filter(({ parent, children, visibleChildren, parentMatches }) => (
    (typeFilter === 'all' || parent.type === typeFilter)
    && (parentFilter === 'all' || parent.id === parentFilter)
    && (visibleChildren.length > 0 || (children.length === 0 && parentMatches))
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
        <button onClick={() => setEditing('new')} style={{ padding: '8px 14px', borderRadius: 'var(--r-sm)', border: '1px solid var(--accent)', background: 'var(--accent)', color: '#fff', fontWeight: 'var(--fw-bold)', fontSize: 'var(--fs-body)', cursor: 'pointer', whiteSpace: 'nowrap' }}>+ 新增分类</button>
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

      <div style={{ borderBottom: '1px solid var(--border)' }}>
        {groups.map(({ parent, children, visibleChildren }) => {
          const hiddenCount = children.filter(categoryIsHidden).length;
          const inactiveCount = children.filter((category) => category.isActive === false).length;
          const isOpen = forceOpen || expandedParents.has(parent.id);
          return (
            <details
              key={parent.id}
              open={isOpen}
              onToggle={(event) => { if (!forceOpen) toggleExpanded(parent.id, event.currentTarget.open); }}
              style={{ borderTop: '1px solid var(--border)' }}
            >
              <summary className="zc-category-group-summary">
                <span style={{ width: 10, height: 10, borderRadius: 'var(--r-sm)', background: parent.color ?? 'var(--fg-subtle)', flex: '0 0 auto' }} />
                <span style={{ fontWeight: 'var(--fw-bold)', color: 'var(--text-primary)' }}>{parent.name}</span>
                <span style={typeBadge(parent.type)}>{parent.type === 'income' ? '收入' : '支出'}</span>
                <span style={{ fontSize: 'var(--fs-meta)', color: 'var(--text-tertiary)' }}>{visibleChildren.length}/{children.length} 项</span>
                {hiddenCount > 0 && <span style={stateBadge('hidden')}>隐藏 {hiddenCount}</span>}
                {inactiveCount > 0 && <span style={stateBadge('inactive')}>停用 {inactiveCount}</span>}
                <span style={{ flex: '1 1 auto' }} />
                <button type="button" onClick={(event) => { event.preventDefault(); event.stopPropagation(); setLifecycle(parent); }} style={editLinkButton}>归档/合并</button>
                <button type="button" onClick={(event) => { event.preventDefault(); event.stopPropagation(); setEditing(parent); }} style={{ ...editLinkButton, marginLeft: 12 }}>编辑一级分类</button>
              </summary>
              <div style={{ overflowX: 'auto' }}>
                <table style={{ width: '100%', borderCollapse: 'collapse' }}>
                  <thead><tr><th style={thStyle}>二级分类</th><th style={thStyle}>显示状态</th><th style={thStyle}>预算</th><th style={thStyle}>排序</th><th style={{ ...thStyle, textAlign: 'right' }}>操作</th></tr></thead>
                  <tbody>
                    {visibleChildren.map((category) => (
                      <tr key={category.id}>
                        <td style={tdStyle}>
                          <span style={{ display: 'inline-flex', alignItems: 'center', gap: 8 }}>
                            <span style={{ width: 9, height: 9, borderRadius: 'var(--r-sm)', background: category.color ?? parent.color ?? 'var(--fg-subtle)' }} />
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
                    {visibleChildren.length === 0 && <tr><td style={{ ...tdStyle, color: 'var(--text-tertiary)' }} colSpan={5}>该一级分类下没有匹配的二级分类</td></tr>}
                  </tbody>
                </table>
              </div>
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
        <button onClick={() => setEditing('new')} style={{ padding: '8px 14px', border: '1px solid var(--accent)', background: 'var(--accent)', color: '#fff', fontWeight: 'var(--fw-bold)', fontSize: 'var(--fs-body)', cursor: 'pointer' }}>+ 新增物品分类</button>
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
            <details key={parent.id} open={open} onToggle={(event) => {
              if (forceOpen) return;
              setExpanded((current) => {
                const next = new Set(current);
                if (event.currentTarget.open) next.add(parent.id); else next.delete(parent.id);
                return next;
              });
            }} style={{ borderTop: '1px solid var(--border)' }}>
              <summary className="zc-category-group-summary">
                <span style={{ width: 10, height: 10, borderRadius: 'var(--r-sm)', background: parent.color ?? 'var(--accent)' }} />
                <b>{parent.name}</b><span style={{ fontSize: 'var(--fs-meta)', color: 'var(--text-tertiary)' }}>{shown.length}/{children.length} 项</span>
                <span style={{ flex: 1 }} /><button type="button" onClick={(event) => { event.preventDefault(); event.stopPropagation(); setLifecycle(parent); }} style={editLinkButton}>归档/合并</button><button type="button" onClick={(event) => { event.preventDefault(); event.stopPropagation(); setEditing(parent); }} style={{ ...editLinkButton, marginLeft: 12 }}>编辑一级分类</button>
              </summary>
              <div className="zc-scroll-x"><table style={{ width: '100%', borderCollapse: 'collapse' }}>
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
              </table></div>
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
    fontWeight: 'var(--fw-bold)',
    fontSize: 'var(--fs-caption)',
    cursor: enabled ? 'pointer' : 'not-allowed',
    opacity: enabled ? 1 : 0.5,
  } as const;
}

function packButton(primary: boolean) {
  return {
    minHeight: 32,
    padding: '5px 9px',
    borderRadius: 'var(--r-sm)',
    border: `1px solid ${primary ? 'var(--accent)' : 'var(--border)'}`,
    background: primary ? 'var(--accent)' : 'var(--surface)',
    color: primary ? '#fff' : 'var(--fg-muted)',
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
  fontWeight: 'var(--fw-bold)',
  cursor: 'pointer',
} as const;

function typeBadge(type: Category['type']) {
  return {
    borderRadius: 'var(--r-pill)',
    padding: '2px 7px',
    color: type === 'income' ? 'var(--positive)' : 'var(--negative)',
    background: type === 'income' ? 'rgba(63,143,107,.13)' : 'rgba(194,96,74,.13)',
    fontSize: 'var(--fs-meta)',
    fontWeight: 'var(--fw-bold)',
  } as const;
}

function stateBadge(kind: 'frequent' | 'hidden' | 'inactive' | 'duplicate') {
  const colors = kind === 'frequent'
    ? { color: 'var(--positive)', background: 'rgba(63,143,107,.13)' }
    : kind === 'duplicate'
      ? { color: 'var(--negative)', background: 'rgba(194,96,74,.13)' }
      : { color: 'var(--text-tertiary)', background: 'var(--surface-2)' };
  return {
    border: '1px solid var(--border)',
    borderRadius: 'var(--r-pill)',
    padding: '2px 7px',
    ...colors,
    fontSize: 'var(--fs-meta)',
    fontWeight: 'var(--fw-bold)',
    whiteSpace: 'nowrap',
  } as const;
}

function Section<T extends { id: string; version: number }>(props: {
  title: string;
  headers: string[];
  items: T[];
  row: (t: T) => ReactNode[];
  dateOf?: (t: T) => string;
  duplicateKey?: (t: T) => string | undefined;
  makeSpec: () => EntityFormSpec<T>;
  put: (store: SqlLedgerStore, entity: T) => Promise<unknown>;
  bump: () => void;
  masterKind?: MasterDataKind;
  lifecycleCandidates?: { id: string; label: string }[];
}) {
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
    ? items.filter((item) => row(item).map((cell) => String(cell)).join(' ').toLowerCase().includes(query.trim().toLowerCase()))
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
        <button onClick={() => setEditing('new')} style={{ padding: '7px 14px', borderRadius: 'var(--r-sm)', border: '1px solid var(--accent)', background: 'var(--accent)', color: '#fff', fontWeight: 'var(--fw-bold)', fontSize: 'var(--fs-body)', cursor: 'pointer', whiteSpace: 'nowrap' }}>+ 新增{title}</button>
      </div>
      {dateOf && <div style={{ marginBottom: 12 }}><DateRangeBar value={dateRange} onChange={setDateRange} compact /></div>}
      <div style={{ overflowX: 'auto' }}>
        <table style={{ width: '100%', borderCollapse: 'collapse' }}>
          <thead><tr>{headers.map((h) => <th key={h} style={thStyle}>{h}</th>)}<th style={thStyle}></th></tr></thead>
          <tbody>
            {filteredItems.map((t) => (
              <tr key={t.id} onClick={() => setEditing(t)} style={{ cursor: 'pointer' }}>
                {row(t).map((c, i) => <td key={i} style={tdStyle}>{c}</td>)}
                <td style={{ ...tdStyle, textAlign: 'right', color: 'var(--text-tertiary)', whiteSpace: 'nowrap' }}>
                  {masterKind && <button type="button" onClick={(event) => { event.stopPropagation(); setLifecycle(t); }} style={{ ...editLinkButton, marginRight: 12 }}>归档/合并</button>}
                  编辑 ›
                </td>
              </tr>
            ))}
            {filteredItems.length === 0 && <tr><td style={{ ...tdStyle, color: 'var(--text-tertiary)' }} colSpan={headers.length + 1}>{items.length === 0 ? '暂无数据' : '没有匹配的记录'}</td></tr>}
          </tbody>
        </table>
      </div>
      {open && (
        <EntityFormModal
          spec={spec}
          initial={initial}
          onSave={async (e) => {
            const key = duplicateKey?.(e) ?? norm(row(e)[0]);
            const duplicate = key && items.some((item) => item.id !== e.id && (duplicateKey?.(item) ?? norm(row(item)[0])) === key);
            if (duplicate) throw new Error(`已存在相同的${title}，请修改名称或关联信息`);
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
        source={{ id: lifecycle.id, label: String(row(lifecycle)[0] ?? lifecycle.id), version: lifecycle.version }}
        candidates={lifecycleCandidates.filter((candidate) => candidate.id !== lifecycle.id)}
        onClose={() => setLifecycle(null)}
        onDone={() => { setLifecycle(null); bump(); }}
      />}
    </div>
  );
}

function AttachmentSection({ items, onDelete }: { items: Attachment[]; onDelete: (attachment: Attachment) => Promise<void> }) {
  const { store } = useStore();
  const [query, setQuery] = useState('');
  const [deleting, setDeleting] = useState<Attachment | null>(null);
  const [localStates, setLocalStates] = useState<Record<string, 'ready' | 'trash' | 'missing'>>({});
  const [replicas, setReplicas] = useState<AttachmentReplicaBlobRow[]>([]);
  const [fetching, setFetching] = useState('');
  const [message, setMessage] = useState('');
  const profileNames = Object.fromEntries(loadSyncConnections().map((profile) => [profile.id, profile.alias]));
  const refreshStates = useCallback(async () => {
    const entries = await Promise.all(items.map(async (attachment) => [attachment.sha256, await attachmentStorageStatus(attachment.sha256)] as const));
    setLocalStates(Object.fromEntries(entries));
    setReplicas(await store.attachmentState.listReplicaBlobs());
  }, [items, store]);
  useEffect(() => {
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
  }, [items, refreshStates, store]);
  const fetchBody = async (attachment: Attachment) => {
    setFetching(attachment.id);
    setMessage('');
    try {
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
      {message && <div style={{ marginBottom: 10, fontSize: 'var(--fs-caption)', fontWeight: 'var(--fw-bold)', color: message.startsWith('取回失败') ? 'var(--negative)' : 'var(--positive)' }}>{message}</div>}
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
                <td style={{ ...tdStyle, color: local === 'ready' ? 'var(--positive)' : local === 'trash' ? 'var(--accent)' : 'var(--negative)', fontWeight: 'var(--fw-bold)' }}>{local === 'ready' ? '可用' : local === 'trash' ? '回收区' : '按需下载'}</td>
                <td style={{ ...tdStyle, fontSize: 'var(--fs-meta)', color: 'var(--text-secondary)', maxWidth: 220 }}>
                  {remote.length ? remote.map((row) => `${profileNames[row.profileId] ?? row.profileId.slice(0, 8)}：${replicaStateLabel(row.state)}`).join(' · ') : '尚未同步'}
                </td>
                <td style={{ ...tdStyle, fontFamily: 'monospace', fontSize: 'var(--fs-meta)' }}>{attachment.sha256.slice(0, 16)}...</td>
                <td style={{ ...tdStyle, textAlign: 'right', whiteSpace: 'nowrap' }}>
                  {local !== 'ready' && <button type="button" disabled={fetching === attachment.id} onClick={() => void fetchBody(attachment)} style={{ border: '1px solid var(--border)', background: 'transparent', color: 'var(--text-secondary)', minHeight: 34, padding: '6px 10px', cursor: 'pointer', marginRight: 6 }}>{fetching === attachment.id ? '取回中…' : '取回正文'}</button>}
                  <button type="button" onClick={() => setDeleting(attachment)} style={{ border: '1px solid var(--negative)', background: 'transparent', color: 'var(--negative)', minHeight: 34, padding: '6px 10px', cursor: 'pointer' }}>删除</button>
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
