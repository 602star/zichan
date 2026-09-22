import { accountSessionStorage } from './account-storage.js';
import { lazy, Suspense, useEffect, useId, useMemo, useRef, useState, type ChangeEvent, type CSSProperties } from 'react';
import type { LedgerBackup } from '@zichan/db';
import { type LedgerMode, localToday } from '@zichan/core';
import { useStore } from './db/store.js';
import { loadSnapshot, useSnapshot, type Snapshot } from './db/snapshot.js';
import { baseAsset } from './db/derive.js';
import { setBaseSymbol } from './format.js';
import { FONT_FAMILY, type ThemeId, type ThemeModePreference } from './theme.js';
import {
  appearanceTokens,
  applyBrowserChrome,
  applyThemeTokens,
  readAppearancePreference,
  resolveThemeMode,
  subscribeSystemMode,
  systemPrefersDark,
  writeAppearancePreference,
} from './appearance.js';
import { PlusIcon } from './ui/PlusIcon.js';
import {
  BackupPassphraseRequiredError,
  describePreflight,
  downloadBackup,
  listSavedBackups,
  parseEncryptedBackup,
  rehearseRestore,
  saveLedgerBackup,
  type ParsedEncryptedBackup,
  type SavedBackup,
} from './db/backups.js';
import {
  safetyStateFromSetting,
  safetyWarnings,
  successfulBackupSafetyPatch,
  writeSafetyState,
} from './db/safety.js';
import { ConfirmDialog } from './ui/ConfirmDialog.js';
import { ledgerAsOf } from './as-of.js';
import { AppSecurityGate } from './ui/AppSecurityGate.js';
import { runSynchronousFlight, VaultUnlockPrompt } from './ui/VaultUnlockPrompt.js';
import { DialogShell } from './ui/DialogShell.js';
import { installSyncLifecycle } from './background-sync.js';
import { connectionLinkFromLocation } from './connection-link.js';
import {
  exportPortableLedger,
  importPortableLedger,
  preflightPortableBackup,
} from './db/portable-backup.js';
import { adoptUnlockedLedgerKeyEnvelope, runtimeLedgerCryptoSession } from './ledger-key-vault.js';
import { accountProtection } from './account-protection.js';
import { isTauriRuntime } from './tauri.js';
import {
  NAVIGATION_ITEMS,
  navigationLabel,
  orderedNavigationItems,
  parseNavigationPreferences,
  serializeNavigationPreferences,
  setNavigationItemVisible,
  type NavigationPreferences,
  type ScreenId,
} from './navigationPreferences.js';

const Dashboard = lazy(() => import('./screens/Dashboard.js').then((module) => ({ default: module.Dashboard })));
const Convert = lazy(() => import('./screens/Convert.js').then((module) => ({ default: module.Convert })));
const Game = lazy(() => import('./screens/Game.js').then((module) => ({ default: module.Game })));
const Fixed = lazy(() => import('./screens/Fixed.js').then((module) => ({ default: module.Fixed })));
const Reports = lazy(() => import('./screens/Reports.js').then((module) => ({ default: module.Reports })));
const Manage = lazy(() => import('./screens/Manage.js').then((module) => ({ default: module.Manage })));
const Transactions = lazy(() => import('./screens/Transactions.js').then((module) => ({ default: module.Transactions })));
const Settings = lazy(() => import('./screens/Settings.js').then((module) => ({ default: module.Settings })));
const Sync = lazy(() => import('./screens/Sync.js').then((module) => ({ default: module.Sync })));
const History = lazy(() => import('./screens/History.js').then((module) => ({ default: module.History })));

const ACTIVE_SCREEN_KEY = 'zichan.activeScreen';
const RETRY_SCREEN_KEY = 'zichan.retryScreen';
const SCREEN_IDS = new Set<ScreenId>(NAVIGATION_ITEMS.map((item) => item.id));

/**
 * Screens a preview must never open.
 *
 * 同步 and 设置 describe the device the page runs on: saved connections, backup files, storage
 * quota. Against someone else's ledger those readings are not merely unhelpful, they are wrong
 * about the user — "还没有本地备份" is a claim about their data based on the operator's machine.
 * The preview therefore offers the ledger screens and says so; it does not fake device facts.
 */
export const PREVIEW_HIDDEN_SCREENS: readonly ScreenId[] = ['sync', 'settings'];

/** Redirect a screen the preview cannot honestly show, so a deep link lands somewhere real. */
export function clampPreviewScreen(screen: ScreenId): ScreenId {
  return PREVIEW_HIDDEN_SCREENS.includes(screen) ? 'dashboard' : screen;
}

/** The navigation a preview offers: the ledger's own order, minus the device-only screens. */
export function previewNavigation(preferences: NavigationPreferences): NavigationPreferences {
  return {
    order: preferences.order,
    visible: preferences.visible.filter((id) => !PREVIEW_HIDDEN_SCREENS.includes(id)),
  };
}

function initialScreen(preview: boolean): ScreenId {
  try {
    // A preview reads no session state: those keys belong to the operator's own ledger session,
    // and consuming them here would consume them for the ledger app they came back to.
    if (preview) return 'dashboard';
    if (connectionLinkFromLocation()) return 'sync';
    if (['quick-expense', 'account-setup'].includes(accountSessionStorage.getItem('zichan.postFirstRun') ?? '')) return 'transactions';
    const stored = accountSessionStorage.getItem(RETRY_SCREEN_KEY);
    accountSessionStorage.removeItem(RETRY_SCREEN_KEY);
    if (stored && SCREEN_IDS.has(stored as ScreenId)) return stored as ScreenId;
    const active = accountSessionStorage.getItem(ACTIVE_SCREEN_KEY);
    return active && SCREEN_IDS.has(active as ScreenId) ? active as ScreenId : 'dashboard';
  } catch {
    return 'dashboard';
  }
}

