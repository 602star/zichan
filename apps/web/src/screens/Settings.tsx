import { useEffect, useState } from 'react';
import { checkConsistency, recomputeCaches, purgeTombstones, voidTransaction, type ConsistencyIssue } from '@zichan/db';
import { newId, type LedgerMode, type LotMethod, type Setting } from '@zichan/core';
import { useStore } from '../db/store.js';
import { useSnapshot } from '../db/snapshot.js';
import { baseAsset } from '../db/derive.js';
import { setBaseSymbol } from '../format.js';
import { card, th as thStyle, td as tdStyle } from '../ui/styles.js';
import { ConfirmDialog } from '../ui/ConfirmDialog.js';
import { DeviceSecurityPanel } from '../ui/DeviceSecurityPanel.js';
import { DesktopUpdatePanel } from '../ui/DesktopUpdatePanel.js';
import { allCategories, categoryIsHidden } from '../transactionMeta.js';
import {
  optionalTransactionFields,
  transactionFormFieldOptions,
  transactionFormPresetKeys,
} from '../transactionFormPrefs.js';
import {
  describePreflight,
  configureExternalBackupDirectory,
  downloadBackup,
  externalBackupStatus,
  listSavedBackups,
  openSavedBackup,
  prepareRemoteBackupForRestore,
  rehearseRestore,
  saveLedgerBackup,
  verifySavedBackup,
  type ExternalBackupStatus,
  type SavedBackup,
} from '../db/backups.js';
import {
  listRemoteBackups,
  removeRemoteBackup,
  type RemoteBackupArchive,
} from '../remote-backup.js';
import { loadSyncProfiles, type SyncServerProfile } from '../sync-config.js';
import {
  readSafetyState,
  safetyStateFromSetting,
  safetyWarnings,
  serializeSafetyState,
  writeSafetyState,
  type SafetyState,
} from '../db/safety.js';
import { moduleCurrencyId, moduleCurrencyPatch, type CurrencyModule } from '../currencyPreferences.js';
import { importPortableLedger } from '../db/portable-backup.js';
import { reconcileAttachmentStorage, verifyAttachmentContent } from '../db/attachment-storage.js';
import { resetPlatformData } from '../db/platform-driver.js';

const METHODS: [LotMethod, string][] = [
  ['fifo', 'FIFO · 先进先出'], ['lifo', 'LIFO · 后进先出'], ['average', '平均成本'], ['manual', '手动选择批次'],
];
const LEDGER_MODES: [LedgerMode, string][] = [
  ['spending', '轻量记账 · 只记收支'],
  ['accounts', '账户记账 · 收支 + 转账 + 对账'],
  ['assets', '完整资产账本 · 投资/物品资产/游戏资产'],
];
function todayDate(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}
const ISSUE_LABELS: Record<string, string> = {
  lot_remaining_mismatch: '持仓剩余数量不一致',
  oversold_lot: '批次被超卖',
  orphan_consumption: '批次消耗引用缺失',
  chain_cache_stale: '转换缓存过期',
  conversion_step_invalid: '转换步骤口径无效',
  missing_reference: '引用对象缺失',
  category_mismatch: '分类层级或类型不匹配',
  split_amount_exceeded: '拆分金额超过原流水',
  refund_invalid: '退款关联或金额口径无效',
  refund_amount_exceeded: '退款冲减超过原支出',
  game_reference_mismatch: '游戏、赛季或账号归属不一致',
  fixed_status_mismatch: '物品资产事件与状态不一致',
  required_field_missing: '必填字段缺失',
  attachment_file_invalid: '附件正文缺失或损坏',
};

