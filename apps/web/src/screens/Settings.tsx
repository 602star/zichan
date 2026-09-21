import { accountSessionStorage } from '../account-storage.js';
import { useEffect, useState, type CSSProperties } from 'react';
import { checkConsistency, recomputeCaches, purgeTombstones, type ConsistencyIssue } from '@zichan/db';
import { type AsOfMode, type LotMethod, type Setting, localToday } from '@zichan/core';
import { useStore } from '../db/store.js';
import { useSnapshot } from '../db/snapshot.js';
import { baseAsset } from '../db/derive.js';
import { setBaseSymbol } from '../format.js';
import { btnDanger, btnOutline, btnPrimary, iconBtn, td as tdStyle, th as thStyle } from '../ui/styles.js';
import { ConfirmDialog } from '../ui/ConfirmDialog.js';
import { AS_OF_MODE_LABELS, asOfSummary, earliestRecordedDay, ledgerAsOf, needsAsOfAttention } from '../as-of.js';
import { draftSetting, saveLedgerSetting } from '../db/ledger-settings.js';
import { DeviceSecurityPanel } from '../ui/DeviceSecurityPanel.js';
import { LedgerProtectionPanel } from '../ui/LedgerProtectionPanel.js';
import { AccountSecurityPanel } from '../ui/AccountSecurityPanel.js';
import { accountProtection } from '../account-protection.js';
import { ACCENTS, DARK_ACCENTS, THEME_NAMES, THEME_MODE_NAMES, THEMES, type ThemeId, type ThemeMode, type ThemeModePreference } from '../theme.js';
import { PortableStoragePanel } from '../ui/PortableStoragePanel.js';
import { allCategories, categoryIsHidden } from '../transactionMeta.js';
import {
  optionalTransactionFields,
  transactionFormFieldOptions,
  transactionFormPresetKeys,
} from '../transactionFormPrefs.js';
import {
  BackupPassphraseRequiredError,
  describePreflight,
  configureExternalBackupDirectory,
  downloadBackup,
  externalBackupStatus,
  listSavedBackups,
  openVerifiedSavedBackup,
  prepareRemoteBackupForRestore,
  rehearseRestore,
  saveLedgerBackup,
  type ExternalBackupStatus,
  type ParsedEncryptedBackup,
  type SavedBackup,
} from '../db/backups.js';
import {
  listRemoteBackups,
  removeRemoteBackup,
  type RemoteBackupArchive,
} from '../remote-backup.js';
import { loadSyncConnections, type SyncConnection } from '../sync-config.js';
import {
  readSafetyState,
  safetyStateFromSetting,
  safetyStateFromStoredJson,
  safetyWarnings,
  serializeSharedSafetyState,
  successfulBackupSafetyPatch,
  writeSafetyState,
  type SafetyState,
} from '../db/safety.js';
import { moduleCurrencyId, moduleCurrencyPatch, type CurrencyModule } from '../currencyPreferences.js';
import { importPortableLedger } from '../db/portable-backup.js';
import { reconcileAttachmentStorage } from '../db/attachment-storage.js';
import { checkAllAttachmentFiles, cleanupAllTestTransactions } from '../db/settings-maintenance.js';
import { adoptUnlockedLedgerKeyEnvelope } from '../ledger-key-vault.js';
import {
  REQUIRED_NAVIGATION_IDS,
  defaultNavigationPreferences,
  moveNavigationItem,
  navigationLabel,
  orderedNavigationItems,
  parseNavigationPreferences,
  serializeNavigationPreferences,
  setNavigationItemVisible,
  type NavigationPreferences,
  type ScreenId,
} from '../navigationPreferences.js';

const METHODS: [LotMethod, string][] = [
  ['fifo', 'FIFO · 先进先出'], ['lifo', 'LIFO · 后进先出'], ['average', '平均成本'], ['manual', '手动选择批次'],
];
type SettingsTab = 'ledger' | 'account' | 'data' | 'appearance';
/*
 * Settings used to be 13 groups / 95 controls / 7.3 phone screens tall, with
 * one-time maintenance (security, backup, self-check) sitting at the same level
 * as everyday preferences. Three in-page tabs keep the first screen to the four
 * ledger groups and leave the rest one tap away.
 *
 * The selected tab is deliberately component-local state: it is a view concern,
 * so it stays out of the URL, the router, and the global store.
 */
const SETTINGS_TABS: [SettingsTab, string][] = [
  ['ledger', '记账'],
  ['account', '同步与账号'],
  ['data', '数据与安全'],
  ['appearance', '外观'],
];
type RemoteBackupRow = { profile: SyncConnection; backup: RemoteBackupArchive };
type BackupPasswordRequest =
  | { kind: 'local'; entry: SavedBackup; action: 'rehearse' | 'merge' | 'replace' }
  | { kind: 'remote'; row: RemoteBackupRow; action: 'rehearse' | 'merge' | 'replace' };