const META: Record<ScreenId, [string, string]> = {
  dashboard: ['总览', '净资产、配置与近期动态一览'],
  convert: ['资产转换', '多步换汇链路 · 汇率与手续费全程可追溯'],
  transactions: ['日常收支', '工资、房租、餐饮、购物与现金流'],
  game: ['游戏赛季', '按赛季与账号记录投入 · 产出 · 回收'],
  fixed: ['物品资产', '使用成本 · 耗材 · 保修 · 生命周期'],
  reports: ['报表', '跨模块的成本与盈亏报表'],
  history: ['操作历史', '改前改后 · 批量操作 · 冲突解决记录'],
  manage: ['管理', '资产 · 分类 · 商户 · 价格'],
  sync: ['同步', '账号同步 · 加密数据与冲突处理'],
  settings: ['设置', '记账模式 · 数据自检 · 备份'],
};

function formatAsOfDate(date?: string): string {
  const fallback = localToday();
  const value = date || fallback;
  const [y, m, d] = value.split('-');
  return [y, m, d].filter(Boolean).join(' · ');
}

const ghostBtn = btnGhost;

type ImportDialog =
  | { kind: 'password'; file: File }
  | { kind: 'confirm'; opened: ParsedEncryptedBackup; mode: 'merge' | 'replace'; summary: string; warnings: string[]; diff: ImportDiff }
  | { kind: 'notice'; title: string; message: string; tone?: 'normal' | 'danger' };

interface ImportDiff {
  added: number;
  updated: number;
  unchanged: number;
  byType: { label: string; added: number; updated: number; unchanged: number }[];
  examples: { label: string; name: string; fields: string[] }[];
}

const TECHNICAL_IMPORT_KEYS = new Set(['id', 'createdAt', 'updatedAt', 'version', 'isDeleted']);
const IMPORT_FIELD_LABELS: Record<string, string> = {
  name: '名称',
  code: '代码',
  type: '类型',
  category: '分类',
  amount: '金额',
  assetId: '资产',
  accountId: '账户',
  date: '日期',
  time: '时间',
  timezone: '时区',
  payeeId: '商户',
  merchant: '商户文本',
  description: '描述',
  note: '备注',
  tagIds: '标签',
  locationId: '地点',
  locationName: '地点文本',
  latitude: '纬度',
  longitude: '经度',
  locationAccuracyMeters: '定位精度（米）',
  transactionFormOptionalFields: '记账表单字段',
  categoryPickerDefaultScope: '记账分类默认范围',
  refundAttributionMode: '退款统计归属',
  refundForId: '关联原支出',
  refundAppliedAmount: '冲减原支出金额',
  refundAppliedAssetId: '冲减币种',
  recordState: '记录状态',
  voidedAt: '作废时间',
  voidReason: '作废原因',
  dataSafetyStateJson: '数据安全状态',
};

function idOf(row: unknown): string | undefined {
  return row && typeof row === 'object' && !Array.isArray(row) && typeof (row as { id?: unknown }).id === 'string'
    ? (row as { id: string }).id
    : undefined;
}

function businessRow(row: unknown): Record<string, unknown> {
  if (!row || typeof row !== 'object' || Array.isArray(row)) return {};
  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(row)) {
    if (!TECHNICAL_IMPORT_KEYS.has(key)) result[key] = value;
  }
  return result;
}