export function Settings() {
  const { store, bump, storageBackend, dataLocation } = useStore();
  const snap = useSnapshot('settings');
  const [issues, setIssues] = useState<ConsistencyIssue[] | null>(null);
  const [lastCheck, setLastCheck] = useState<{ at: string; count: number } | null>(null);
  const [note, setNote] = useState('');
  const [backups, setBackups] = useState<SavedBackup[]>([]);
  const [backupFilter, setBackupFilter] = useState<'important' | 'all' | SavedBackup['reason']>('important');
  const [backupNote, setBackupNote] = useState('');
  const [backupBusy, setBackupBusy] = useState<string | null>(null);
  const [pendingRestore, setPendingRestore] = useState<{ entry: SavedBackup; mode: 'replace' | 'merge' } | null>(null);
  const [remoteBackups, setRemoteBackups] = useState<{ profile: SyncServerProfile; backup: RemoteBackupArchive }[]>([]);
  const [remoteLoaded, setRemoteLoaded] = useState(false);
  const [pendingRemoteDelete, setPendingRemoteDelete] = useState<{ profile: SyncServerProfile; backup: RemoteBackupArchive } | null>(null);
  const [externalStatus, setExternalStatus] = useState<ExternalBackupStatus>({ kind: 'none', configured: false, label: '检测中…' });
  const [storageEstimate, setStorageEstimate] = useState<{ usage: number; quota: number } | null>(null);
  const [resetOpen, setResetOpen] = useState(false);
  const [cleanupOpen, setCleanupOpen] = useState(false);
  const [safetyState, setSafetyState] = useState(readSafetyState);
  useEffect(() => {
    void listSavedBackups().then(setBackups);
    void externalBackupStatus().then(setExternalStatus).catch((error) => setExternalStatus({ kind: 'none', configured: false, label: error instanceof Error ? error.message : String(error) }));
    void navigator.storage?.estimate().then((estimate) => setStorageEstimate({ usage: estimate.usage ?? 0, quota: estimate.quota ?? 0 }));
  }, []);
  useEffect(() => {
    setSafetyState(safetyStateFromSetting(snap?.setting));
  }, [snap?.setting?.dataSafetyStateJson]);
  if (!snap) return null;
  const readySnap = snap;

  const setting = readySnap.setting;
  const base = baseAsset(readySnap);

  async function saveSetting(
    patch: Partial<Setting>,
    options: { label?: string; undoable?: boolean } = {},
  ) {
    const cur: Setting = setting ?? {
      id: newId(), createdAt: '', updatedAt: '', version: 1, isDeleted: false,
      baseCurrencyAssetId: base?.id ?? readySnap.assets[0]?.id ?? '', defaultLotMethod: 'fifo',
      ledgerMode: 'spending', asOfDate: todayDate(), categoryPickerDefaultScope: 'frequent', refundAttributionMode: 'original_date',
    };
    await store.runInAuditBatch(
      options.label ?? '保存应用设置',
      async (transactionStore) => {
        const current = await transactionStore.settings.get(cur.id);
        await transactionStore.settings.put({ ...(current ?? cur), ...patch });
      },
      'system',
      { undoable: options.undoable },
    );
    bump();
  }

  async function saveFormFields(keys: string[]) {
    await saveSetting({ transactionFormOptionalFields: keys.join(',') }, { label: '调整记账表单字段' });
  }

  async function saveSafetyState(patch: Partial<SafetyState>) {
    const next = { ...safetyStateFromSetting(setting), ...safetyState, ...patch };
    await saveSetting(
      { dataSafetyStateJson: serializeSafetyState(next) },
      { label: '更新数据安全状态', undoable: false },
    );
    setSafetyState(writeSafetyState(next));
    return next;
  }

  async function onBaseCurrency(assetId: string) {
    await saveSetting({ baseCurrencyAssetId: assetId }, { label: '调整全局默认货币' });
    const a = readySnap.assets.find((x) => x.id === assetId);
    setBaseSymbol(a?.symbol ?? a?.code ?? '£');
  }

  async function onModuleCurrency(module: CurrencyModule, assetId: string) {
    await saveSetting(moduleCurrencyPatch(module, assetId), { label: '调整模块默认货币' });
  }

  async function runCheck() {
    setNote('');
    try {
      const next = [...await checkConsistency(store), ...await checkAttachmentFiles()];
      setIssues(next);
      setLastCheck({ at: new Date().toISOString(), count: next.length });
      await saveSafetyState({ lastCheckAt: new Date().toISOString(), lastCheckCount: next.length });
    } catch (e) {
      setIssues(null);
      setNote('自检失败：' + (e instanceof Error ? e.message : String(e)));
    }
  }
  async function runRecompute() {
    const r = await recomputeCaches(store);
    setIssues(null);
    setNote(`已重算 ${r.chains} 条链路、${r.lots} 个批次的派生缓存。`);
    bump();
  }
  async function purgeOld() {
    const result = await purgeTombstones(store, 90);
    setNote(`已清理 ${result.purged} 条 90 天前且所有活跃副本均已确认的删除记录`
      + (result.blocked > 0 ? `；另有 ${result.blocked} 条仍等待副本确认。` : '。'));
    bump();
  }
  async function refreshBackups() {
    setBackups(await listSavedBackups());
    const estimate = await navigator.storage?.estimate();
    if (estimate) setStorageEstimate({ usage: estimate.usage ?? 0, quota: estimate.quota ?? 0 });
  }
  async function refreshRemoteBackups() {
    setBackupBusy('remote-list');
    try {
      const ledgerId = await store.getLedgerId();
      const profiles = loadSyncProfiles().filter((profile) =>
        profile.enabled && profile.serverId && profile.ledgerId === ledgerId);
      const results = await Promise.allSettled(profiles.map(async (profile) => ({
        profile,
        backups: await listRemoteBackups(profile),
      })));
      const rows = results.flatMap((result) => result.status === 'fulfilled'
        ? result.value.backups.map((backup) => ({ profile: result.value.profile, backup }))
        : []);
      setRemoteBackups(rows.sort((left, right) =>
        right.backup.createdAt.localeCompare(left.backup.createdAt)));
      setRemoteLoaded(true);
      const errors = results.filter((result): result is PromiseRejectedResult => result.status === 'rejected');
      setBackupNote(errors.length
        ? `已读取 ${rows.length} 份服务器备份；${errors.length} 台服务器读取失败：${errors
          .map((result) => result.reason instanceof Error ? result.reason.message : String(result.reason))
          .join('；')}`
        : `已读取 ${rows.length} 份服务器备份。`);
    } catch (error) {
      setBackupNote(`读取服务器备份失败：${error instanceof Error ? error.message : String(error)}`);
    } finally {
      setBackupBusy(null);
    }
  }
  async function prepareRemoteRestore(
    row: { profile: SyncServerProfile; backup: RemoteBackupArchive },
    action: 'rehearse' | 'merge' | 'replace',
  ) {
    const busyId = `remote-${row.profile.id}-${row.backup.archiveId}`;
    setBackupBusy(busyId);
    try {
      const entry = await prepareRemoteBackupForRestore(row.profile, row.backup);
      if (action === 'rehearse') {
        const result = await rehearseRestore((await openSavedBackup(entry)).ledger);
        await saveSafetyState({
          lastRehearsalAt: new Date().toISOString(),
          lastRehearsalOk: result.ok,
          lastRehearsalLabel: `${entry.label}（${row.profile.alias}）`,
        });
        setBackupNote(result.ok
          ? `服务器备份恢复演练通过：${describePreflight(result.preflight)}`
          : `服务器备份恢复演练未通过：${result.error ?? result.consistencyIssues.map((issue) => issue.detail).join('；')}`);
        return;
      }
      const rehearsal = await rehearseRestore((await openSavedBackup(entry)).ledger);
      if (!rehearsal.ok) {
        throw new Error(rehearsal.error ?? rehearsal.consistencyIssues.map((issue) => issue.detail).join('；'));
      }
      setPendingRestore({ entry, mode: action });
    } catch (error) {
      setBackupNote(`服务器备份校验失败：${error instanceof Error ? error.message : String(error)}`);
    } finally {
      setBackupBusy(null);
    }
  }
  async function confirmRemoteDelete() {
    const pending = pendingRemoteDelete;
    if (!pending) return;
    setBackupBusy(`remote-delete-${pending.backup.archiveId}`);
    try {
      await removeRemoteBackup(pending.profile, pending.backup.archiveId);
      setRemoteBackups((rows) => rows.filter((row) =>
        row.profile.id !== pending.profile.id || row.backup.archiveId !== pending.backup.archiveId));
      setBackupNote(`已将“${pending.backup.label}”移入 ${pending.profile.alias} 的服务器回收区。`);
    } catch (error) {
      setBackupNote(`删除服务器备份失败：${error instanceof Error ? error.message : String(error)}`);
    } finally {
      setPendingRemoteDelete(null);
      setBackupBusy(null);
    }
  }
  async function manualBackup() {
    setBackupBusy('manual');
    try {
      const entry = await saveLedgerBackup(store, 'manual');
      setBackupNote(`已创建：${entry.label} · ${describePreflight(entry.preflight)}${entry.externalSaved ? ` · 已写入 ${entry.externalPath}` : ` · 外部副本未写入：${entry.externalError}`}`);
      if (entry.externalSaved) await saveSafetyState({ lastExternalBackupAt: entry.createdAt, lastBackupError: undefined, lastBackupErrorAt: undefined });
      await refreshBackups();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      setBackupNote(`手动备份失败：${message}`);
      await saveSafetyState({ lastBackupError: message, lastBackupErrorAt: new Date().toISOString() });
    } finally {
      setBackupBusy(null);
    }
  }
  async function rehearse(entry: SavedBackup) {
    setBackupBusy(entry.id);
    try {
      const result = await rehearseRestore((await openSavedBackup(entry)).ledger);
      await saveSafetyState({ lastRehearsalAt: new Date().toISOString(), lastRehearsalOk: result.ok, lastRehearsalLabel: entry.label });
      setBackupNote(result.ok
        ? `恢复演练通过：${describePreflight(result.preflight)}`
        : `恢复演练未通过：${result.error ?? result.consistencyIssues.map((i) => i.detail).join('；')}`);
    } catch (error) {
      setBackupNote(`恢复演练失败：${error instanceof Error ? error.message : String(error)}`);
    } finally {
      setBackupBusy(null);
    }
  }
  async function restore(entry: SavedBackup, mode: 'replace' | 'merge') {
    setBackupBusy(entry.id);
    try {
      if (!(await verifySavedBackup(entry))) {
        setBackupNote('备份校验和不一致或当前密钥未解锁，已停止恢复。');
        return;
      }
      const rehearsal = await rehearseRestore((await openSavedBackup(entry)).ledger);
      if (!rehearsal.ok) {
        setBackupNote(`恢复演练未通过，已停止导入：${rehearsal.error ?? rehearsal.consistencyIssues.map((i) => i.detail).join('；')}`);
        await saveSafetyState({ lastRehearsalAt: new Date().toISOString(), lastRehearsalOk: false, lastRehearsalLabel: entry.label });
        return;
      }
      await saveSafetyState({ lastRehearsalAt: new Date().toISOString(), lastRehearsalOk: true, lastRehearsalLabel: entry.label });
      setPendingRestore({ entry, mode });
    } catch (error) {
      setBackupNote(`备份恢复检查失败：${error instanceof Error ? error.message : String(error)}`);
    } finally {
      setBackupBusy(null);
    }
  }
  async function chooseExternalDirectory() {
    setBackupBusy('external');
    try {
      const status = await configureExternalBackupDirectory();
      setExternalStatus(status);
      setBackupNote(status.kind === 'desktop' ? `原生备份目录：${status.label}` : `已选择外部备份目录：${status.label}`);
    } catch (error) {
      setBackupNote(`外部备份目录设置失败：${error instanceof Error ? error.message : String(error)}`);
    } finally {
      setBackupBusy(null);
    }
  }
  async function quickSafetyCheck() {
    setBackupBusy('safety');
    try {
      const entry = await saveLedgerBackup(store, 'manual', '安全检查备份');
      const next = [...await checkConsistency(store), ...await checkAttachmentFiles()];
      setIssues(next);
      setLastCheck({ at: new Date().toISOString(), count: next.length });
      await saveSafetyState({ lastCheckAt: new Date().toISOString(), lastCheckCount: next.length });
      setBackupNote(`已完成安全检查：${entry.label} · 自检${next.length === 0 ? '通过' : `发现 ${next.length} 个问题`}`);
      await refreshBackups();
    } catch (error) {
      setBackupNote(`安全检查失败：${error instanceof Error ? error.message : String(error)}`);
    } finally {
      setBackupBusy(null);
    }
  }
  async function checkAttachmentFiles(): Promise<ConsistencyIssue[]> {
    const result: ConsistencyIssue[] = [];
    for (const attachment of readySnap.attachments.filter((row) => !row.isDeleted)) {
      try {
        if (!(await verifyAttachmentContent(attachment))) {
          result.push({ kind: 'attachment_file_invalid', entityType: 'attachment', entityId: attachment.id, detail: `${attachment.fileName} 的大小或 SHA-256 不一致` });
        }
      } catch (error) {
        result.push({ kind: 'attachment_file_invalid', entityType: 'attachment', entityId: attachment.id, detail: `${attachment.fileName} 无法读取：${error instanceof Error ? error.message : String(error)}` });
      }
    }
    return result;
  }
  async function confirmRestore() {
    const pending = pendingRestore;
    if (!pending) return;
    const { entry, mode } = pending;
    setBackupBusy(entry.id);
    try {
      await saveLedgerBackup(store, 'pre-import', '从备份恢复前');
      const payload = await openSavedBackup(entry);
      const batch = await store.createAuditBatch({
        id: newId(),
        type: 'import',
        label: mode === 'replace' ? `精确恢复：${entry.label}` : `合并导入：${entry.label}`,
        summary: mode === 'replace' ? '用备份替换当前活动账本' : '将备份合并到当前账本',
      });
      const result = await store.withAuditContext(
        { batchId: batch.id, source: 'import' },
        (store) => importPortableLedger(store, payload.ledger, mode, {
          deviceState: mode === 'replace' && payload.kind === 'device' ? payload.deviceState : undefined,
        }),
      );
      const removed = 'removed' in result ? Number(result.removed) : 0;
      await store.finishAuditBatch(batch.id, { entityCount: result.entities + removed });
      setBackupNote(mode === 'replace'
        ? `精确恢复完成：恢复 ${result.entities} 条，移除 ${removed} 条备份外数据。`
        : `合并导入完成：处理 ${result.entities} 条数据。`);
      await refreshBackups();
      bump();
    } catch (error) {
      setBackupNote(`恢复失败：${error instanceof Error ? error.message : String(error)}`);
    } finally {
      setPendingRestore(null);
      setBackupBusy(null);
    }
  }
  async function resetData() {
    await resetPlatformData();
    location.reload();
  }
  async function cleanupTestTransactions() {
    setBackupBusy('cleanup-test');
    try {
      await saveLedgerBackup(store, 'manual', '清理测试流水前');
      const isTestText = (value?: string) => /测试|test/i.test(value ?? '');
      const rows = readySnap.transactions.filter((t) => !t.isDeleted && (isTestText(t.description) || isTestText(t.merchant) || isTestText(t.note)));
      const ids = new Set(rows.map((t) => t.id));
      await store.runInAuditBatch(`清理 ${rows.length} 条测试流水`, async (transactionStore) => {
        for (const attachment of readySnap.attachments.filter((a) => a.entityType === 'transaction' && ids.has(a.entityId))) {
          await transactionStore.attachments.remove(attachment.id, attachment.version);
        }
        for (const tx of rows) {
          await voidTransaction(transactionStore, tx.id, '清理测试流水');
        }
      }, 'bulk_update');
      await reconcileAttachmentStorage(store);
      setBackupNote(`已作废 ${rows.length} 条测试流水、移除其附件，并保留清理前备份。`);
      setCleanupOpen(false);
      await refreshBackups();
      bump();
    } finally {
      setBackupBusy(null);
    }
  }
  const backupSize = (entry: Pick<SavedBackup, 'sizeBytes'>): string => {
    const bytes = entry.sizeBytes;
    return bytes > 1024 * 1024 ? `${(bytes / 1024 / 1024).toFixed(1)} MB` : `${Math.max(1, Math.round(bytes / 1024))} KB`;
  };
  const reasonLabel = (reason: SavedBackup['reason']): string => {
    if (reason === 'auto') return '自动';
    if (reason === 'pre-import') return '导入前';
    return '手动';
  };
  const latestAutoId = backups.find((b) => b.reason === 'auto')?.id;
  const visibleBackups = backupFilter === 'important'
    ? backups.filter((b) => b.reason !== 'auto' || b.id === latestAutoId)
    : backupFilter === 'all' ? backups : backups.filter((b) => b.reason === backupFilter);
  const latestBackup = backups[0];
  const latestAuto = backups.find((b) => b.reason === 'auto');
  const warnings = safetyWarnings(backups, safetyState);
  const usesAccounts = (setting?.ledgerMode ?? 'spending') !== 'spending';
  const formFields = new Set(optionalTransactionFields(setting, usesAccounts));
  const formFieldOptions = transactionFormFieldOptions(usesAccounts);
  const categoryCatalog = allCategories(readySnap.categories).filter((category) => category.parentId && category.isActive !== false);
  const frequentCategoryCount = categoryCatalog.filter((category) => !categoryIsHidden(category)).length;
  const hiddenCategoryCount = categoryCatalog.length - frequentCategoryCount;
  const openCategoryCenter = () => {
    try {
      sessionStorage.setItem('zichan.manage.target', JSON.stringify({ tab: 'transactionCategories', categoryMode: 'quick' }));
    } catch {
      // Navigation still works when session storage is unavailable.
    }
    window.dispatchEvent(new CustomEvent('zichan:navigate', { detail: { screen: 'manage' } }));
  };
  const issueGroups = issues ? [...issues.reduce((map, issue) => {
    const rows = map.get(issue.kind) ?? [];
    rows.push(issue);
    map.set(issue.kind, rows);
    return map;
  }, new Map<string, ConsistencyIssue[]>()).entries()] : [];

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 18, maxWidth: 980 }}>
      <div style={card}>
        <div style={{ fontSize: 15, fontWeight: 800, marginBottom: 14 }}>结算与偏好</div>
        <div className="zc-settings-grid" style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 14 }}>
          <div>
            <label className="zc-label">全局报表币种</label>
            <select aria-label="全局报表币种" className="zc-select" value={setting?.baseCurrencyAssetId ?? base?.id ?? ''} onChange={(e) => onBaseCurrency(e.target.value)}>
              {snap.assets.filter((a) => !a.isDeleted).map((a) => (
                <option key={a.id} value={a.id}>{a.code} · {a.name}</option>
              ))}
            </select>
          </div>
          {([
            ['transaction', '日常记账默认币种'],
            ['investment', '投资成本记账币种'],
            ['fixed', '物品资产默认币种'],
            ['game', '游戏结算默认币种'],
          ] as const).map(([module, label]) => {
            const fieldValue = module === 'transaction' ? setting?.transactionDefaultAssetId
              : module === 'investment' ? setting?.investmentCostAssetId
                : module === 'fixed' ? setting?.fixedAssetDefaultCurrencyAssetId
                  : setting?.gameDefaultSettlementAssetId;
            return (
              <div key={module}>
                <label className="zc-label">{label}</label>
                <select aria-label={label} className="zc-select" value={fieldValue ?? ''} onChange={(e) => void onModuleCurrency(module, e.target.value)}>
                  <option value="">沿用全局 · {snap.assets.find((a) => a.id === moduleCurrencyId(setting, module))?.code ?? '未设置'}</option>
                  {snap.assets.filter((a) => !a.isDeleted).map((a) => <option key={a.id} value={a.id}>{a.code} · {a.name}</option>)}
                </select>
              </div>
            );
          })}
          <div>
            <label className="zc-label">默认卖出匹配方式</label>
            <select aria-label="默认卖出匹配方式" className="zc-select" value={setting?.defaultLotMethod ?? 'fifo'} onChange={(e) => saveSetting({ defaultLotMethod: e.target.value as LotMethod })}>
              {METHODS.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
            </select>
          </div>
          <div>
            <label className="zc-label">记账模式</label>
            <select aria-label="记账模式" className="zc-select" value={setting?.ledgerMode ?? 'spending'} onChange={(e) => saveSetting({ ledgerMode: e.target.value as LedgerMode })}>
              {LEDGER_MODES.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
            </select>
          </div>
          <div>
            <label className="zc-label">报表基准日</label>
            <input aria-label="报表基准日" className="zc-input" type="date" value={setting?.asOfDate ?? todayDate()} onChange={(e) => saveSetting({ asOfDate: e.target.value })} />
          </div>
          <div>
            <label className="zc-label">退款统计归属</label>
            <select aria-label="退款统计归属" className="zc-select" value={setting?.refundAttributionMode ?? 'original_date'} onChange={(e) => saveSetting({ refundAttributionMode: e.target.value as 'original_date' | 'refund_date' })}>
              <option value="original_date">冲减原消费日期</option>
              <option value="refund_date">计入实际退款日期</option>
            </select>
          </div>
        </div>
        <div style={{ fontSize: 12, color: 'var(--fg-subtle)', marginTop: 10 }}>
          模块币种只预填新记录，不改写历史币种或金额；新预算默认使用日常记账币种并在保存后冻结。轻量记账隐藏账户、转账和对账；退款默认回冲原消费与原预算，也可改为按退款到账日期统计。
        </div>
      </div>

      <div style={card}>
        <div style={{ fontSize: 15, fontWeight: 800, marginBottom: 12 }}>记账表单字段</div>
        <div style={{ fontSize: 12, color: 'var(--fg-subtle)', marginBottom: 12 }}>
          日期、交易时间、类型、二级分类、金额、币种、描述和附件固定显示；下方字段会出现在“更多信息”里。当前模式：{usesAccounts ? '账户/资产模式' : '轻量记账'}。
        </div>
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginBottom: 10 }}>
          {[
            ['仅核心', transactionFormPresetKeys('core', usesAccounts)],
            ['常用', transactionFormPresetKeys('common', usesAccounts)],
            ['完整', transactionFormPresetKeys('full', usesAccounts)],
          ].map(([label, keys]) => (
            <button key={String(label)} onClick={() => void saveFormFields(keys as string[])} style={outline}>{String(label)}</button>
          ))}
        </div>
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
          {formFieldOptions.map(({ key, label }) => (
            <label key={key} style={{ display: 'inline-flex', alignItems: 'center', gap: 6, border: '1px solid var(--border)', borderRadius: 999, padding: '7px 11px', fontSize: 12, fontWeight: 800, color: 'var(--fg-muted)', background: formFields.has(key) ? 'var(--accent-soft)' : 'var(--surface-2)' }}>
              <input
                type="checkbox"
                checked={formFields.has(key)}
                onChange={(e) => {
                  const next = new Set(formFields);
                  if (e.target.checked) next.add(key);
                  else next.delete(key);
                  void saveFormFields([...next]);
                }}
              />
              {label}
            </label>
          ))}
        </div>
      </div>

      <div style={card}>
        <div className="zc-responsive-header" style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 16 }}>
          <div>
            <div style={{ fontSize: 15, fontWeight: 800 }}>记账分类</div>
            <div style={{ fontSize: 12, color: 'var(--fg-subtle)', marginTop: 4 }}>高频 {frequentCategoryCount} 项 · 隐藏 {hiddenCategoryCount} 项</div>
          </div>
          <button type="button" onClick={openCategoryCenter} style={outline}>进入分类中心</button>
        </div>
        <div className="zc-settings-category-grid" style={{ display: 'grid', gridTemplateColumns: 'minmax(180px, 320px) 1fr', gap: 14, alignItems: 'end', marginTop: 14 }}>
          <div>
            <label className="zc-label">记账弹窗默认分类范围</label>
            <select
              aria-label="记账弹窗默认分类范围"
              className="zc-select"
              value={setting?.categoryPickerDefaultScope ?? 'frequent'}
              onChange={(event) => void saveSetting({ categoryPickerDefaultScope: event.target.value as 'frequent' | 'all' })}
            >
              <option value="frequent">仅高频分类</option>
              <option value="all">全部分类</option>
            </select>
          </div>
          <div style={{ fontSize: 12, color: 'var(--fg-subtle)', lineHeight: 1.6 }}>
            “仅高频”保持记账选择器简洁，搜索仍会匹配隐藏分类。新增、改名、隐藏和排序统一在分类中心处理。
          </div>
        </div>
      </div>

      <DeviceSecurityPanel />

      <DesktopUpdatePanel
        beforeInstall={async (label) => {
          await saveLedgerBackup(store, 'manual', label, 'device');
          await refreshBackups();
        }}
      />

      <div style={card}>
        <div className="zc-responsive-header" style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12, marginBottom: 12 }}>
          <div>
            <div style={{ fontSize: 15, fontWeight: 800 }}>备份与恢复</div>
            <div style={{ fontSize: 12, color: 'var(--fg-subtle)', marginTop: 4 }}>自动备份按小时、日、周分层保留；手动和导入前备份固定保留。桌面端同时写入独立目录。</div>
          </div>
          <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
            <select aria-label="备份来源筛选" className="zc-select" value={backupFilter} onChange={(e) => setBackupFilter(e.target.value as typeof backupFilter)} style={{ width: 120 }}>
              <option value="important">重点备份</option>
              <option value="all">全部来源</option>
              <option value="auto">自动</option>
              <option value="manual">手动</option>
              <option value="pre-import">导入前</option>
            </select>
            <button onClick={chooseExternalDirectory} disabled={backupBusy !== null} style={outline}>{externalStatus.kind === 'desktop' ? '查看备份目录' : externalStatus.configured ? '更换外部目录' : '选择外部目录'}</button>
            <button onClick={manualBackup} disabled={backupBusy !== null} style={primary}>创建手动备份</button>
          </div>
        </div>
        {warnings.length > 0 && (
          <div style={{ border: '1px solid var(--border)', borderRadius: 12, padding: 10, background: 'var(--surface-2)', marginBottom: 12 }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', gap: 12, alignItems: 'center' }}>
              <div>
                <div style={{ fontSize: 13, fontWeight: 900, color: warnings.some((w) => w.tone === 'danger') ? 'var(--negative)' : 'var(--accent)' }}>数据安全提醒</div>
                <div style={{ fontSize: 12, color: 'var(--fg-muted)', marginTop: 4 }}>{warnings.map((w) => w.message).join('；')}</div>
              </div>
              <button onClick={quickSafetyCheck} disabled={backupBusy !== null} style={primary}>{backupBusy === 'safety' ? '检查中…' : '一键备份 + 自检'}</button>
            </div>
          </div>
        )}
        <div className="zc-settings-health-grid" style={{ display: 'grid', gridTemplateColumns: 'repeat(3, minmax(0, 1fr))', gap: 10, marginBottom: 12 }}>
          <HealthTile label="最近备份" value={latestBackup ? new Date(latestBackup.createdAt).toLocaleString() : '暂无'} tone={latestBackup ? 'var(--positive)' : 'var(--negative)'} />
          <HealthTile label="自动备份" value={latestAuto ? new Date(latestAuto.createdAt).toLocaleString() : '暂无'} tone={latestAuto ? 'var(--positive)' : 'var(--fg-subtle)'} />
          <HealthTile label="最近演练" value={safetyState.lastRehearsalAt ? `${safetyState.lastRehearsalOk ? '通过' : '未通过'} · ${safetyState.lastRehearsalLabel ?? ''}` : '未运行'} tone={safetyState.lastRehearsalOk ? 'var(--positive)' : safetyState.lastRehearsalAt ? 'var(--negative)' : 'var(--fg-subtle)'} />
          <HealthTile label="备份数量" value={`${backups.length} 份`} tone={backups.length > 0 ? 'var(--positive)' : 'var(--fg-subtle)'} />
          <HealthTile label="独立备份" value={externalStatus.label} tone={backups.some((backup) => backup.externalSaved) ? 'var(--positive)' : 'var(--negative)'} />
          <HealthTile
            label={storageBackend === 'native-sqlite' ? '原生存储' : '浏览器存储'}
            value={storageBackend === 'native-sqlite' ? 'ledger.sqlite + 文件' : storageEstimate?.quota ? `${(storageEstimate.usage / 1024 / 1024).toFixed(1)} / ${(storageEstimate.quota / 1024 / 1024).toFixed(0)} MB` : '不可用'}
            tone={storageBackend === 'native-sqlite' ? 'var(--positive)' : storageEstimate?.quota && storageEstimate.usage / storageEstimate.quota > 0.8 ? 'var(--negative)' : 'var(--fg-muted)'}
          />
        </div>
        <div style={{ fontSize: 11, color: 'var(--fg-subtle)', marginBottom: 10, overflowWrap: 'anywhere' }}>主数据位置：{dataLocation}</div>
        {backupNote && <div style={{ fontSize: 12, color: backupNote.includes('未通过') ? 'var(--negative)' : 'var(--positive)', fontWeight: 700, marginBottom: 10 }}>{backupNote}</div>}
        <div style={{ overflowX: 'auto' }}>
          <table style={{ width: '100%', borderCollapse: 'collapse' }}>
            <thead>
              <tr><th style={thStyle}>时间</th><th style={thStyle}>来源</th><th style={thStyle}>大小</th><th style={thStyle}>校验</th><th style={thStyle}>操作</th></tr>
            </thead>
            <tbody>
              {visibleBackups.map((b) => (
                <tr key={b.id}>
                  <td style={tdStyle}>
                    <div style={{ fontWeight: 800 }}>{b.label}</div>
                    <div style={{ fontSize: 11, color: 'var(--fg-subtle)', marginTop: 3 }}>{new Date(b.createdAt).toLocaleString()}</div>
                  </td>
                  <td style={tdStyle}>
                    <div>{reasonLabel(b.reason)} · {b.kind === 'device' ? '完整设备' : '可移植账本'} · {b.tier === 'pinned' ? '固定保留' : b.tier === 'hourly' ? '小时层' : b.tier === 'daily' ? '日层' : '周层'}</div>
                    <div style={{ fontSize: 10, color: b.externalSaved ? 'var(--positive)' : 'var(--fg-subtle)', marginTop: 3 }}>{b.externalSaved ? '本机 + 独立副本' : '仅本机存储'}</div>
                  </td>
                  <td style={tdStyle}>{backupSize(b)}</td>
                  <td style={{ ...tdStyle, color: b.preflight.ok ? 'var(--positive)' : 'var(--negative)' }}>{describePreflight(b.preflight)}</td>
                  <td style={tdStyle}>
                    <div style={{ display: 'flex', gap: 7, flexWrap: 'wrap', justifyContent: 'flex-end' }}>
                      <button onClick={() => rehearse(b)} disabled={backupBusy !== null} style={outline}>{backupBusy === b.id ? '演练中…' : '演练'}</button>
                      <button onClick={() => void downloadBackup(b)} style={outline}>分享 / 下载</button>
                      <button onClick={() => restore(b, 'merge')} disabled={backupBusy !== null} style={outline}>合并</button>
                      <button onClick={() => restore(b, 'replace')} disabled={backupBusy !== null} style={{ ...outline, border: '1px solid var(--accent)', color: 'var(--accent)' }}>精确恢复</button>
                    </div>
                  </td>
                </tr>
              ))}
              {visibleBackups.length === 0 && <tr><td style={{ ...tdStyle, color: 'var(--fg-subtle)' }} colSpan={5}>{backups.length === 0 ? '还没有备份。保存任意数据后会自动创建，也可以手动创建。' : '当前筛选下没有备份。'}</td></tr>}
            </tbody>
          </table>
        </div>
        <div style={{ borderTop: '1px solid var(--border)', marginTop: 14, paddingTop: 14 }}>
          <div className="zc-responsive-header" style={{ display: 'flex', justifyContent: 'space-between', gap: 12, alignItems: 'center', marginBottom: 10 }}>
            <div>
              <div style={{ fontSize: 13, fontWeight: 900 }}>同步服务器备份</div>
              <div style={{ fontSize: 11, color: 'var(--fg-subtle)', marginTop: 3 }}>
                服务器只保存加密归档。恢复前会下载、校验分块和归档头，再使用本机账本密钥解密预检。
              </div>
            </div>
            <button
              onClick={refreshRemoteBackups}
              disabled={backupBusy !== null}
              style={outline}
            >
              {backupBusy === 'remote-list' ? '读取中…' : '刷新服务器备份'}
            </button>
          </div>
          <div style={{ overflowX: 'auto' }}>
            <table style={{ width: '100%', borderCollapse: 'collapse' }}>
              <thead>
                <tr>
                  <th style={thStyle}>时间</th>
                  <th style={thStyle}>服务器</th>
                  <th style={thStyle}>类型</th>
                  <th style={thStyle}>大小</th>
                  <th style={thStyle}>操作</th>
                </tr>
              </thead>
              <tbody>
                {remoteBackups.map((row) => {
                  const busyId = `remote-${row.profile.id}-${row.backup.archiveId}`;
                  return (
                    <tr key={`${row.profile.id}:${row.backup.archiveId}`}>
                      <td style={tdStyle}>
                        <div style={{ fontWeight: 800 }}>{row.backup.label}</div>
                        <div style={{ fontSize: 11, color: 'var(--fg-subtle)', marginTop: 3 }}>
                          {new Date(row.backup.createdAt).toLocaleString()}
                        </div>
                      </td>
                      <td style={tdStyle}>{row.profile.alias}</td>
                      <td style={tdStyle}>{reasonLabel(row.backup.reason)} · {row.backup.kind === 'device' ? '完整设备' : '可移植账本'}</td>
                      <td style={tdStyle}>{backupSize(row.backup)}</td>
                      <td style={tdStyle}>
                        <div style={{ display: 'flex', gap: 7, flexWrap: 'wrap', justifyContent: 'flex-end' }}>
                          <button
                            onClick={() => void prepareRemoteRestore(row, 'rehearse')}
                            disabled={backupBusy !== null}
                            style={outline}
                          >
                            {backupBusy === busyId ? '校验中…' : '演练'}
                          </button>
                          <button onClick={() => void prepareRemoteRestore(row, 'merge')} disabled={backupBusy !== null} style={outline}>合并</button>
                          <button
                            onClick={() => void prepareRemoteRestore(row, 'replace')}
                            disabled={backupBusy !== null}
                            style={{ ...outline, border: '1px solid var(--accent)', color: 'var(--accent)' }}
                          >
                            精确恢复
                          </button>
                          <button
                            onClick={() => setPendingRemoteDelete(row)}
                            disabled={backupBusy !== null}
                            style={{ ...outline, color: 'var(--negative)' }}
                          >
                            删除
                          </button>
                        </div>
                      </td>
                    </tr>
                  );
                })}
                {remoteBackups.length === 0 && (
                  <tr>
                    <td style={{ ...tdStyle, color: 'var(--fg-subtle)' }} colSpan={5}>
                      {remoteLoaded ? '已连接的同步服务器上没有备份。' : '点击“刷新服务器备份”读取已连接服务器的恢复点。'}
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        </div>
      </div>

      <div style={card}>
        <div className="zc-responsive-header" style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 12 }}>
          <div style={{ fontSize: 15, fontWeight: 800 }}>数据自检</div>
          <div style={{ display: 'flex', gap: 8 }}>
            <button onClick={runCheck} style={outline}>运行自检</button>
            <button onClick={runRecompute} style={primary}>重算缓存</button>
          </div>
        </div>
        {note && <div style={{ fontSize: 13, color: note.includes('失败') ? 'var(--negative)' : 'var(--positive)', fontWeight: 600 }}>{note}</div>}
        {lastCheck && (
          <div style={{ display: 'grid', gridTemplateColumns: '1fr auto', gap: 12, alignItems: 'center', border: '1px solid var(--border)', borderRadius: 10, padding: 12, background: 'var(--surface-2)', marginBottom: 12 }}>
            <div>
              <div style={{ fontSize: 13, fontWeight: 900 }}>{lastCheck.count === 0 ? '自检通过' : `发现 ${lastCheck.count} 个问题`}</div>
              <div style={{ fontSize: 12, color: 'var(--fg-subtle)', marginTop: 3 }}>最近检查：{new Date(lastCheck.at).toLocaleString()}</div>
            </div>
            <span style={{ color: lastCheck.count === 0 ? 'var(--positive)' : 'var(--negative)', fontSize: 20, fontWeight: 900 }}>{lastCheck.count === 0 ? '✓' : '!'}</span>
          </div>
        )}
        {issues !== null && (
          issues.length === 0
            ? <div style={{ fontSize: 13, color: 'var(--positive)', fontWeight: 600 }}>✓ 未发现不一致</div>
            : (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
                {issueGroups.map(([kind, rows]) => (
                  <div key={kind} style={{ borderTop: '1px solid var(--border)', paddingTop: 10 }}>
                    <div style={{ fontSize: 12, color: 'var(--negative)', fontWeight: 900, marginBottom: 5 }}>{ISSUE_LABELS[kind] ?? kind} · {rows.length} 条</div>
                    {kind === 'chain_cache_stale' && <div style={{ fontSize: 12, color: 'var(--fg-subtle)', marginBottom: 6 }}>建议先点击“重算缓存”。</div>}
                    {rows.map((i, k) => (
                      <div key={`${i.entityId}-${k}`} style={{ fontSize: 12, color: 'var(--fg-muted)', lineHeight: 1.55 }}>
                        {i.entityType} {i.entityId.slice(0, 8)} — {i.detail}
                      </div>
                    ))}
                  </div>
                ))}
              </div>
            )
        )}
      </div>

      <div style={card}>
        <div style={{ fontSize: 15, fontWeight: 800, marginBottom: 8 }}>数据</div>
        <div style={{ fontSize: 12, color: 'var(--fg-muted)', marginBottom: 12 }}>
          导出 / 导入加密 .zcbak 备份在顶栏。重置会清空本地库并重新载入演示数据。
        </div>
        <div style={{ display: 'flex', gap: 8 }}>
          <button onClick={purgeOld} style={outline}>清理已确认的删除记录</button>
          <button onClick={() => setCleanupOpen(true)} disabled={backupBusy !== null} style={outline}>清理测试流水</button>
          <button onClick={() => setResetOpen(true)} style={{ ...outline, border: '1px solid var(--negative)', color: 'var(--negative)' }}>重置为演示数据</button>
        </div>
      </div>
      {pendingRestore && (
        <ConfirmDialog
          title={pendingRestore.mode === 'replace' ? '精确恢复账本' : '合并导入备份'}
          confirmLabel={pendingRestore.mode === 'replace' ? '精确恢复' : '合并导入'}
          cancelLabel="取消"
          busy={backupBusy === pendingRestore.entry.id}
          onCancel={() => setPendingRestore(null)}
          onConfirm={confirmRestore}
        >
          {pendingRestore.mode === 'replace'
            ? `将把当前活动账本精确恢复为“${pendingRestore.entry.label}”的状态，备份之外的数据会被标记删除并同步到其他设备。`
            : `将把“${pendingRestore.entry.label}”合并到当前账本，当前独有的数据会保留。`}
          导入前会再保存一份当前账本备份；预检结果为：{describePreflight(pendingRestore.entry.preflight)}。
        </ConfirmDialog>
      )}
      {pendingRemoteDelete && (
        <ConfirmDialog
          title="删除服务器备份"
          confirmLabel="移入回收区"
          cancelLabel="取消"
          tone="danger"
          busy={backupBusy === `remote-delete-${pendingRemoteDelete.backup.archiveId}`}
          onCancel={() => setPendingRemoteDelete(null)}
          onConfirm={confirmRemoteDelete}
        >
          将把“{pendingRemoteDelete.backup.label}”从 {pendingRemoteDelete.profile.alias} 的备份目录移除，
          密文对象先进入服务器回收区，等待延迟清理。
        </ConfirmDialog>
      )}
      {cleanupOpen && (
        <ConfirmDialog
          title="清理测试流水"
          confirmLabel="清理"
          cancelLabel="取消"
          busy={backupBusy === 'cleanup-test'}
          onCancel={() => setCleanupOpen(false)}
          onConfirm={cleanupTestTransactions}
        >
          将删除描述、商户或备注中包含“测试 / test”的日常流水，并同步删除对应拆分和附件。执行前会自动创建一份手动备份。
        </ConfirmDialog>
      )}
      {resetOpen && (
        <ConfirmDialog
          title="重置为演示数据"
          confirmLabel="重置"
          cancelLabel="取消"
          tone="danger"
          onCancel={() => setResetOpen(false)}
          onConfirm={resetData}
        >
          重置会清空当前浏览器本地数据库并重新载入演示账本。同库自动备份会一起删除，外部目录或桌面备份目录中的副本不受影响。
        </ConfirmDialog>
      )}
    </div>
  );
}

const outline = { padding: '8px 14px', borderRadius: 9, border: '1px solid var(--border)', background: 'var(--surface)', color: 'var(--fg-muted)', fontWeight: 700, fontSize: 13, cursor: 'pointer' } as const;
const primary = { padding: '8px 14px', borderRadius: 9, border: '1px solid var(--accent)', background: 'var(--accent)', color: '#fff', fontWeight: 700, fontSize: 13, cursor: 'pointer' } as const;

function HealthTile({ label, value, tone }: { label: string; value: string; tone: string }) {
  return (
    <div style={{ border: '1px solid var(--border)', borderRadius: 12, padding: 10, background: 'var(--surface-2)' }}>
      <div style={{ fontSize: 11, color: 'var(--fg-subtle)', fontWeight: 800 }}>{label}</div>
      <div style={{ fontSize: 12, color: tone, fontWeight: 900, marginTop: 5, lineHeight: 1.35 }}>{value}</div>
    </div>
  );
}