function todayDate(): string {
  return localToday();
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

function BrowserAccountExit({ onExit }: { onExit: () => Promise<void> }) {
  const [confirm, setConfirm] = useState(false);
  return <section className="zc-section" aria-label="账号与会话">
    <h2 className="zc-section-title">账号与会话</h2>
    <p className="zc-caption">退出会锁定本机账本，清除此标签页的同步凭据，并尝试撤销本站和附加服务器会话；未确认撤销会明确提示。不影响管理后台登录，不删除加密缓存和未同步记录。</p>
    <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
      <button onClick={() => setConfirm(true)} style={btnOutline}>退出记账账号</button>
    </div>
    {confirm && <ConfirmDialog title="退出记账账号" confirmLabel="确认退出" onCancel={() => setConfirm(false)} onConfirm={onExit}><p>退出前请确认重要记录已同步，或已导出加密备份。未同步数据会保留在本机；不要清除网站数据。</p></ConfirmDialog>}
  </section>;
}

export function Settings({ theme, mode, resolvedMode, setTheme, setMode }: {
  theme: ThemeId;
  /** What the reader asked for; `system` follows the operating system. */
  mode: ThemeModePreference;
  /** The mode actually in effect, so the copy can say what "跟随系统" resolved to. */
  resolvedMode: ThemeMode;
  setTheme: (theme: ThemeId) => void;
  setMode: (mode: ThemeModePreference) => void;
}) {
  const { store, bump, storageBackend, dataLocation, firstUseMode, browserStoragePersistent, resetLocalData, exitAccount } = useStore();
  const snap = useSnapshot('settings');
  const [tab, setTab] = useState<SettingsTab>('ledger');
  const [issues, setIssues] = useState<ConsistencyIssue[] | null>(null);
  const [lastCheck, setLastCheck] = useState<{ at: string; count: number } | null>(null);
  const [note, setNote] = useState('');
  const [backups, setBackups] = useState<SavedBackup[]>([]);
  const [backupFilter, setBackupFilter] = useState<'important' | 'all' | SavedBackup['reason']>('important');
  const [backupNote, setBackupNote] = useState('');
  const [backupBusy, setBackupBusy] = useState<string | null>(null);
  const [pendingRestore, setPendingRestore] = useState<{
    entry: SavedBackup;
    mode: 'replace' | 'merge';
    opened: ParsedEncryptedBackup;
  } | null>(null);
  const [remoteBackups, setRemoteBackups] = useState<RemoteBackupRow[]>([]);
  const [remoteLoaded, setRemoteLoaded] = useState(false);
  const [pendingRemoteDelete, setPendingRemoteDelete] = useState<{ profile: SyncConnection; backup: RemoteBackupArchive } | null>(null);
  const [backupPasswordRequest, setBackupPasswordRequest] = useState<BackupPasswordRequest | null>(null);
  const [backupPassphrase, setBackupPassphrase] = useState('');
  const [externalStatus, setExternalStatus] = useState<ExternalBackupStatus>({ kind: 'none', configured: false, label: '检测中…' });
  const [storageEstimate, setStorageEstimate] = useState<{ usage: number; quota: number } | null>(null);
  const [resetOpen, setResetOpen] = useState(false);
  const [cleanupOpen, setCleanupOpen] = useState(false);
  const [navigationBusy, setNavigationBusy] = useState(false);
  const [pendingAsOf, setPendingAsOf] = useState<{ date: string; warning: string } | null>(null);
  const [safetyState, setSafetyState] = useState(readSafetyState);
  const storedSafetyStateJson = snap?.setting?.dataSafetyStateJson;
  useEffect(() => {
    void listSavedBackups().then(setBackups);
    void externalBackupStatus().then(setExternalStatus).catch((error) => setExternalStatus({ kind: 'none', configured: false, label: error instanceof Error ? error.message : String(error) }));
    void navigator.storage?.estimate().then((estimate) => setStorageEstimate({ usage: estimate.usage ?? 0, quota: estimate.quota ?? 0 }));
  }, []);
  useEffect(() => {
    setSafetyState(safetyStateFromStoredJson(storedSafetyStateJson));
  }, [storedSafetyStateJson]);
  if (!snap) return null;
  const readySnap = snap;

  const setting = readySnap.setting;
  const base = baseAsset(readySnap);
  const ledgerMode = setting?.ledgerMode ?? 'spending';
  const navigation = parseNavigationPreferences(setting?.navigationLayoutJson);
  const cutoffState = ledgerAsOf(readySnap);

  async function saveSetting(
    patch: Partial<Setting>,
    options: { label?: string; undoable?: boolean } = {},
  ) {
    await saveLedgerSetting(
      store,
      setting,
      draftSetting(base?.id ?? readySnap.assets[0]?.id ?? '', todayDate()),
      patch,
      options.label ?? '保存应用设置',
      { undoable: options.undoable },
    );
    bump();
  }

  /**
   * The cut-off drives every report total, so the two values that quietly make
   * reports wrong — a future day, or a day before the earliest record — ask for
   * confirmation instead of applying straight away.
   */
  function changeAsOf(next: string) {
    if (!next || next === setting?.asOfDate) return;
    const earliest = earliestRecordedDay(readySnap);
    const warning = next > todayDate()
      ? `设为 ${next} 会把报表上限推到未来，报表将包含预记账的日期。`
      : earliest && next < earliest
        ? `设为 ${next} 会让 ${earliest} 及之后的流水全部退出报表，报表看起来会接近空白。`
        : '';
    if (warning) {
      setPendingAsOf({ date: next, warning });
      return;
    }
    void saveSetting({ asOfDate: next }, { label: '更新账本日' });
  }

  async function saveFormFields(keys: string[]) {
    await saveSetting({ transactionFormOptionalFields: keys.join(',') }, { label: '调整记账表单字段' });
  }

  async function saveNavigation(next: NavigationPreferences) {
    setNavigationBusy(true);
    try {
      await saveSetting(
        { navigationLayoutJson: serializeNavigationPreferences(next) },
        { label: '调整侧边栏模块' },
      );
    } finally {
      setNavigationBusy(false);
    }
  }

  function setNavigationVisible(id: ScreenId, visible: boolean) {
    void saveNavigation(setNavigationItemVisible(navigation, id, visible));
  }

  function moveNavigation(id: ScreenId, direction: -1 | 1) {
    void saveNavigation(moveNavigationItem(navigation, id, direction));
  }

  async function saveSafetyState(patch: Partial<SafetyState>) {
    const current = { ...safetyStateFromSetting(setting), ...safetyState };
    const next = { ...current, ...patch };
    if (serializeSharedSafetyState(current) !== serializeSharedSafetyState(next)) {
      await saveSetting(
        { dataSafetyStateJson: serializeSharedSafetyState(next) },
        { label: '更新数据安全状态', undoable: false },
      );
    }
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
      const profiles = loadSyncConnections().filter((profile) =>
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
    row: RemoteBackupRow,
    action: 'rehearse' | 'merge' | 'replace',
    passphrase?: string,
  ) {
    const busyId = `remote-${row.profile.id}-${row.backup.archiveId}`;
    setBackupBusy(busyId);
    try {
      const { entry, opened } = await prepareRemoteBackupForRestore(row.profile, row.backup, passphrase);
      if (action === 'rehearse') {
        const result = await rehearseRestore(opened.payload.ledger);
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
      const rehearsal = await rehearseRestore(opened.payload.ledger);
      if (!rehearsal.ok) {
        throw new Error(rehearsal.error ?? rehearsal.consistencyIssues.map((issue) => issue.detail).join('；'));
      }
      setPendingRestore({ entry, mode: action, opened });
    } catch (error) {
      if (error instanceof BackupPassphraseRequiredError) {
        setBackupPassphrase('');
        setBackupPasswordRequest({ kind: 'remote', row, action });
        return;
      }
      setBackupNote(`服务器备份校验失败：${error instanceof Error ? error.message : String(error)}`);
      if (passphrase) throw error;
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
      setPendingRemoteDelete(null);
    } catch (error) {
      setBackupNote(`删除服务器备份失败：${error instanceof Error ? error.message : String(error)}`);
      throw error;
    } finally {
      setBackupBusy(null);
    }
  }
  async function manualBackup() {
    setBackupBusy('manual');
    try {
      const entry = await saveLedgerBackup(store, 'manual');
      setBackupNote(`已创建：${entry.label} · ${describePreflight(entry.preflight)}${entry.externalSaved ? ` · 已写入 ${entry.externalPath}` : ` · 外部副本未写入：${entry.externalError}`}`);
      await saveSafetyState(successfulBackupSafetyPatch(entry));
      await refreshBackups();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      setBackupNote(`手动备份失败：${message}`);
      await saveSafetyState({ lastBackupError: message, lastBackupErrorAt: new Date().toISOString() });
    } finally {
      setBackupBusy(null);
    }
  }
  async function shareOrDownloadBackup(entry: SavedBackup) {
    const busyId = `download-${entry.id}`;
    setBackupBusy(busyId);
    try {
      const result = await downloadBackup(entry);
      if (result === 'shared') {
        setBackupNote('已打开系统分享面板，请选择保存位置或接收应用。');
      } else if (result === 'downloaded') {
        setBackupNote(storageBackend === 'native-sqlite'
          ? '已保存独立备份副本。请将其保存在另一块可信介质或安全位置。'
          : '已开始下载加密备份文件。');
      } else {
        setBackupNote('已取消分享 / 下载，原有本机备份未受影响。');
      }
    } catch (error) {
      setBackupNote(`分享 / 下载失败：${error instanceof Error ? error.message : String(error)}`);
    } finally {
      setBackupBusy(null);
    }
  }
  async function rehearse(entry: SavedBackup, passphrase?: string) {
    setBackupBusy(entry.id);
    try {
      const opened = await openVerifiedSavedBackup(entry, passphrase);
      const result = await rehearseRestore(opened.payload.ledger);
      await saveSafetyState({ lastRehearsalAt: new Date().toISOString(), lastRehearsalOk: result.ok, lastRehearsalLabel: entry.label });
      setBackupNote(result.ok
        ? `恢复演练通过：${describePreflight(result.preflight)}`
        : `恢复演练未通过：${result.error ?? result.consistencyIssues.map((i) => i.detail).join('；')}`);
    } catch (error) {
      if (error instanceof BackupPassphraseRequiredError) {
        setBackupPassphrase('');
        setBackupPasswordRequest({ kind: 'local', entry, action: 'rehearse' });
        return;
      }
      setBackupNote(`恢复演练失败：${error instanceof Error ? error.message : String(error)}`);
      if (passphrase) throw error;
    } finally {
      setBackupBusy(null);
    }
  }
  async function restore(entry: SavedBackup, mode: 'replace' | 'merge', passphrase?: string) {
    setBackupBusy(entry.id);
    try {
      const opened = await openVerifiedSavedBackup(entry, passphrase);
      const rehearsal = await rehearseRestore(opened.payload.ledger);
      if (!rehearsal.ok) {
        setBackupNote(`恢复演练未通过，已停止导入：${rehearsal.error ?? rehearsal.consistencyIssues.map((i) => i.detail).join('；')}`);
        await saveSafetyState({ lastRehearsalAt: new Date().toISOString(), lastRehearsalOk: false, lastRehearsalLabel: entry.label });
        return;
      }
      await saveSafetyState({ lastRehearsalAt: new Date().toISOString(), lastRehearsalOk: true, lastRehearsalLabel: entry.label });
      setPendingRestore({ entry, mode, opened });
    } catch (error) {
      if (error instanceof BackupPassphraseRequiredError) {
        setBackupPassphrase('');
        setBackupPasswordRequest({ kind: 'local', entry, action: mode });
        return;
      }
      setBackupNote(`备份恢复检查失败：${error instanceof Error ? error.message : String(error)}`);
      if (passphrase) throw error;
    } finally {
      setBackupBusy(null);
    }
  }
  async function chooseExternalDirectory() {
    setBackupBusy('external');
    try {
      const status = await configureExternalBackupDirectory();
      setExternalStatus(status);
      setBackupNote(`已选择外部备份目录：${status.label}`);
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
      await saveSafetyState({
        ...successfulBackupSafetyPatch(entry),
        lastCheckAt: new Date().toISOString(),
        lastCheckCount: next.length,
      });
      setBackupNote(`已完成安全检查：${entry.label} · 自检${next.length === 0 ? '通过' : `发现 ${next.length} 个问题`}`);
      await refreshBackups();
    } catch (error) {
      setBackupNote(`安全检查失败：${error instanceof Error ? error.message : String(error)}`);
    } finally {
      setBackupBusy(null);
    }
  }
  async function checkAttachmentFiles(): Promise<ConsistencyIssue[]> {
    return checkAllAttachmentFiles(store);
  }
  async function confirmRestore() {
    const pending = pendingRestore;
    if (!pending) return;
    const { entry, mode, opened } = pending;
    setBackupBusy(entry.id);
    let databaseCommitted = false;
    let requiresDeviceKey = false;
    let deviceKeyAdopted = false;
    try {
      const protection = await saveLedgerBackup(store, 'pre-import', '从备份恢复前');
      setSafetyState(writeSafetyState(successfulBackupSafetyPatch(protection)));
      const payload = opened.payload;
      const restoresDevice = !accountProtection() && mode === 'replace' && payload.kind === 'device' && payload.deviceState;
      requiresDeviceKey = Boolean(restoresDevice);
      const result = await importPortableLedger(store, payload.ledger, mode, {
        deviceState: restoresDevice ? payload.deviceState : undefined,
        onDatabaseCommitted: () => {
          databaseCommitted = true;
          if (restoresDevice) {
            adoptUnlockedLedgerKeyEnvelope(opened.container.keyEnvelope, opened.session, true);
            deviceKeyAdopted = true;
          }
        },
      });
      const removed = 'removed' in result ? Number(result.removed) : 0;
      setBackupNote(mode === 'replace'
        ? `精确恢复完成：恢复 ${result.entities} 条，移除 ${removed} 条备份外数据。`
        : `合并导入完成：处理 ${result.entities} 条数据。`);
      await refreshBackups();
      bump();
      setPendingRestore(null);
    } catch (error) {
      if (databaseCommitted) {
        const nextStep = requiresDeviceKey && !deviceKeyAdopted
          ? '备份账本密钥未能持久化，请停止继续记账，并使用刚创建的“从备份恢复前”保护归档恢复原账本。'
          : '请勿重复导入；完全退出后重新打开，应用会继续处理已提交的附件暂存。';
        setBackupNote(`账本数据已经提交，但恢复收尾未完成：${error instanceof Error ? error.message : String(error)}。${nextStep}`);
        setPendingRestore(null);
        bump();
        return;
      }
      setBackupNote(`恢复失败，当前账本保持不变：${error instanceof Error ? error.message : String(error)}`);
      throw error;
    } finally {
      setBackupBusy(null);
    }
  }
  async function submitBackupPassphrase() {
    const request = backupPasswordRequest;
    if (!request) return;
    if (backupPassphrase.length < 8) throw new Error('备份密码至少需要 8 个字符');
    if (request.kind === 'local') {
      if (request.action === 'rehearse') await rehearse(request.entry, backupPassphrase);
      else await restore(request.entry, request.action, backupPassphrase);
    } else {
      await prepareRemoteRestore(request.row, request.action, backupPassphrase);
    }
    setBackupPasswordRequest(null);
    setBackupPassphrase('');
  }
  async function resetData() {
    await resetLocalData();
  }
  async function cleanupTestTransactions() {
    setBackupBusy('cleanup-test');
    try {
      const protection = await saveLedgerBackup(store, 'manual', '清理测试流水前');
      setSafetyState(writeSafetyState(successfulBackupSafetyPatch(protection)));
      const cleaned = await cleanupAllTestTransactions(store);
      await reconcileAttachmentStorage(store);
      setBackupNote(`已作废 ${cleaned.transactions} 条测试流水、移除 ${cleaned.attachments} 个附件，并保留清理前备份。`);
      setCleanupOpen(false);
      await refreshBackups();
      bump();
    } catch (error) {
      setBackupNote(`清理测试流水失败：${error instanceof Error ? error.message : String(error)}`);
      throw error;
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
  const hasIndependentBackup = backups.some((backup) => backup.externalSaved) || Boolean(safetyState.lastExternalBackupAt);
  const usesAccounts = true;
  const formFields = new Set(optionalTransactionFields(setting, usesAccounts));
  const formFieldOptions = transactionFormFieldOptions(usesAccounts);
  const categoryCatalog = allCategories(readySnap.categories).filter((category) => category.parentId && category.isActive !== false);
  const frequentCategoryCount = categoryCatalog.filter((category) => !categoryIsHidden(category)).length;
  const hiddenCategoryCount = categoryCatalog.length - frequentCategoryCount;
  const openCategoryCenter = () => {
    try {
      accountSessionStorage.setItem('zichan.manage.target', JSON.stringify({ tab: 'transactionCategories', categoryMode: 'quick' }));
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
    <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--sp-4)', maxWidth: 980 }}>
      <div className="zc-tabs" role="tablist">
        {SETTINGS_TABS.map(([id, label]) => (
          <button
            key={id}
            type="button"
            role="tab"
            aria-selected={tab === id}
            className={tab === id ? 'zc-tab is-active' : 'zc-tab'}
            onClick={() => setTab(id)}
          >
            {label}
          </button>
        ))}
      </div>

      {tab === 'ledger' && (
        <>
          <div className="zc-card">
            <h2 className="zc-section-title">结算与偏好</h2>
            <div className="zc-settings-grid" style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 14, marginTop: 14 }}>
              <div className="zc-field">
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
                  <div key={module} className="zc-field">
                    <label className="zc-label">{label}</label>
                    <select aria-label={label} className="zc-select" value={fieldValue ?? ''} onChange={(e) => void onModuleCurrency(module, e.target.value)}>
                      <option value="">沿用全局 · {snap.assets.find((a) => a.id === moduleCurrencyId(setting, module))?.code ?? '未设置'}</option>
                      {snap.assets.filter((a) => !a.isDeleted).map((a) => <option key={a.id} value={a.id}>{a.code} · {a.name}</option>)}
                    </select>
                  </div>
                );
              })}
              <div className="zc-field">
                <label className="zc-label">默认卖出匹配方式</label>
                <select aria-label="默认卖出匹配方式" className="zc-select" value={setting?.defaultLotMethod ?? 'fifo'} onChange={(e) => saveSetting({ defaultLotMethod: e.target.value as LotMethod })}>
                  {METHODS.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
                </select>
              </div>
              {(['expense', 'income'] as const).map((direction) => <div className="zc-field" key={direction}>
                <label className="zc-label">{direction === 'expense' ? '支出默认账户' : '收入默认账户'}</label>
                <select className="zc-select" aria-label={direction === 'expense' ? '支出默认账户' : '收入默认账户'} value={(direction === 'expense' ? setting?.expenseDefaultAccountId : setting?.incomeDefaultAccountId) ?? ''} onChange={(e) => saveSetting(direction === 'expense' ? { expenseDefaultAccountId: e.target.value } : { incomeDefaultAccountId: e.target.value })}>
                  {snap.accounts.filter((a) => a.isActive !== false && a.kind !== 'other' && a.purpose !== (direction === 'expense' ? 'default_income' : 'default_expense')).map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}
                </select><p className="zc-meta">仅用于新的记录，已有记录保留原账户。全部功能均可使用。</p>
              </div>)}
              <div className="zc-field">
                <label className="zc-label">账本日 · 报表算到哪一天</label>
                <input
                  aria-label="账本日"
                  className="zc-input"
                  type="date"
                  value={setting?.asOfDate ?? todayDate()}
                  onChange={(e) => changeAsOf(e.target.value)}
                />
                <select
                  aria-label="账本日维护方式"
                  className="zc-select"
                  value={setting?.asOfMode ?? 'manual'}
                  onChange={(e) => void saveSetting({ asOfMode: e.target.value as AsOfMode }, { label: '调整账本日维护方式' })}
                  style={{ marginTop: 8 }}
                >
                  {AS_OF_MODE_LABELS.map(([value, label]) => <option key={value} value={value}>{label}</option>)}
                </select>
                {/*
                 * 「报表基准日」was a bare financial term with no explanation, and
                 * nothing on screen said it never advances on its own — so the ledger
                 * froze at sign-up and later records silently left every report.
                 */}
                <p className="zc-meta" style={{ marginTop: 6 }}>
                  报表、净资产估值、物品摊销和新建记录的默认日期都算到这一天为止。它不会自动变成今天——月结与对账需要固定截止日，所以只有在你确认时才会推进。
                </p>
                {cutoffState.mode !== 'manual' && (
                  <p className="zc-meta" style={{ marginTop: 4 }}>
                    {cutoffState.mode === 'auto_today'
                      ? '当前维护方式下，上面的日期已不再生效。'
                      : '当前维护方式下，上面的日期只在没有任何流水时作为兜底。'}
                  </p>
                )}
                <p className="zc-meta" style={{ marginTop: 4, color: needsAsOfAttention(cutoffState) ? 'var(--warning)' : undefined }}>
                  当前生效：{cutoffState.asOf} · {asOfSummary(cutoffState)}
                </p>
              </div>
              <div className="zc-field">
                <label className="zc-label">退款统计归属</label>
                <select aria-label="退款统计归属" className="zc-select" value={setting?.refundAttributionMode ?? 'original_date'} onChange={(e) => saveSetting({ refundAttributionMode: e.target.value as 'original_date' | 'refund_date' })}>
                  <option value="original_date">冲减原消费日期</option>
                  <option value="refund_date">计入实际退款日期</option>
                </select>
              </div>
            </div>
            {pendingAsOf && (
              <ConfirmDialog
                title="确认账本日"
                confirmLabel="仍然设置"
                cancelLabel="取消"
                tone="danger"
                onCancel={() => setPendingAsOf(null)}
                onConfirm={async () => {
                  await saveSetting({ asOfDate: pendingAsOf.date }, { label: '更新账本日' });
                  setPendingAsOf(null);
                }}
              >
                <p>{pendingAsOf.warning}</p>
              </ConfirmDialog>
            )}
            <p className="zc-meta" style={{ marginTop: 10 }}>
              模块币种只预填新记录，不改写历史币种或金额；新预算默认使用日常记账币种并在保存后冻结。退款默认回冲原消费与原预算，也可改为按退款到账日期统计。
            </p>
          </div>

          <div className="zc-card">
            <div className="zc-section-head zc-responsive-header">
              <div>
                <h2 className="zc-section-title">记账分类</h2>
                <p className="zc-meta" style={{ marginTop: 4 }}>高频 {frequentCategoryCount} 项 · 隐藏 {hiddenCategoryCount} 项</p>
              </div>
              <button type="button" onClick={openCategoryCenter} style={btnOutline}>进入分类中心</button>
            </div>
            <div className="zc-settings-category-grid" style={{ display: 'grid', gridTemplateColumns: 'minmax(180px, 320px) 1fr', gap: 14, alignItems: 'end', marginTop: 14 }}>
              <div className="zc-field">
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
              <p className="zc-caption">
                “仅高频”保持记账选择器简洁，搜索仍会匹配隐藏分类。新增、改名、隐藏和排序统一在分类中心处理。
              </p>
            </div>
          </div>

          <div className="zc-card">
            <h2 className="zc-section-title">常用附加字段</h2>
            <p className="zc-caption" style={{ marginTop: 6 }}>
              勾选的字段在新增记账时直接展开。其他字段可在更多信息中填写；编辑时已有内容会自动显示。账户、转账和退款必需信息由当前操作决定，无需在这里勾选。
            </p>
            <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', margin: '12px 0 10px' }}>
              {[
                ['仅核心', transactionFormPresetKeys('core', usesAccounts)],
                ['常用', transactionFormPresetKeys('common', usesAccounts)],
                ['完整', transactionFormPresetKeys('full', usesAccounts)],
              ].map(([label, keys]) => (
                <button key={String(label)} onClick={() => void saveFormFields(keys as string[])} style={btnOutline}>{String(label)}</button>
              ))}
            </div>
            <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
              {formFieldOptions.map(({ key, label }) => (
                <label key={key} style={{ display: 'inline-flex', alignItems: 'center', gap: 6, border: '1px solid var(--border)', borderRadius: 'var(--r-pill)', padding: '7px 11px', fontSize: 'var(--fs-caption)', fontWeight: 'var(--fw-medium)', color: 'var(--text-secondary)', background: formFields.has(key) ? 'var(--accent-soft)' : 'var(--surface-2)' }}>
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

          <div className="zc-card">
            <div className="zc-section-head zc-responsive-header">
              <div>
                <h2 className="zc-section-title">侧边栏与模块</h2>
                <p className="zc-meta" style={{ marginTop: 4 }}>
                  勾选的模块会按下方顺序直接显示在桌面和平板侧栏；手机底栏显示前 3 项，其余已启用项进入“更多”。隐藏入口不会删除模块数据。
                </p>
              </div>
              <button
                type="button"
                disabled={navigationBusy}
                onClick={() => void saveNavigation(defaultNavigationPreferences())}
                style={btnOutline}
              >
                恢复推荐布局
              </button>
            </div>
            <div className="zc-navigation-settings-list" style={{ display: 'grid', gap: 8, marginTop: 14 }}>
              {orderedNavigationItems(navigation, true).map((item, index, items) => {
                const required = REQUIRED_NAVIGATION_IDS.has(item.id);
                const visible = navigation.visible.includes(item.id);
                return (
                  <div
                    key={item.id}
                    className="zc-navigation-settings-row"
                    style={{ display: 'grid', gridTemplateColumns: 'minmax(0, 1fr) auto', alignItems: 'center', gap: 12, border: '1px solid var(--border)', borderRadius: 'var(--r-sm)', padding: '10px 12px', background: visible ? 'var(--surface)' : 'var(--surface-2)' }}
                  >
                    <label style={{ display: 'flex', alignItems: 'center', gap: 10, minWidth: 0, cursor: required ? 'default' : 'pointer' }}>
                      <input
                        type="checkbox"
                        aria-label={`在侧边栏显示${navigationLabel(item.id, ledgerMode)}`}
                        checked={visible}
                        disabled={required || navigationBusy}
                        onChange={(event) => setNavigationVisible(item.id, event.target.checked)}
                      />
                      <span style={{ width: 22, textAlign: 'center', color: 'var(--accent)', fontSize: 'var(--fs-title)' }}>{item.icon}</span>
                      <span style={{ minWidth: 0 }}>
                        <b style={{ display: 'block', fontSize: 'var(--fs-body)' }}>{navigationLabel(item.id, ledgerMode)}{required ? ' · 固定入口' : ''}</b>
                        <small className="zc-meta">{item.description}</small>
                      </span>
                    </label>
                    <div style={{ display: 'flex', gap: 6 }}>
                      <button type="button" aria-label={`上移${navigationLabel(item.id, ledgerMode)}`} disabled={navigationBusy || index === 0} onClick={() => moveNavigation(item.id, -1)} style={navigationOrderButton(!navigationBusy && index > 0)}>↑</button>
                      <button type="button" aria-label={`下移${navigationLabel(item.id, ledgerMode)}`} disabled={navigationBusy || index === items.length - 1} onClick={() => moveNavigation(item.id, 1)} style={navigationOrderButton(!navigationBusy && index < items.length - 1)}>↓</button>
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        </>
      )}

      {tab === 'account' && (
        <section className="zc-card" aria-label="账号与同步">
          <h2 className="zc-section-title">账号与同步</h2>
          <p className="zc-meta" style={{ marginTop: 6, marginBottom: 14 }}>
            登录、退出与同步服务器集中在这里。退出只锁定本机账本并撤销本站与附加服务器会话，不删除加密缓存、未同步记录或服务器副本。
          </p>
          {exitAccount && <BrowserAccountExit onExit={exitAccount} />}
          <section className="zc-section" aria-label="同步服务器连接">
            <h2 className="zc-section-title">同步服务器</h2>
            <p className="zc-caption">添加或编辑本机、局域网与公网服务器，分别登录后同步当前账本。这里配置的是用户同步连接，不是服务器管理后台。</p>
            <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
              <button onClick={() => window.dispatchEvent(new CustomEvent('zichan:navigate', { detail: { screen: 'sync' } }))} style={btnOutline}>管理同步服务器</button>
            </div>
          </section>
        </section>
      )}

      {tab === 'data' && (
        <>
          <DeviceSecurityPanel />
          <LedgerProtectionPanel store={store} />
          <AccountSecurityPanel onExit={exitAccount} />

          <PortableStoragePanel />

          <div className="zc-card">
            <section className="zc-section">
              <div className="zc-section-head zc-responsive-header">
                <div>
                  <h2 className="zc-section-title">备份与恢复</h2>
                  <p className="zc-meta" style={{ marginTop: 4 }}>自动备份按小时、日、周分层保留；手动和导入前备份固定保留。桌面端写入便携目录 data/backups，该目录随主数据一起移动，不属于独立副本。</p>
                </div>
                <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
                  <select aria-label="备份来源筛选" className="zc-select" value={backupFilter} onChange={(e) => setBackupFilter(e.target.value as typeof backupFilter)} style={{ width: 120 }}>
                    <option value="important">重点备份</option>
                    <option value="all">全部来源</option>
                    <option value="auto">自动</option>
                    <option value="manual">手动</option>
                    <option value="pre-import">导入前</option>
                  </select>
                  {externalStatus.kind !== 'portable' && <button onClick={chooseExternalDirectory} disabled={backupBusy !== null} style={btnOutline}>{externalStatus.configured ? '更换外部目录' : '选择外部目录'}</button>}
                  <button onClick={manualBackup} disabled={backupBusy !== null} style={btnPrimary}>创建手动备份</button>
                </div>
              </div>
              {warnings.length > 0 && (
                <div className="zc-section">
                  <div className="zc-section-head zc-responsive-header">
                    <div>
                      <h2 className="zc-section-title" style={{ color: warnings.some((w) => w.tone === 'danger') ? 'var(--negative)' : 'var(--accent)' }}>数据安全提醒</h2>
                      <p className="zc-caption">{warnings.map((w) => w.message).join('；')}</p>
                    </div>
                    <button onClick={quickSafetyCheck} disabled={backupBusy !== null} style={btnPrimary}>{backupBusy === 'safety' ? '检查中…' : '一键备份 + 自检'}</button>
                  </div>
                </div>
              )}
              {storageBackend !== 'native-sqlite' && firstUseMode === 'local' && (
                <div className="zc-section">
                  <h2 className="zc-section-title" style={{ color: hasIndependentBackup ? 'var(--positive)' : 'var(--negative)' }}>浏览器纯本地账本</h2>
                  <p className="zc-caption">
                    数据仅属于 Origin <code>{globalThis.location?.origin ?? '当前网站'}</code>；清理网站数据会删除账本，切换浏览器或 Origin 等同新设备。防自动清理保护：{browserStoragePersistent ? '已授予（不能防止手动清理）' : '未授予或未确认；普通本地存储仍可使用，请定期导出浏览器外备份'}。
                    {!hasIndependentBackup && ' 请先使用下方“分享 / 下载”把一份加密 .zcbak 保存到浏览器外；完成前此安全提醒不会消失。'}
                  </p>
                </div>
              )}
              {storageBackend !== 'native-sqlite' && firstUseMode === 'server' && !browserStoragePersistent && (
                <div className="zc-section">
                  <h2 className="zc-section-title" style={{ color: 'var(--accent)' }}>非持久本地缓存</h2>
                  <p className="zc-caption">
                    浏览器未保证保留当前 Origin 的 IndexedDB；服务器端加密副本是主要恢复来源。自动增量同步已默认开启，请保持至少一台服务器可用。
                  </p>
                </div>
              )}
              <div className="zc-settings-health-grid" style={{ display: 'grid', gridTemplateColumns: 'repeat(3, minmax(0, 1fr))', gap: 10 }}>
                <HealthTile label="最近备份" value={latestBackup ? new Date(latestBackup.createdAt).toLocaleString() : '暂无'} tone={latestBackup ? 'var(--positive)' : 'var(--negative)'} />
                <HealthTile label="自动备份" value={latestAuto ? new Date(latestAuto.createdAt).toLocaleString() : '暂无'} tone={latestAuto ? 'var(--positive)' : 'var(--fg-subtle)'} />
                <HealthTile label="最近演练" value={safetyState.lastRehearsalAt ? `${safetyState.lastRehearsalOk ? '通过' : '未通过'} · ${safetyState.lastRehearsalLabel ?? ''}` : '未运行'} tone={safetyState.lastRehearsalOk ? 'var(--positive)' : safetyState.lastRehearsalAt ? 'var(--negative)' : 'var(--fg-subtle)'} />
                <HealthTile label="备份数量" value={`${backups.length} 份`} tone={backups.length > 0 ? 'var(--positive)' : 'var(--fg-subtle)'} />
                <HealthTile label="独立副本最近成功" value={hasIndependentBackup ? (safetyState.lastExternalBackupAt ? new Date(safetyState.lastExternalBackupAt).toLocaleString() : '本次已写入') : '暂无'} tone={hasIndependentBackup ? 'var(--positive)' : 'var(--negative)'} />
                <HealthTile
                  label={storageBackend === 'native-sqlite' ? '原生存储' : '浏览器存储'}
                  value={storageBackend === 'native-sqlite' ? 'ledger.sqlite + 文件' : storageEstimate?.quota ? `${(storageEstimate.usage / 1024 / 1024).toFixed(1)} / ${(storageEstimate.quota / 1024 / 1024).toFixed(0)} MB` : '不可用'}
                  tone={storageBackend === 'native-sqlite' ? 'var(--positive)' : storageEstimate?.quota && storageEstimate.usage / storageEstimate.quota > 0.8 ? 'var(--negative)' : 'var(--fg-muted)'}
                />
              </div>
              <p className="zc-meta" style={{ overflowWrap: 'anywhere' }}>主数据位置：{dataLocation}</p>
              {externalStatus.kind === 'portable' && <p className="zc-meta" style={{ overflowWrap: 'anywhere' }}>便携本地备份：{externalStatus.label}。请启用同步服务器备份，或用“分享 / 下载”复制到其他磁盘。</p>}
              {backupNote && <p className="zc-caption" style={{ color: backupNote.includes('未通过') || backupNote.includes('失败') ? 'var(--negative)' : 'var(--positive)', fontWeight: 'var(--fw-bold)' }}>{backupNote}</p>}
              <div style={{ overflowX: 'auto' }}>
                <table style={{ width: '100%', borderCollapse: 'collapse' }}>
                  <thead>
                    <tr><th style={thStyle}>时间</th><th style={thStyle}>来源</th><th style={thStyle}>大小</th><th style={thStyle}>校验</th><th style={thStyle}>操作</th></tr>
                  </thead>
                  <tbody>
                    {visibleBackups.map((b) => (
                      <tr key={b.id}>
                        <td style={tdStyle}>
                          <div style={{ fontWeight: 'var(--fw-bold)' }}>{b.label}</div>
                          <div style={{ fontSize: 'var(--fs-meta)', color: 'var(--text-tertiary)', marginTop: 3 }}>{new Date(b.createdAt).toLocaleString()}</div>
                        </td>
                        <td style={tdStyle}>
                          <div>{reasonLabel(b.reason)} · {b.kind === 'device' ? '完整设备' : '可移植账本'} · {b.tier === 'pinned' ? '固定保留' : b.tier === 'hourly' ? '小时层' : b.tier === 'daily' ? '日层' : '周层'}</div>
                          <div style={{ fontSize: 'var(--fs-meta)', color: b.externalSaved ? 'var(--positive)' : 'var(--fg-subtle)', marginTop: 3 }}>{b.externalSaved ? '创建时已写入远端 / 外部副本' : storageBackend === 'native-sqlite' ? '便携目录内本地备份；远端副本见服务器列表' : '仅本机存储'}</div>
                        </td>
                        <td style={tdStyle}>{backupSize(b)}</td>
                        <td style={{ ...tdStyle, color: b.preflight.ok ? 'var(--positive)' : 'var(--negative)' }}>{describePreflight(b.preflight)}</td>
                        <td style={tdStyle}>
                          <div style={{ display: 'flex', gap: 7, flexWrap: 'wrap', justifyContent: 'flex-end' }}>
                            <button onClick={() => rehearse(b)} disabled={backupBusy !== null} style={btnOutline}>{backupBusy === b.id ? '演练中…' : '演练'}</button>
                            <button
                              type="button"
                              onClick={() => void shareOrDownloadBackup(b)}
                              disabled={backupBusy !== null}
                              style={btnOutline}
                            >
                              {backupBusy === `download-${b.id}` ? '保存中…' : storageBackend === 'native-sqlite' ? '另存为…' : '分享 / 下载'}
                            </button>
                            <button onClick={() => restore(b, 'merge')} disabled={backupBusy !== null} style={btnOutline}>合并</button>
                            <button onClick={() => restore(b, 'replace')} disabled={backupBusy !== null} style={{ ...btnOutline, border: '1px solid var(--accent)', color: 'var(--accent)' }}>精确恢复</button>
                          </div>
                        </td>
                      </tr>
                    ))}
                    {visibleBackups.length === 0 && <tr><td style={{ ...tdStyle, color: 'var(--text-tertiary)' }} colSpan={5}>{backups.length === 0 ? '还没有备份。保存任意数据后会自动创建，也可以手动创建。' : '当前筛选下没有备份。'}</td></tr>}
                  </tbody>
                </table>
              </div>
            </section>
            <section className="zc-section">
              <div className="zc-section-head zc-responsive-header">
                <div>
                  <h2 className="zc-section-title">同步服务器备份</h2>
                  <p className="zc-meta" style={{ marginTop: 4 }}>
                    服务器保存加密归档；托管服务器具备解密能力。恢复前会下载、校验分块和归档头，再使用本机账本密钥解密预检。
                  </p>
                </div>
                <button
                  onClick={refreshRemoteBackups}
                  disabled={backupBusy !== null}
                  style={btnOutline}
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
                            <div style={{ fontWeight: 'var(--fw-bold)' }}>{row.backup.label}</div>
                            <div style={{ fontSize: 'var(--fs-meta)', color: 'var(--text-tertiary)', marginTop: 3 }}>
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
                                style={btnOutline}
                              >
                                {backupBusy === busyId ? '校验中…' : '演练'}
                              </button>
                              <button onClick={() => void prepareRemoteRestore(row, 'merge')} disabled={backupBusy !== null} style={btnOutline}>合并</button>
                              <button
                                onClick={() => void prepareRemoteRestore(row, 'replace')}
                                disabled={backupBusy !== null}
                                style={{ ...btnOutline, border: '1px solid var(--accent)', color: 'var(--accent)' }}
                              >
                                精确恢复
                              </button>
                              <button
                                onClick={() => setPendingRemoteDelete(row)}
                                disabled={backupBusy !== null}
                                style={btnDanger}
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
                        <td style={{ ...tdStyle, color: 'var(--text-tertiary)' }} colSpan={5}>
                          {remoteLoaded ? '已连接的同步服务器上没有备份。' : '点击“刷新服务器备份”读取已连接服务器的恢复点。'}
                        </td>
                      </tr>
                    )}
                  </tbody>
                </table>
              </div>
            </section>

            <section className="zc-section">
              <div className="zc-section-head zc-responsive-header">
                <h2 className="zc-section-title">数据自检</h2>
                <div style={{ display: 'flex', gap: 8 }}>
                  <button onClick={runCheck} style={btnOutline}>运行自检</button>
                  <button onClick={runRecompute} style={btnPrimary}>重算缓存</button>
                </div>
              </div>
              {note && <p className="zc-caption" style={{ color: note.includes('失败') ? 'var(--negative)' : 'var(--positive)', fontWeight: 'var(--fw-medium)' }}>{note}</p>}
              {lastCheck && (
                <div className="zc-section-head zc-responsive-header">
                  <div>
                    <div className="zc-caption" style={{ fontWeight: 'var(--fw-bold)' }}>{lastCheck.count === 0 ? '自检通过' : `发现 ${lastCheck.count} 个问题`}</div>
                    <p className="zc-meta">最近检查：{new Date(lastCheck.at).toLocaleString()}</p>
                  </div>
                  <span style={{ color: lastCheck.count === 0 ? 'var(--positive)' : 'var(--negative)', fontSize: 'var(--fs-heading)', fontWeight: 'var(--fw-bold)' }}>{lastCheck.count === 0 ? '✓' : '!'}</span>
                </div>
              )}
              {issues !== null && (
                issues.length === 0
                  ? <p className="zc-caption" style={{ color: 'var(--positive)', fontWeight: 'var(--fw-medium)' }}>✓ 未发现不一致</p>
                  : (
                    <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
                      {issueGroups.map(([kind, rows]) => (
                        <div key={kind} className="zc-section">
                          <div>
                            <p className="zc-caption" style={{ color: 'var(--negative)', fontWeight: 'var(--fw-bold)' }}>{ISSUE_LABELS[kind] ?? kind} · {rows.length} 条</p>
                            {kind === 'chain_cache_stale' && <p className="zc-meta">建议先点击“重算缓存”。</p>}
                          </div>
                          {rows.map((i, k) => (
                            <div key={`${i.entityId}-${k}`} className="zc-caption">
                              {i.entityType} {i.entityId.slice(0, 8)} — {i.detail}
                            </div>
                          ))}
                        </div>
                      ))}
                    </div>
                  )
              )}
            </section>

            <section className="zc-section">
              <h2 className="zc-section-title">数据</h2>
              <p className="zc-caption">
                导出 / 导入加密 .zcbak 备份在顶栏。重置会清空本机数据并返回首次设置，可重新选择空账本、导入备份或演示账本。
              </p>
              <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                <button onClick={purgeOld} style={btnOutline}>清理已确认的删除记录</button>
                <button onClick={() => setCleanupOpen(true)} disabled={backupBusy !== null} style={btnOutline}>清理测试流水</button>
                <button onClick={() => setResetOpen(true)} style={btnDanger}>重置本机账本</button>
              </div>
            </section>
          </div>
        </>
      )}
      {backupPasswordRequest && (
        <ConfirmDialog
          title="解锁旧备份"
          confirmLabel="解锁并继续"
          cancelLabel="取消"
          busy={backupBusy !== null}
          onCancel={() => { setBackupPasswordRequest(null); setBackupPassphrase(''); }}
          onConfirm={submitBackupPassphrase}
        >
          <div>
            这份备份使用的密钥代次与当前会话不同。请输入创建该备份时使用的账本密码；这里只解锁归档，不会修改当前账本密码。
          </div>
          <input
            autoFocus
            aria-label="旧备份账本密码"
            className="zc-input"
            type="password"
            autoComplete="off"
            value={backupPassphrase}
            onChange={(event) => setBackupPassphrase(event.target.value)}
            style={{ marginTop: 12 }}
          />
        </ConfirmDialog>
      )}
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
          将作废描述、商户或备注中包含“测试 / test”的有效日常流水，并移除其附件。拆分保留在作废记录中供审计与恢复，不再进入有效报表。执行前会自动创建一份手动备份。
        </ConfirmDialog>
      )}
      {resetOpen && (
        <ConfirmDialog
          title="重置本机账本"
          confirmLabel="重置"
          cancelLabel="取消"
          tone="danger"
          onCancel={() => setResetOpen(false)}
          onConfirm={resetData}
        >
          {storageBackend === 'native-sqlite'
            ? '重置会关闭当前数据库，并清空本机账本、附件、表单草稿、账本密钥、Stronghold 凭据和同步配置。便携 data/backups 中的旧归档会保留，恢复时需要创建归档时的原密码；服务器副本不受影响。'
            : '重置会关闭当前数据库，并清空本机账本、附件、表单草稿、浏览器内备份、账本密钥和同步配置；外部目录或服务器副本不受影响。'}
          重新打开后需要再次设置账本密码，并从“空账本 / 导入备份 / 体验演示”中选择。
        </ConfirmDialog>
      )}

      {tab === 'appearance' && (
        <section className="zc-section" aria-label="视觉方案">
          <h2 className="zc-section-title">视觉方案</h2>
          <p className="zc-caption">切换配色与明暗。只影响本机显示，不改变账本数据、同步内容或其它设备上的外观。移动端抽屉不再单独提供入口。</p>
          <div role="radiogroup" aria-label="视觉方案" style={{ display: 'flex', flexWrap: 'wrap', gap: 10, marginTop: 12 }}>
            {(Object.keys(THEMES) as ThemeId[]).map((id) => (
              <button
                key={id}
                type="button"
                role="radio"
                aria-checked={theme === id}
                onClick={() => setTheme(id)}
                style={{
                  flex: '1 1 168px',
                  display: 'flex',
                  alignItems: 'center',
                  gap: 10,
                  minHeight: 'var(--control-h)',
                  padding: '0 14px',
                  borderRadius: 'var(--r-sm)',
                  cursor: 'pointer',
                  background: 'var(--surface-2)',
                  border: theme === id ? '2px solid var(--accent)' : '1px solid var(--border)',
                  color: 'var(--text-primary)',
                  fontWeight: 'var(--fw-medium)',
                }}
              >
                {/* The swatch shows the accent of the mode in effect, so picking a
                    family does not preview a colour the reader will never see. */}
                <span aria-hidden="true" style={{ width: 18, height: 18, borderRadius: 'var(--r-round)', background: resolvedMode === 'dark' ? DARK_ACCENTS[id] : ACCENTS[id] }} />
                {THEME_NAMES[id]}
              </button>
            ))}
          </div>
          <h2 className="zc-section-title" style={{ marginTop: 22 }}>明暗</h2>
          <p className="zc-caption">
            默认跟随系统。选择「跟随系统」时，系统切换深浅色会立即生效，无需重新打开页面。
            {mode === 'system' ? `当前系统为${resolvedMode === 'dark' ? '深色' : '浅色'}。` : ''}
          </p>
          <div role="radiogroup" aria-label="明暗" style={{ display: 'flex', flexWrap: 'wrap', gap: 10, marginTop: 12 }}>
            {(['system', 'light', 'dark'] as ThemeModePreference[]).map((option) => (
              <button
                key={option}
                type="button"
                role="radio"
                aria-checked={mode === option}
                onClick={() => setMode(option)}
                style={{
                  flex: '1 1 148px',
                  display: 'flex',
                  alignItems: 'center',
                  gap: 10,
                  minHeight: 'var(--control-h)',
                  padding: '0 14px',
                  borderRadius: 'var(--r-sm)',
                  cursor: 'pointer',
                  background: 'var(--surface-2)',
                  border: mode === option ? '2px solid var(--accent)' : '1px solid var(--border)',
                  color: 'var(--text-primary)',
                  fontWeight: 'var(--fw-medium)',
                }}
              >
                <span aria-hidden="true" style={{ width: 18, height: 18, borderRadius: 'var(--r-round)', border: '1px solid var(--border-strong)', background: option === 'dark' ? 'var(--fg)' : option === 'light' ? 'var(--surface)' : 'linear-gradient(120deg, var(--surface) 0 50%, var(--fg) 50% 100%)' }} />
                {THEME_MODE_NAMES[option]}
              </button>
            ))}
          </div>
        </section>
      )}
    </div>
  );
}

/* Row-order arrows build on the shared icon button instead of a local copy. */
const navigationOrderButton = (enabled: boolean): CSSProperties => ({
  ...iconBtn,
  color: enabled ? 'var(--fg-muted)' : 'var(--fg-subtle)',
  cursor: enabled ? 'pointer' : 'not-allowed',
  opacity: enabled ? 1 : 0.45,
});

/* A stat tile in the backup-health strip: tinted, not another bordered surface. */
function HealthTile({ label, value, tone }: { label: string; value: string; tone: string }) {
  return (
    <div style={{ background: 'var(--surface-2)', borderRadius: 'var(--r-sm)', padding: 10 }}>
      <div className="zc-meta" style={{ fontWeight: 'var(--fw-bold)' }}>{label}</div>
      <div className="zc-caption" style={{ color: tone, fontWeight: 'var(--fw-bold)', marginTop: 5 }}>{value}</div>
    </div>
  );
}