function sameValue(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

function changedBusinessFields(a: unknown, b: unknown): string[] {
  const left = businessRow(a);
  const right = businessRow(b);
  return [...new Set([...Object.keys(left), ...Object.keys(right)])]
    .sort()
    .filter((key) => !sameValue(left[key], right[key]));
}

function importRowTitle(row: unknown): string {
  if (!row || typeof row !== 'object' || Array.isArray(row)) return '未知记录';
  const r = row as Record<string, unknown>;
  const value = r.name ?? r.title ?? r.description ?? r.merchant ?? r.code ?? r.id;
  return value ? String(value) : '未知记录';
}

function importFieldLabel(key: string): string {
  return IMPORT_FIELD_LABELS[key] ?? key;
}

function importDiff(backup: LedgerBackup, snap: Snapshot | null): ImportDiff {
  const collections: { label: string; local: unknown[]; incoming: unknown[] }[] = [
    { label: '资产', local: snap?.assets ?? [], incoming: backup.assets },
    { label: '账户', local: snap?.accounts ?? [], incoming: backup.accounts },
    { label: '设置', local: snap?.setting ? [snap.setting] : [], incoming: backup.settings },
    { label: '资产转换', local: snap?.chains.map((c) => c.chain) ?? [], incoming: backup.chains.map((c) => c.chain) },
    { label: '转换步骤', local: snap?.chains.flatMap((c) => c.steps) ?? [], incoming: backup.chains.flatMap((c) => c.steps) },
    { label: '持仓批次', local: snap?.lots ?? [], incoming: backup.lots },
    { label: '价格', local: snap?.priceMarks ?? [], incoming: backup.priceMarks },
    { label: '定投', local: [...(snap?.dcaPlans ?? []), ...(snap?.dcaExecutions ?? [])], incoming: [...backup.dcaPlans, ...backup.dcaExecutions] },
    { label: '游戏', local: [...(snap?.games ?? []), ...(snap?.gameAccounts ?? []), ...(snap?.seasons ?? []), ...(snap?.gameRecords ?? [])], incoming: [...backup.games, ...backup.gameAccounts, ...backup.gameSeasons, ...backup.gameRecords] },
    { label: '物品资产', local: [...(snap?.fixedAssets ?? []), ...(snap?.fixedAssetCategories ?? []), ...(snap?.fixedEvents ?? []), ...(snap?.fixedUsageMetrics ?? []), ...(snap?.fixedUsageLogs ?? []), ...(snap?.fixedConsumables ?? []), ...(snap?.fixedGoals ?? [])], incoming: [...backup.fixedAssets, ...backup.fixedAssetCategories, ...backup.fixedAssetEvents, ...backup.fixedAssetUsageMetrics, ...backup.fixedAssetUsageLogs, ...backup.fixedAssetConsumables, ...backup.fixedAssetGoals] },
    { label: '日常收支', local: [...(snap?.categories ?? []), ...(snap?.payees ?? []), ...(snap?.transactions ?? []), ...(snap?.transactionSplits ?? []), ...(snap?.budgetCategories ?? []), ...(snap?.scheduledTransactions ?? []), ...(snap?.reconciliationSessions ?? [])], incoming: [...backup.categories, ...backup.payees, ...backup.transactions, ...backup.transactionSplits, ...backup.budgetCategories, ...backup.scheduledTransactions, ...backup.reconciliationSessions] },
    { label: '标签/地点/模板', local: [...(snap?.transactionTags ?? []), ...(snap?.transactionLocations ?? []), ...(snap?.transactionTemplates ?? []), ...(snap?.transactionSavedViews ?? [])], incoming: [...backup.transactionTags, ...backup.transactionLocations, ...backup.transactionTemplates, ...backup.transactionSavedViews] },
    { label: '附件', local: snap?.attachments ?? [], incoming: backup.attachments },
  ];
  const examples: ImportDiff['examples'] = [];
  const byType = collections.map(({ label, local, incoming }) => {
    const localById = new Map(local.map((row) => [idOf(row), row]).filter((entry): entry is [string, unknown] => !!entry[0]));
    let added = 0;
    let updated = 0;
    let unchanged = 0;
    for (const row of incoming) {
      const id = idOf(row);
      const current = id ? localById.get(id) : undefined;
      if (!current) added += 1;
      else {
        const fields = changedBusinessFields(current, row);
        if (fields.length === 0) unchanged += 1;
        else {
          updated += 1;
          if (examples.length < 8) {
            examples.push({ label, name: importRowTitle(row), fields: fields.map(importFieldLabel) });
          }
        }
      }
    }
    return { label, added, updated, unchanged };
  }).filter((row) => row.added || row.updated || row.unchanged);
  return byType.reduce<ImportDiff>((acc, row) => ({
    added: acc.added + row.added,
    updated: acc.updated + row.updated,
    unchanged: acc.unchanged + row.unchanged,
    byType: [...acc.byType, row],
    examples,
  }), { added: 0, updated: 0, unchanged: 0, byType: [], examples });
}

export function App() {
  const { store, bump, storageBackend, dataLocation, preview } = useStore();
  const snap = useSnapshot('shell');
  const [screen, setScreen] = useState<ScreenId>(() => initialScreen(Boolean(preview)));
  // Appearance is a device preference, not ledger data: it is read from local
  // storage once and written back on change, never synced or exported.
  const [appearance, setAppearance] = useState(readAppearancePreference);
  const theme = appearance.theme;
  // `system` resolves against the OS now, and re-resolves when it changes: a
  // reader on "follow the system" must not have to reload at sunset.
  const [prefersDark, setPrefersDark] = useState(systemPrefersDark);
  const themeMode = resolveThemeMode(appearance.mode, prefersDark);
  useEffect(() => subscribeSystemMode(() => setPrefersDark(systemPrefersDark())), []);
  /*
   * Painted on <html>, not on the app shell. The shell cannot reach the error
   * boundary (a sibling, not a descendant), the pre-login gates, or the area
   * below a short page; all of those are visible with the palette applied and
   * would otherwise stay cream on a dark screen.
   */
  useEffect(() => {
    const tokens = appearanceTokens(theme, themeMode);
    const restore = applyThemeTokens(document.documentElement, tokens, themeMode);
    applyBrowserChrome(tokens);
    return restore;
  }, [theme, themeMode]);
  const [importDialog, setImportDialog] = useState<ImportDialog | null>(null);
  const [importBusy, setImportBusy] = useState(false);
  const [importPassphrase, setImportPassphrase] = useState('');
  const [importUnlockError, setImportUnlockError] = useState('');
  const [backups, setBackups] = useState<SavedBackup[]>([]);
  const [mobileMoreOpen, setMobileMoreOpen] = useState(false);
  const [enablingModule, setEnablingModule] = useState<ScreenId | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const importUnlockFlight = useRef<Promise<void> | null>(null);
  const bumpRef = useRef(bump);
  bumpRef.current = bump;

  // keep the money symbol in sync with the settlement currency
  const base = snap ? baseAsset(snap) : undefined;
  const ledgerMode: LedgerMode = snap?.setting?.ledgerMode ?? 'spending';
  const navigation = parseNavigationPreferences(snap?.setting?.navigationLayoutJson);
  const effectiveNavigation = useMemo(
    () => (preview ? previewNavigation(navigation) : navigation),
    [preview, navigation],
  );
  // A stored `screen` can point at 同步/设置 — from a previous session, or from the operator's own
  // ledger before this preview opened. Those screens describe this device, so the preview sends
  // them to the dashboard rather than reporting the wrong machine's state as the user's.
  useEffect(() => {
    if (preview) setScreen((current) => clampPreviewScreen(current));
  }, [preview]);
  useEffect(() => {
    if (base) setBaseSymbol(base.symbol ?? `${base.code} `);
  }, [base]);

  useEffect(() => {
    const onNavigate = (event: Event) => {
      const detail = (event as CustomEvent<{ screen?: ScreenId }>).detail;
      if (detail?.screen) setScreen(detail.screen);
    };
    window.addEventListener('zichan:navigate', onNavigate);
    return () => window.removeEventListener('zichan:navigate', onNavigate);
  }, []);

  useEffect(() => {
    try {
      accountSessionStorage.setItem(ACTIVE_SCREEN_KEY, screen);
    } catch {
      // Session storage can be unavailable in hardened browser contexts.
    }
  }, [screen]);

  useEffect(() => {
    // The saved-backup list lives in this device's storage. In a preview it would describe the
    // administrator's own backups while the page shows someone else's ledger, which reads as
    // "this ledger has no backups" — a false statement about the user's data.
    if (preview) return;
    const refreshSafety = () => {
      void listSavedBackups().then(setBackups);
    };
    refreshSafety();
    window.addEventListener('zichan:safety-updated', refreshSafety);
    return () => window.removeEventListener('zichan:safety-updated', refreshSafety);
  }, [preview]);

  // A preview is a read-only copy of somebody else's ledger: installing the sync lifecycle
  // would try to push the administrator's session at the user's account and reconcile replicas
  // that do not exist here. It is not merely useless, it is an attempt to write.
  useEffect(() => {
    if (preview) return;
    return installSyncLifecycle(store, () => bumpRef.current());
  }, [store, preview]);

  async function enableModule(id: ScreenId) {
    const current = snap?.setting;
    if (!current) return;
    setEnablingModule(id);
    try {
      const next = setNavigationItemVisible(navigation, id, true);
      await store.runInAuditBatch(
        '启用侧边栏模块',
        async (transactionStore) => {
          const stored = await transactionStore.settings.get(current.id);
          await transactionStore.settings.put({
            ...(stored ?? current),
            navigationLayoutJson: serializeNavigationPreferences(next),
          });
        },
        'system',
      );
      bump();
    } finally {
      setEnablingModule(null);
    }
  }

  async function doExport() {
    // The portable desktop cannot reliably download a Blob from WebView2.  Write
    // the archive through the native backup path first so downloadBackup can
    // open the native Save As dialog for the resulting nativeFileName.
    if (isTauriRuntime()) {
      await downloadBackup(await saveLedgerBackup(store, 'manual', '即时导出', 'portable'));
      return;
    }
    const backup = await exportPortableLedger(store);
    await downloadBackup({ backup, createdAt: new Date().toISOString(), label: '即时导出' });
  }

  async function prepareImportedBackup(opened: ParsedEncryptedBackup) {
    const data = opened.payload.ledger;
    const preflight = await preflightPortableBackup(data);
    if (!preflight.ok) {
      setImportDialog({
        kind: 'notice',
        title: '导入预检失败',
        tone: 'danger',
        message: preflight.issues.filter((i) => i.level === 'error').map((i) => `- ${i.message}`).join('\n'),
      });
      return;
    }
    const rehearsal = await rehearseRestore(data);
    if (!rehearsal.ok) {
      const details = rehearsal.error
        ? rehearsal.error
        : rehearsal.consistencyIssues.map((i) => `- ${i.kind}: ${i.detail}`).join('\n');
      setImportDialog({ kind: 'notice', title: '恢复演练未通过', tone: 'danger', message: details || '演练未通过，已停止导入。' });
      return;
    }
    const warnings = preflight.issues.filter((i) => i.level === 'warning');
    const localSnapshot = await loadSnapshot(store, 'all');
    setImportDialog({
      kind: 'confirm',
      opened,
      mode: opened.payload.kind === 'device' ? 'replace' : 'merge',
      summary: describePreflight(preflight),
      warnings: warnings.slice(0, 5).map((i) => i.message),
      diff: importDiff(data, localSnapshot),
    });
  }

  async function doImport(e: ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (file) {
      try {
        await prepareImportedBackup(await parseEncryptedBackup(file));
      } catch (error) {
        if (error instanceof BackupPassphraseRequiredError) {
          setImportPassphrase('');
          setImportUnlockError('');
          setImportDialog({ kind: 'password', file });
        } else {
          setImportDialog({ kind: 'notice', title: '导入失败', tone: 'danger', message: error instanceof Error ? error.message : String(error) });
        }
      }
    }
    e.target.value = '';
  }

  function unlockImportedBackup(): Promise<void> {
    const dialog = importDialog;
    if (dialog?.kind !== 'password') return Promise.resolve();
    return runSynchronousFlight(importUnlockFlight, async () => {
      setImportBusy(true);
      setImportUnlockError('');
      try {
        const opened = await parseEncryptedBackup(dialog.file, importPassphrase);
        setImportPassphrase('');
        await prepareImportedBackup(opened);
      } catch (error) {
        setImportUnlockError(error instanceof Error ? error.message : String(error));
      } finally {
        setImportBusy(false);
      }
    });
  }

  async function confirmImport(opened: ParsedEncryptedBackup, mode: 'merge' | 'replace') {
    setImportBusy(true);
    try {
      if (runtimeLedgerCryptoSession()) {
        const protection = await saveLedgerBackup(store, 'pre-import');
        writeSafetyState(successfulBackupSafetyPatch(protection));
      }
      const batch = await store.createAuditBatch({
        id: crypto.randomUUID(),
        type: 'import',
        label: mode === 'replace' ? `精确恢复：${opened.container.label}` : `合并导入：${opened.container.label}`,
        summary: mode === 'replace' ? '从外部备份替换当前活动账本' : '将外部备份合并到当前账本',
      });
      const result = await store.withAuditContext(
        { batchId: batch.id, source: 'import' },
        (scoped) => importPortableLedger(scoped, opened.payload.ledger, mode, {
          deviceState: !accountProtection() && mode === 'replace' && opened.payload.kind === 'device' ? opened.payload.deviceState : undefined,
        }),
      );
      if (!accountProtection() && mode === 'replace' && opened.payload.kind === 'device' && opened.payload.deviceState) {
        adoptUnlockedLedgerKeyEnvelope(opened.container.keyEnvelope, opened.session, true);
      } else {
        await store.finishAuditBatch(batch.id, { entityCount: result.entities + Number(result.removed ?? 0) });
      }
      setImportDialog(null);
      bump();
    } catch (err) {
      setImportDialog({ kind: 'notice', title: '导入失败', tone: 'danger', message: err instanceof Error ? err.message : String(err) });
    } finally {
      setImportBusy(false);
    }
  }

  function quickTransaction() {
    setScreen('transactions');
    try {
      accountSessionStorage.setItem('zichan.quickTransaction', '1');
    } catch {
      // Session storage can be unavailable in hardened browser contexts.
    }
    window.setTimeout(() => {
      window.dispatchEvent(new CustomEvent('zichan:quick-transaction'));
    }, 0);
  }

  const rootStyle: CSSProperties = {
    background: 'var(--bg)',
    color: 'var(--text-primary)',
    fontFamily: FONT_FAMILY,
    fontVariantNumeric: 'tabular-nums',
  };

  const [title, sub] = META[screen];
  const asOf = snap ? ledgerAsOf(snap) : null;
  // A manual cut-off that has fallen behind is a data-correctness problem, not a
  // preference, so the header flags it instead of showing a neutral date.
  const staleCutoff = asOf?.stale && asOf.mode === 'manual' ? asOf : null;
  const safetyState = safetyStateFromSetting(snap?.setting);
  // Backup and self-check history belongs to a device, and in a preview there is none: the
  // warnings would describe the administrator's own machine while the page shows the user's
  // ledger. "还没有本地备份" would then be a false claim about the user's data.
  const safety = preview ? [] : safetyWarnings(backups, safetyState);

  return (
    <div className="zc-app-shell" style={rootStyle}>
      <Sidebar screen={screen} setScreen={setScreen} onQuickTransaction={quickTransaction} ledgerMode={ledgerMode} navigation={effectiveNavigation} />
      <main className="zc-app-main">
        <header className="zc-app-header" style={{
          display: 'flex', alignItems: 'center', justifyContent: 'space-between',
          borderBottom: '1px solid var(--border)',
          position: 'sticky', top: 0, background: 'var(--bg)', zIndex: 5,
        }}>
          <div className="zc-header-title">
            <div style={{ fontSize: 'var(--fs-heading)', fontWeight: 'var(--fw-bold)' }}>{title}</div>
            <div className="zc-header-subtitle" style={{ fontSize: 'var(--fs-body)', color: 'var(--text-secondary)', marginTop: 3 }}>{sub}</div>
          </div>
          <div className="zc-header-meta" style={{ display: 'flex', alignItems: 'center', gap: 14 }}>
            {/* Export and import act on this device's storage and on a .zcbak file. In a preview
                there is neither: the data came from the server, and "exporting" it would write a
                user's plaintext ledger onto the administrator's disk. The banner owns the only
                action a preview has. */}
            {preview ? null : (
              <div className="zc-header-actions" style={{ display: 'flex', gap: 8 }}>
                <button onClick={doExport} style={ghostBtn} title="导出加密 .zcbak 备份">导出</button>
                <button onClick={() => fileRef.current?.click()} style={ghostBtn} title="从加密归档导入">导入</button>
                <input ref={fileRef} type="file" accept="application/x-zichan-backup,.zcbak" onChange={doImport} style={{ display: 'none' }} />
              </div>
            )}
            <div style={{
              display: 'flex', alignItems: 'center', gap: 8, background: 'var(--surface)',
              border: '1px solid var(--border)', borderRadius: 'var(--r-pill)', padding: '8px 15px',
              fontSize: 'var(--fs-body)', fontWeight: 'var(--fw-bold)',
            }}>
              <span style={{ color: 'var(--text-tertiary)', fontWeight: 'var(--fw-regular)' }}>报表币种</span>
              {base ? `${base.code} · ${base.symbol ?? ''}`.trim() : '未设置'}
            </div>
            <div style={{ fontSize: 'var(--fs-caption)', color: 'var(--text-tertiary)', fontWeight: 'var(--fw-medium)', display: 'flex', flexDirection: 'column', alignItems: 'flex-end', lineHeight: 1.25 }}>
              <span style={{ fontSize: 'var(--fs-meta)', fontWeight: 'var(--fw-medium)' }}>账本日</span>
              {staleCutoff ? (
                <button
                  type="button"
                  onClick={() => setScreen('settings')}
                  title="账本日已落后，点击去设置更新"
                  style={{ border: 'none', background: 'transparent', padding: 0, cursor: 'pointer', font: 'inherit', fontSize: 'var(--fs-caption)', color: 'var(--warning)', fontWeight: 'var(--fw-medium)' }}
                >
                  {formatAsOfDate(asOf?.asOf)} · 早 {staleCutoff.daysBehind} 天
                </button>
              ) : (
                <span>{formatAsOfDate(asOf?.asOf)}</span>
              )}
            </div>
          </div>
        </header>

        <div className="zc-page-content">
          {safety.length > 0 && screen !== 'settings' && (
            <div className="zc-safety-banner" style={{ border: '1px solid var(--border)', borderRadius: 'var(--r-sm)', padding: '12px 14px', background: 'var(--surface-2)', display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 14 }}>
              <div>
                <div style={{ fontSize: 'var(--fs-body)', fontWeight: 'var(--fw-bold)', color: safety.some((w) => w.tone === 'danger') ? 'var(--negative)' : 'var(--accent)' }}>数据安全提醒</div>
                <div style={{ fontSize: 'var(--fs-caption)', color: 'var(--text-secondary)', marginTop: 4 }}>{safety.slice(0, 3).map((w) => w.message).join('；')}</div>
              </div>
              <button onClick={() => setScreen('settings')} style={ghostBtn}>去处理</button>
            </div>
          )}
          <Suspense fallback={<div role="status" style={{ minHeight: 240, padding: 24, color: 'var(--text-tertiary)' }}>正在载入…</div>}>
            {screen === 'dashboard' && <Dashboard />}
            {screen === 'convert' && <Convert />}
            {screen === 'transactions' && <Transactions />}
            {screen === 'game' && <Game />}
            {screen === 'fixed' && <Fixed />}
            {screen === 'reports' && <Reports />}
            {screen === 'history' && <History />}
            {screen === 'manage' && <Manage />}
            {/* 同步 and 设置 describe this device, not the ledger. A deep link or a restored
                `screen` value must not land on them in a preview, so they are refused here too
                rather than only hidden from the navigation. */}
            {screen === 'sync' && !preview && <Sync />}
            {screen === 'settings' && !preview && (
              <Settings
                theme={theme}
                mode={appearance.mode}
                resolvedMode={themeMode}
                setTheme={(next: ThemeId) => setAppearance(writeAppearancePreference({ theme: next }))}
                setMode={(next: ThemeModePreference) => setAppearance(writeAppearancePreference({ mode: next }))}
              />
            )}
          </Suspense>
        </div>
      </main>
      <MobileNavigation
        screen={screen}
        moreOpen={mobileMoreOpen}
        onMoreOpen={setMobileMoreOpen}
        onNavigate={(next) => { setScreen(next); setMobileMoreOpen(false); }}
        onQuickTransaction={quickTransaction}
        onExport={() => void doExport()}
        onImport={() => fileRef.current?.click()}
        storageLabel={storageBackend === 'native-sqlite' ? '原生 SQLite' : '浏览器 IndexedDB'}
        dataLocation={dataLocation}
        reportCurrency={base ? `${base.code} · ${base.symbol ?? ''}`.trim() : '未设置'}
        asOf={formatAsOfDate(asOf?.asOf)}
        ledgerMode={ledgerMode}
        navigation={effectiveNavigation}
        enablingModule={enablingModule}
        onEnableModule={(id) => void enableModule(id)}
      />
      <div id="zc-dialog-portal" />
      {importDialog?.kind === 'password' && (
        <ConfirmDialog
          title="解锁加密备份"
          confirmLabel="解锁并预检"
          cancelLabel="取消"
          busy={importBusy}
          onCancel={() => {
            setImportDialog(null);
            setImportPassphrase('');
            setImportUnlockError('');
          }}
          onConfirm={unlockImportedBackup}
        >
          <div style={{ marginBottom: 10 }}>“{importDialog.file.name}”包含密码保护的账本密钥。密码只在本机内存中用于本次解密。</div>
          <input
            autoFocus
            aria-label="备份账本加密密码"
            className="zc-input"
            type="password"
            autoComplete="off"
            spellCheck={false}
            value={importPassphrase}
            onChange={(event) => setImportPassphrase(event.target.value)}
            onKeyDown={(event) => { if (event.key === 'Enter' && importPassphrase.length >= 8) void unlockImportedBackup(); }}
            placeholder="创建备份时的账本加密密码"
          />
          {importUnlockError && <div style={{ color: 'var(--negative)', fontSize: 'var(--fs-caption)', fontWeight: 'var(--fw-medium)', marginTop: 8 }}>{importUnlockError}</div>}
        </ConfirmDialog>
      )}
      {importDialog?.kind === 'confirm' && (
        <ConfirmDialog
          title={importDialog.opened.payload.kind === 'device' ? '恢复完整设备备份' : '导入可移植账本'}
          confirmLabel={importDialog.mode === 'replace' ? '精确恢复' : '合并导入'}
          cancelLabel="取消"
          busy={importBusy}
          onCancel={() => setImportDialog(null)}
          onConfirm={() => confirmImport(importDialog.opened, importDialog.mode)}
        >
          <div>导入预检通过：{importDialog.summary}</div>
          <div style={{ marginTop: 10 }}>
            <div style={{ fontSize: 'var(--fs-caption)', fontWeight: 'var(--fw-medium)', marginBottom: 6 }}>恢复方式</div>
            <div role="group" aria-label="备份恢复方式" style={{ display: 'flex', gap: 0, width: '100%' }}>
              {(['merge', 'replace'] as const).map((mode) => (
                <button
                  key={mode}
                  type="button"
                  aria-pressed={importDialog.mode === mode}
                  onClick={() => setImportDialog({ ...importDialog, mode })}
                  style={{
                    flex: 1,
                    height: 36,
                    border: '1px solid var(--border)',
                    borderRadius: mode === 'merge' ? 'var(--r-sm) 0 0 var(--r-sm)' : '0 var(--r-sm) var(--r-sm) 0',
                    background: importDialog.mode === mode ? 'var(--accent)' : 'var(--surface)',
                    color: importDialog.mode === mode ? 'var(--on-accent)' : 'var(--fg-muted)',
                    fontSize: 'var(--fs-caption)',
                    fontWeight: 'var(--fw-medium)',
                    cursor: 'pointer',
                  }}
                >
                  {mode === 'merge' ? '合并到当前账本' : '精确替换数据'}
                </button>
              ))}
            </div>
            <div style={{ fontSize: 'var(--fs-meta)', color: 'var(--text-tertiary)', marginTop: 6 }}>
              {importDialog.mode === 'merge'
                ? '保留当前独有数据和当前密钥，仅合并备份中的账本内容。'
                : !accountProtection() && importDialog.opened.payload.kind === 'device'
                  ? '恢复账本、审计、同步状态和附件状态，并接管备份内的账本密钥。'
                  : '用可移植账本替换当前业务数据；保留当前设备密钥和同步身份。'}
            </div>
          </div>
          <div className="zc-import-stat-grid" style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 8, marginTop: 10 }}>
            <ImportStat label="新增" value={importDialog.diff.added} />
            <ImportStat label="更新" value={importDialog.diff.updated} />
            <ImportStat label="未变" value={importDialog.diff.unchanged} />
          </div>
          {importDialog.diff.byType.length > 0 && (
            <div style={{ marginTop: 10, maxHeight: 160, overflow: 'auto', borderTop: '1px solid var(--border)', paddingTop: 8 }}>
              {importDialog.diff.byType.map((row) => (
                <div className="zc-import-diff-row" key={row.label} style={{ display: 'grid', gridTemplateColumns: '1fr 70px 70px 70px', gap: 8, fontSize: 'var(--fs-caption)', padding: '3px 0' }}>
                  <span>{row.label}</span>
                  <span>新增 {row.added}</span>
                  <span>更新 {row.updated}</span>
                  <span>未变 {row.unchanged}</span>
                </div>
              ))}
            </div>
          )}
          {importDialog.diff.examples.length > 0 && (
            <div style={{ marginTop: 10, borderTop: '1px solid var(--border)', paddingTop: 8 }}>
              <div style={{ fontSize: 'var(--fs-caption)', fontWeight: 'var(--fw-medium)', color: 'var(--text-secondary)', marginBottom: 5 }}>业务字段变化示例</div>
              {importDialog.diff.examples.map((row, idx) => (
                <div key={`${row.label}-${row.name}-${idx}`} style={{ fontSize: 'var(--fs-caption)', color: 'var(--text-secondary)', lineHeight: 1.55 }}>
                  {row.label} · {row.name}：{row.fields.slice(0, 6).join('、')}
                </div>
              ))}
            </div>
          )}
          {importDialog.warnings.length > 0 && (
            <div style={{ marginTop: 8 }}>
              警告：
              <ul style={{ margin: '6px 0 0', paddingLeft: 18 }}>
                {importDialog.warnings.map((w) => <li key={w}>{w}</li>)}
              </ul>
            </div>
          )}
          <div style={{ marginTop: 8 }}>当前账本密钥已解锁时，系统会先保存一份固定保留的“导入前备份”。</div>
        </ConfirmDialog>
      )}
      {importDialog?.kind === 'notice' && (
        <ConfirmDialog
          title={importDialog.title}
          confirmLabel="知道了"
          tone={importDialog.tone}
          onConfirm={() => setImportDialog(null)}
        >
          <pre style={{ margin: 0, whiteSpace: 'pre-wrap', fontFamily: 'inherit' }}>{importDialog.message}</pre>
        </ConfirmDialog>
      )}
      <AppSecurityGate />
      <VaultUnlockPrompt />
    </div>
  );
}

function ImportStat({ label, value }: { label: string; value: number }) {
  return (
    <div style={{ border: '1px solid var(--border)', borderRadius: 'var(--r-sm)', padding: 8, background: 'var(--surface-2)' }}>
      <div style={{ fontSize: 'var(--fs-meta)', color: 'var(--text-tertiary)', fontWeight: 'var(--fw-medium)' }}>{label}</div>
      <div style={{ fontSize: 'var(--fs-heading)', color: 'var(--text-primary)', fontWeight: 'var(--fw-bold)', marginTop: 2 }}>{value}</div>
    </div>
  );
}

function Sidebar(props: {
  screen: ScreenId;
  setScreen: (s: ScreenId) => void;
  onQuickTransaction: () => void;
  ledgerMode: LedgerMode;
  navigation: NavigationPreferences;
}) {
  const { screen, setScreen, onQuickTransaction, ledgerMode, navigation } = props;
  const mainNav = orderedNavigationItems(navigation);
  return (
    <aside className="zc-sidebar" style={{
      background: 'var(--surface)', borderRight: '1px solid var(--border)', display: 'flex',
      flexDirection: 'column', gap: 6,
    }}>
      <div className="zc-sidebar-brand" style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '6px 8px 20px' }}>
        <div style={{
          width: 36, height: 36, borderRadius: 'var(--r-sm)', background: 'var(--accent)', display: 'flex',
          alignItems: 'center', justifyContent: 'center', color: 'var(--on-accent)', fontWeight: 'var(--fw-bold)', fontSize: 'var(--fs-title)',
        }}>资</div>
        <div className="zc-sidebar-brand-copy">
          <div style={{ fontWeight: 'var(--fw-bold)', fontSize: 'var(--fs-title)', letterSpacing: 0 }}>资产生命周期</div>
          <div style={{ fontSize: 'var(--fs-meta)', color: 'var(--text-tertiary)', letterSpacing: 0, fontWeight: 'var(--fw-medium)' }}>
            LIFECYCLE LEDGER
          </div>
        </div>
      </div>

      <nav style={{ display: 'flex', flexDirection: 'column', gap: 3 }}>
        {mainNav.map(({ id, icon }) => {
          const label = navigationLabel(id, ledgerMode);
          const active = screen === id;
          const withQuick = id === 'transactions';
          return (
            <div
              key={id}
              style={{
                display: 'flex', alignItems: 'center', borderRadius: 'var(--r-sm)', overflow: 'hidden',
                background: active ? 'var(--accent-soft)' : 'transparent',
                color: active ? 'var(--accent)' : 'var(--fg-muted)',
              }}
            >
              <button
                title={label}
                className="zc-sidebar-nav-item"
                onClick={() => setScreen(id)}
                style={{
                  display: 'flex', alignItems: 'center', gap: 12, padding: '10px 12px', borderRadius: 'var(--r-sm)',
                  border: 'none', cursor: 'pointer', flex: 1, minWidth: 0, textAlign: 'left', fontSize: 'var(--fs-body)',
                  background: 'transparent',
                  color: 'inherit',
                  fontWeight: active ? 'var(--fw-bold)' : 'var(--fw-medium)',
                }}
              >
                <span style={{ width: 20, textAlign: 'center', fontSize: 'var(--fs-title)' }}>{icon}</span>
                <span className="zc-sidebar-nav-label" style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{label}</span>
              </button>
              {withQuick && (
                <button
                  type="button"
                  className="zc-sidebar-quick-inline"
                  aria-label="快速记账"
                  title="快速记账"
                  onClick={onQuickTransaction}
                  style={{
                    /* Geometry lives in `.zc-sidebar-quick-inline` so the box
                       stays square; only the active tint is dynamic. */
                    border: active ? '1px solid var(--accent)' : '1px solid var(--border)',
                    background: active ? 'var(--accent)' : 'var(--surface-2)',
                    color: active ? 'var(--on-accent)' : 'var(--accent)',
                  }}
                >
                  <PlusIcon size={20} />
                </button>
              )}
            </div>
          );
        })}
      </nav>

      {/*
       * Wide-rail and compact-rail variants of the same action. Keeping one
       * element per breakpoint (rather than shrinking a single button to 24px
       * inside the icon rail) keeps the tap target at 44px on tablets.
       */}
      <div className="zc-sidebar-quick">
        <button
          type="button"
          className="zc-sidebar-quick-rail"
          aria-label="快速记账"
          title="快速记账"
          onClick={onQuickTransaction}
        >
          <PlusIcon size={21} />
        </button>
        {/*
         * A caption, not a second accessible name - the button above already
         * carries 快速记账. It is shown only where the rail also labels its nav
         * items, so the quick action does not become the one unlabelled control
         * on an otherwise labelled rail. Inside the circle it could not exist at
         * all, which is why it moved out here.
         */}
        <span className="zc-sidebar-quick-rail-label" aria-hidden="true">快速记账</span>
      </div>

      <div style={{ flex: 1 }} />
    </aside>
  );
}

function MobileNavigation(props: {
  screen: ScreenId;
  moreOpen: boolean;
  onMoreOpen: (open: boolean) => void;
  onNavigate: (screen: ScreenId) => void;
  onQuickTransaction: () => void;
  onExport: () => void;
  onImport: () => void;
  storageLabel: string;
  dataLocation: string;
  reportCurrency: string;
  asOf: string;
  ledgerMode: LedgerMode;
  navigation: NavigationPreferences;
  enablingModule: ScreenId | null;
  onEnableModule: (id: ScreenId) => void;
}) {
  const { onMoreOpen } = props;
  const drawerTitleId = useId();
  useEffect(() => {
    const mobileViewport = window.matchMedia('(max-width: 767px)');
    const closeOnDesktop = () => {
      if (!mobileViewport.matches) onMoreOpen(false);
    };
    closeOnDesktop();
    mobileViewport.addEventListener('change', closeOnDesktop);
    return () => mobileViewport.removeEventListener('change', closeOnDesktop);
  }, [onMoreOpen]);

  const visibleItems = orderedNavigationItems(props.navigation);
  const mainItems = visibleItems.slice(0, 3);
  const moreItems = visibleItems.slice(3);
  const moreIds = new Set(moreItems.map((item) => item.id));
  const shownIds = new Set(visibleItems.map((item) => item.id));
  /*
   * The quick action owns the exact middle column, and 日常收支 sits directly to
   * its left, so the two most-used targets share the centre of the bar.
   *
   * Previously the quick action was the second of five equal columns (20% of the
   * width) while 日常收支 took the first - the primary action sat off-centre and
   * the bar read as lopsided. The equal columns themselves are load-bearing for
   * the centring, so the count stays `items + quick + more`.
   */
  const columnCount = mainItems.length + 2;
  const leftCount = Math.max(0, Math.min(Math.floor(columnCount / 2), mainItems.length));
  const primary = mainItems.find((item) => item.id === 'transactions');
  const others = mainItems.filter((item) => item !== primary);
  const beforeQuick = primary && leftCount > 0
    ? [...others.slice(0, leftCount - 1), primary]
    : others.slice(0, leftCount);
  const afterQuick = mainItems.filter((item) => !beforeQuick.includes(item));
  // Modules the user turned off. Surfacing them here means a hidden module does
  // not require a detour through 设置, and hidden modules are never force-added
  // to the drawer grid above.
  const hiddenItems = orderedNavigationItems(props.navigation, true).filter((item) => !shownIds.has(item.id));
  return (
    <>
      <nav
        className="zc-mobile-bottom-nav"
        aria-label="移动端主导航"
        style={{ gridTemplateColumns: `repeat(${columnCount}, minmax(0, 1fr))` }}
      >
        {beforeQuick.map(({ id, icon }) => (
          <button key={id} className={props.screen === id ? 'is-active' : ''} onClick={() => props.onNavigate(id)}>
            <span>{icon}</span><small>{navigationLabel(id, props.ledgerMode)}</small>
          </button>
        ))}
        <button className="zc-mobile-quick" aria-label="快速记账" onClick={props.onQuickTransaction}><span><PlusIcon size={24} /></span><small>快记</small></button>
        {afterQuick.map(({ id, icon }) => (
          <button key={id} className={props.screen === id ? 'is-active' : ''} onClick={() => props.onNavigate(id)}>
            <span>{icon}</span><small>{navigationLabel(id, props.ledgerMode)}</small>
          </button>
        ))}
        <button className={moreIds.has(props.screen) || props.moreOpen ? 'is-active' : ''} onClick={() => props.onMoreOpen(true)}>
          <span>•••</span><small>更多</small>
        </button>
      </nav>
      {props.moreOpen && (
        <DialogShell
          labelledBy={drawerTitleId}
          onDismiss={() => props.onMoreOpen(false)}
          backdropClassName="zc-mobile-drawer-backdrop"
          backdropStyle={{ zIndex: 80 }}
          panelClassName="zc-mobile-drawer"
        >
            <div className="zc-mobile-drawer-handle" />
            <div className="zc-mobile-drawer-head"><b id={drawerTitleId}>更多功能</b><button type="button" data-dialog-initial-focus aria-label="关闭更多菜单" onClick={() => props.onMoreOpen(false)}>×</button></div>
            {moreItems.length > 0 && (
              <div className="zc-mobile-drawer-grid">
                {moreItems.map(({ id, icon }) => (
                  <button key={id} className={props.screen === id ? 'is-active' : ''} onClick={() => props.onNavigate(id)}><span>{icon}</span><b>{navigationLabel(id, props.ledgerMode)}</b></button>
                ))}
              </div>
            )}
            {hiddenItems.length > 0 && (
              <>
                <div className="zc-mobile-drawer-section-head">未启用模块</div>
                <div className="zc-mobile-drawer-grid zc-mobile-drawer-grid-hidden">
                  {hiddenItems.map(({ id, icon }) => (
                    <button
                      key={id}
                      className="zc-mobile-drawer-add"
                      disabled={props.enablingModule === id}
                      onClick={() => props.onEnableModule(id)}
                    >
                      <span>{icon}</span><b>{navigationLabel(id, props.ledgerMode)}</b>
                      <small>{props.enablingModule === id ? '启用中…' : '启用'}</small>
                    </button>
                  ))}
                </div>
              </>
            )}
            <div className="zc-mobile-drawer-status">
              <span>报表币种 <b>{props.reportCurrency}</b></span>
              <span>基准日 <b>{props.asOf}</b></span>
              <span>数据引擎 <b>{props.storageLabel}</b></span>
              <small title={props.dataLocation}>{props.dataLocation}</small>
            </div>
            <div className="zc-mobile-drawer-actions">
              <button onClick={() => { props.onMoreOpen(false); props.onExport(); }}>导出备份</button>
              <button onClick={() => { props.onMoreOpen(false); props.onImport(); }}>导入备份</button>
            </div>
        </DialogShell>
      )}
    </>
  );
}

import { btnGhost } from './ui/styles.js';