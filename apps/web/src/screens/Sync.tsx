import { useEffect, useMemo, useState } from 'react';
import {
  aggregateKey, registerAccount, loginAccount, fetchLedgerKeyEnvelope, checkConsistency, recomputeCaches, resolveConflictGroup,
  type StoredSyncCommit, type SyncConflictBranchRow, type SyncConflictGroupRow,
} from '@zichan/db';
import { isDateInRange } from '@zichan/core';
import { useStore } from '../db/store.js';
import { useSnapshot, type Snapshot } from '../db/snapshot.js';
import { reconcileAttachmentStorage } from '../db/attachment-storage.js';
import {
  getDeviceId,
  listDevices,
  registerSync,
} from '../db/cloud.js';
import { card, th as thStyle, td as tdStyle } from '../ui/styles.js';
import { categoryLabel, TYPE_LABEL } from '../transactionMeta.js';
import { ServerAdmin } from './ServerAdmin.js';
import { DateRangeBar, dateRangeValue, localDateOfInstant, type DateRangeValue } from '../ui/DateRangeBar.js';
import {
  buildSyncBaseUrl as buildBaseUrl,
  loadAutoSync,
  loadSyncProfiles,
  newSyncProfile as newProfile,
  normalizeBasePath,
  saveAutoSync,
  saveSyncProfiles,
  type ServerCredential,
  type SyncProtocol as Protocol,
  type SyncServerProfile,
  type SyncTestStatus as TestStatus,
} from '../sync-config.js';
import {
  CREDENTIALS_CHANGED_EVENT,
  VAULT_STATE_CHANGED_EVENT,
  credentialVaultState,
  deleteCredential,
  persistCredential,
  refreshCredentialVaultState,
  runtimeCredentialMap,
  setRuntimeCredential,
  unlockCredentialVault,
  type CredentialVaultState,
} from '../credential-vault.js';
import { SYNC_LIFECYCLE_RESULT_EVENT, type LifecycleSyncResult } from '../background-sync.js';
import { syncConfiguredServers, type ConfiguredSyncEndpoint, type ConfiguredSyncResult } from '../sync-orchestrator.js';
import {
  LEDGER_KEY_STATE_CHANGED_EVENT,
  adoptLedgerKeyEnvelope,
  initializeLedgerKey,
  ledgerKeyState,
  lockLedgerKey,
  rotateLedgerKey,
  unlockLedgerKey,
  updateLedgerPassphrase,
  type LedgerKeyState,
} from '../ledger-key-vault.js';

const REQUEST_TIMEOUT_MS = 5_000;
type WizardMode = 'local' | 'lan' | 'public';

function sameCredentialMaps(
  left: Record<string, ServerCredential>,
  right: Record<string, ServerCredential>,
): boolean {
  const leftKeys = Object.keys(left);
  const rightKeys = Object.keys(right);
  return leftKeys.length === rightKeys.length && leftKeys.every((key) => {
    const a = left[key];
    const b = right[key];
    return !!a && !!b
      && a.password === b.password
      && a.inviteCode === b.inviteCode
      && a.accessToken === b.accessToken
      && a.refreshToken === b.refreshToken
      && a.accessExpiresAt === b.accessExpiresAt
      && a.sessionId === b.sessionId;
  });
}

const BASE_KEYS = new Set(['id', 'createdAt', 'updatedAt', 'version', 'isDeleted']);

function biz(o: Record<string, unknown> | null): string {
  if (!o) return '—';
  const r: Record<string, unknown> = {};
  for (const k of Object.keys(o)) if (!BASE_KEYS.has(k)) r[k] = o[k];
  return JSON.stringify(r);
}

const ENTITY_LABELS: Record<string, string> = {
  asset: '资产',
  account: '账户',
  setting: '设置',
  price_mark: '价格记录',
  lot: '持仓批次',
  dca_plan: '定投计划',
  dca_execution: '定投执行',
  game: '游戏',
  game_account: '游戏账号',
  game_record: '游戏记录',
  fixed_asset: '物品资产',
  fixed_asset_category: '物品分类',
  fixed_asset_event: '物品事件',
  fixed_asset_usage_metric: '使用指标',
  fixed_asset_usage_log: '使用记录',
  fixed_asset_consumable: '耗材',
  fixed_asset_goal: '使用成本目标',
  conversion_chain: '资产转换',
  conversion_chain_steps: '资产转换步骤',
  category: '分类',
  categoryId: '物品分类',
  payee: '商户',
  transaction: '流水',
  transaction_split: '流水拆分',
  transaction_tag: '标签',
  transaction_location: '地点',
  transaction_template: '交易模板',
  transaction_saved_view: '保存筛选',
  budget_category: '预算',
  scheduled_transaction: '周期流水',
  reconciliation_session: '对账记录',
  attachment: '附件',
};

const FIELD_LABELS: Record<string, string> = {
  name: '名称',
  alias: '别名',
  code: '代码',
  date: '日期',
  time: '时间',
  timezone: '时区',
  type: '类型',
  category: '分类',
  parentId: '上级分类',
  amount: '金额',
  assetId: '资产',
  accountId: '账户',
  transferAssetId: '转入资产',
  transferAccountId: '转入账户',
  transferAmount: '转入金额',
  status: '状态',
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
  month: '月份',
  plannedAmount: '预算金额',
  price: '价格',
  source: '来源',
  fromAssetId: '来源资产',
  toAssetId: '目标资产',
  fees: '手续费明细',
  feeAssetId: '手续费资产',
  feeAmount: '手续费',
  referenceRate: '参考汇率',
  sourceAmountMode: '来源金额口径',
  targetAmountMode: '目标金额口径',
  bookValueInBase: '账面折算',
  finalAssetId: '最终资产',
  settlementAssetId: '结算资产',
  fileName: '文件名',
  mimeType: '文件类型',
  sizeBytes: '文件大小',
  sha256: '正文校验和',
  thumbnailSha256: '缩略图校验和',
};
const STATUS_LABELS: Record<string, string> = {
  pending: '待确认',
  cleared: '已清算',
  reconciled: '已对账',
  active: '启用',
  paused: '暂停',
  ended: '结束',
  closed: '已关闭',
  open: '打开',
};

function fieldLabel(key: string): string {
  return FIELD_LABELS[key] ?? key;
}

function nameById<T extends { id: string }>(rows: T[] | undefined, id: unknown, pick: (row: T) => string): string | undefined {
  if (typeof id !== 'string') return undefined;
  const row = rows?.find((x) => x.id === id);
  return row ? pick(row) : undefined;
}

function unknownLabel(label: string, id: string): string {
  return `未知${label} ${id.slice(0, 8)}`;
}

function formatValue(key: string, value: unknown, snap: Snapshot | null): string {
  if (value === undefined || value === null || value === '') return '空';
  if (Array.isArray(value)) return value.map((v) => formatValue(key, v, snap)).join(' / ') || '空';
  if (typeof value === 'boolean') return value ? '是' : '否';
  if (key === 'type') return TYPE_LABEL[String(value) as keyof typeof TYPE_LABEL] ?? String(value);
  if (key === 'status') return STATUS_LABELS[String(value)] ?? String(value);
  if (!snap) return String(value);
  const id = String(value);
  if (key === 'category' || key === 'parentId') return categoryLabel(id, snap.categories);
  if (key.endsWith('AssetId') || key === 'assetId' || key === 'settlementAssetId' || key === 'finalAssetId') {
    return nameById(snap.assets, id, (a) => `${a.code} · ${a.name}`) ?? unknownLabel('资产', id);
  }
  if (key.endsWith('AccountId') || key === 'accountId') return nameById(snap.accounts, id, (a) => a.name) ?? unknownLabel('账户', id);
  if (key === 'payeeId') return nameById(snap.payees, id, (p) => p.name) ?? unknownLabel('商户', id);
  if (key === 'locationId') return nameById(snap.transactionLocations, id, (l) => l.name) ?? unknownLabel('地点', id);
  if (key === 'tagIds') return nameById(snap.transactionTags, id, (t) => t.groupName ? `${t.groupName} / ${t.name}` : t.name) ?? unknownLabel('标签', id);
  if (typeof value === 'object') {
    const text = JSON.stringify(value);
    return text.length > 160 ? `${text.slice(0, 160)}...` : text;
  }
  return String(value);
}

function aggregateTitle(type: string, id: string, payload: Record<string, unknown> | null, snap: Snapshot | null): string {
  if (!payload) return `${ENTITY_LABELS[type] ?? type} · ${id.slice(0, 8)}（已删除）`;
  const candidates = [payload.name, payload.title, payload.description, payload.merchant, payload.code].filter(Boolean);
  if (typeof payload.category === 'string') candidates.push(categoryLabel(payload.category, snap?.categories ?? []));
  return `${ENTITY_LABELS[type] ?? type} · ${candidates.length ? String(candidates[0]) : id.slice(0, 8)}`;
}

type ConflictAggregate = {
  key: string;
  type: string;
  id: string;
  branches: SyncConflictBranchRow[];
};

function conflictAggregates(group: SyncConflictGroupRow): ConflictAggregate[] {
  const byKey = new Map<string, ConflictAggregate>();
  for (const branch of group.branches) {
    const key = aggregateKey(branch.aggregateType, branch.aggregateId);
    const row = byKey.get(key) ?? { key, type: branch.aggregateType, id: branch.aggregateId, branches: [] };
    if (!row.branches.some((item) => item.revisionId === branch.revisionId)) row.branches.push(branch);
    byKey.set(key, row);
  }
  return [...byKey.values()];
}

function conflictFields(branches: SyncConflictBranchRow[]): string[] {
  return [...new Set(branches.flatMap((branch) => Object.keys(branch.payload ?? {})))]
    .filter((key) => !BASE_KEYS.has(key))
    .sort();
}

function branchLabel(branch: SyncConflictBranchRow, index: number): string {
  return branch.role === 'local'
    ? '本机快照'
    : `${branch.originDeviceId.slice(0, 12)} · 分支 ${index + 1}`;
}

function ledgerMismatchId(error?: string): string | undefined {
  return error?.match(/LEDGER_MISMATCH:([A-Za-z0-9_-]{16,128})/)?.[1];
}

const WIZARD_MODES: { mode: WizardMode; label: string; hint: string }[] = [
  { mode: 'local', label: '本机服务器', hint: '桌面端或当前电脑运行 8787 服务' },
  { mode: 'lan', label: '局域网电脑', hint: '家里常开电脑、NAS 或固定内网 IP' },
  { mode: 'public', label: '公网域名', hint: 'HTTPS 域名，可带安全路径' },
];

function wizardPatch(mode: WizardMode, host: string, basePath: string): Partial<SyncServerProfile> {
  if (mode === 'local') {
    return { alias: '本机服务器', protocol: 'http', host: 'localhost', port: '8787', basePath: '', enabled: true };
  }
  if (mode === 'lan') {
    return { alias: '家里电脑', protocol: 'http', host: host.trim() || '192.168.1.100', port: '8787', basePath: '', enabled: true };
  }
  return { alias: '公网服务器', protocol: 'https', host: host.trim() || 'ledger.example.com', port: '', basePath: normalizeBasePath(basePath || '/zichan'), enabled: true };
}

function timeoutMessage(label: string): string {
  return `${label}超时（${REQUEST_TIMEOUT_MS / 1000} 秒）`;
}

function formatBytes(value: number): string {
  if (value >= 1024 ** 3) return `${(value / 1024 ** 3).toFixed(1)} GB`;
  if (value >= 1024 ** 2) return `${(value / 1024 ** 2).toFixed(1)} MB`;
  if (value >= 1024) return `${Math.round(value / 1024)} KB`;
  return `${value} B`;
}

async function withTimeout<T>(promise: Promise<T>, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(timeoutMessage(label))), REQUEST_TIMEOUT_MS);
  });
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function fetchHealth(baseUrl: string): Promise<{ ok: boolean; status: number; json: () => Promise<unknown> }> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    return await fetch(`${baseUrl}/api/health`, { signal: controller.signal });
  } catch (e) {
    if (e instanceof DOMException && e.name === 'AbortError') throw new Error(timeoutMessage('连通性测试'));
    throw e;
  } finally {
    clearTimeout(timer);
  }
}

const statusText: Record<TestStatus, string> = {
  idle: '未测试',
  online: '在线',
  unauthorized: '认证失败',
  offline: '离线',
};

const outline = { padding: '7px 13px', borderRadius: 9, border: '1px solid var(--border)', background: 'var(--surface)', color: 'var(--fg-muted)', fontWeight: 700, fontSize: 12, cursor: 'pointer', whiteSpace: 'nowrap' } as const;
const primary = { ...outline, border: '1px solid var(--accent)', background: 'var(--accent)', color: '#fff' } as const;
const danger = { ...outline, border: '1px solid var(--negative)', color: 'var(--negative)' } as const;
const inputGrid = { display: 'grid', gridTemplateColumns: '1fr 120px 1fr 100px', gap: 10, marginBottom: 10 } as const;

export function Sync() {
  const { store, bump } = useStore();
  const snap = useSnapshot('sync');
  const [tab, setTab] = useState<'account' | 'admin'>('account');
  const [profiles, setProfiles] = useState<SyncServerProfile[]>(loadSyncProfiles);
  const [selectedId, setSelectedId] = useState(profiles[0]?.id ?? '');
  const [credentials, setCredentials] = useState<Record<string, ServerCredential>>(runtimeCredentialMap);
  const initialAutoSync = useMemo(loadAutoSync, []);
  const [autoSyncEnabled, setAutoSyncEnabled] = useState(initialAutoSync.enabled);
  const [autoSyncMinutes, setAutoSyncMinutes] = useState(initialAutoSync.minutes);
  const [autoSyncStatus, setAutoSyncStatus] = useState('未启用');
  const [vault, setVault] = useState<CredentialVaultState>(credentialVaultState);
  const [vaultPassword, setVaultPassword] = useState('');
  const [vaultPasswordConfirm, setVaultPasswordConfirm] = useState('');
  const [vaultBusy, setVaultBusy] = useState(false);
  const [vaultError, setVaultError] = useState('');
  const [ledgerKey, setLedgerKey] = useState<LedgerKeyState>(ledgerKeyState);
  const [ledgerPassword, setLedgerPassword] = useState('');
  const [ledgerPasswordConfirm, setLedgerPasswordConfirm] = useState('');
  const [newLedgerPassword, setNewLedgerPassword] = useState('');
  const [newLedgerPasswordConfirm, setNewLedgerPasswordConfirm] = useState('');
  const [ledgerKeyBusy, setLedgerKeyBusy] = useState(false);
  const [ledgerKeyError, setLedgerKeyError] = useState('');
  const [result, setResult] = useState<ConfiguredSyncResult | null>(null);
  const [conflicts, setConflicts] = useState<SyncConflictGroupRow[]>([]);
  const [invalidCommits, setInvalidCommits] = useState<StoredSyncCommit[]>([]);
  const [conflictRange, setConflictRange] = useState<DateRangeValue>(() => dateRangeValue('all'));
  const [branchChoices, setBranchChoices] = useState<Record<string, Record<string, string>>>({});
  const [fieldChoices, setFieldChoices] = useState<Record<string, Record<string, Record<string, string>>>>({});
  const [busy, setBusy] = useState(false);
  const [testingId, setTestingId] = useState('');
  const [lastSyncAt, setLastSyncAt] = useState('');
  const [syncNotice, setSyncNotice] = useState('');
  const [mergeNotice, setMergeNotice] = useState('');
  const [endpointRows, setEndpointRows] = useState<ConfiguredSyncEndpoint[]>([]);
  const [wizardMode, setWizardMode] = useState<WizardMode>('local');
  const [wizardHost, setWizardHost] = useState('192.168.1.100');
  const [wizardBasePath, setWizardBasePath] = useState('/zichan');
  const [joinTarget, setJoinTarget] = useState<{ profileId: string; ledgerId: string } | null>(null);
  const [joinConfirmation, setJoinConfirmation] = useState('');
  const deviceId = getDeviceId();
  const [devices, setDevices] = useState(listDevices());
  const msg = (e: unknown) => (e instanceof Error ? e.message : String(e));

  const selected = useMemo(() => profiles.find((p) => p.id === selectedId) ?? profiles[0], [profiles, selectedId]);

  useEffect(() => {
    saveSyncProfiles(profiles);
  }, [profiles]);

  useEffect(() => {
    const refreshCredentials = () => {
      const next = runtimeCredentialMap();
      setCredentials((current) => sameCredentialMaps(current, next) ? current : next);
    };
    const refreshVault = () => setVault(credentialVaultState());
    window.addEventListener(CREDENTIALS_CHANGED_EVENT, refreshCredentials);
    window.addEventListener(VAULT_STATE_CHANGED_EVENT, refreshVault);
    void refreshCredentialVaultState().then(setVault).catch((error) => {
      setVaultError(`安全密码库不可用：${msg(error)}`);
    });
    return () => {
      window.removeEventListener(CREDENTIALS_CHANGED_EVENT, refreshCredentials);
      window.removeEventListener(VAULT_STATE_CHANGED_EVENT, refreshVault);
    };
  }, []);

  useEffect(() => {
    const refresh = () => setLedgerKey(ledgerKeyState());
    window.addEventListener(LEDGER_KEY_STATE_CHANGED_EVENT, refresh);
    return () => window.removeEventListener(LEDGER_KEY_STATE_CHANGED_EVENT, refresh);
  }, []);

  useEffect(() => {
    if (vault.kind !== 'native-stronghold' || !vault.unlocked) return;
    const timer = window.setTimeout(() => {
      for (const profile of profiles) {
        const credential = credentials[profile.id];
        if (credential?.password || credential?.inviteCode) {
          void persistCredential(profile.id, credential).catch((error) => setVaultError(`保存 ${profile.alias} 的密码失败：${msg(error)}`));
        } else if (credential) {
          void deleteCredential(profile.id).catch((error) => setVaultError(`删除 ${profile.alias} 的密码失败：${msg(error)}`));
        }
      }
    }, 500);
    return () => window.clearTimeout(timer);
  }, [credentials, profiles, vault.kind, vault.unlocked]);

  useEffect(() => {
    saveAutoSync({ enabled: autoSyncEnabled, minutes: autoSyncMinutes });
  }, [autoSyncEnabled, autoSyncMinutes]);

  useEffect(() => {
    let cancelled = false;
    void Promise.all([
      store.listConflicts(),
      store.listSyncCommits({ state: 'invalid', includeInvalid: true }),
    ]).then(([conflictRows, invalidRows]) => {
      if (!cancelled) {
        setConflicts(conflictRows);
        setInvalidCommits(invalidRows);
      }
    });
    return () => { cancelled = true; };
  }, [store]);

  function patchProfile(id: string, patch: Partial<SyncServerProfile>) {
    setProfiles((rows) => rows.map((row) => row.id === id ? { ...row, ...patch } : row));
  }

  function patchCredential(id: string, patch: Partial<ServerCredential>) {
    const next = { password: '', inviteCode: '', ...(credentials[id] ?? {}), ...patch };
    setCredentials((current) => ({ ...current, [id]: next }));
    setRuntimeCredential(id, next);
  }

  async function unlockVault() {
    if (!vault.initialized && vaultPassword !== vaultPasswordConfirm) {
      setVaultError('两次输入的本机密码不一致');
      return;
    }
    setVaultBusy(true);
    setVaultError('');
    try {
      const loaded = await unlockCredentialVault(vaultPassword, profiles.map((profile) => profile.id));
      setCredentials(loaded);
      setVault(credentialVaultState());
      setVaultPassword('');
      setVaultPasswordConfirm('');
      setSyncNotice(vault.initialized ? 'Stronghold 已解锁，自动同步可以使用已保存密码。' : 'Stronghold 已创建，后续同步密码会加密保存。');
    } catch (error) {
      setVaultError(`解锁失败：${msg(error)}`);
    } finally {
      setVaultBusy(false);
    }
  }

  async function createOrUnlockLedgerKey() {
    if (ledgerPassword !== ledgerPasswordConfirm && !ledgerKey.initialized) {
      setLedgerKeyError('两次输入的账本加密密码不一致');
      return;
    }
    setLedgerKeyBusy(true);
    setLedgerKeyError('');
    try {
      if (ledgerKey.initialized) await unlockLedgerKey(ledgerPassword);
      else await initializeLedgerKey(await store.getLedgerId(), ledgerPassword);
      setLedgerPassword('');
      setLedgerPasswordConfirm('');
      setSyncNotice(ledgerKey.initialized ? '账本密钥已解锁，本次会话可以同步与加密备份。' : '账本密钥已创建；首次同步会把加密密钥包复制到服务器。');
    } catch (error) {
      setLedgerKeyError(`账本密钥处理失败：${msg(error)}`);
    } finally {
      setLedgerKeyBusy(false);
    }
  }

  async function changeLedgerKeyPassword() {
    if (newLedgerPassword !== newLedgerPasswordConfirm) {
      setLedgerKeyError('两次输入的新账本密码不一致');
      return;
    }
    setLedgerKeyBusy(true);
    setLedgerKeyError('');
    try {
      await updateLedgerPassphrase(newLedgerPassword);
      setNewLedgerPassword('');
      setNewLedgerPasswordConfirm('');
      setSyncNotice('账本密码已修改；下次同步会把新一代加密密钥包更新到各服务器。');
    } catch (error) {
      setLedgerKeyError(`修改失败：${msg(error)}`);
    } finally {
      setLedgerKeyBusy(false);
    }
  }

  async function rotateLedgerDataKeyNow() {
    if (newLedgerPassword.length < 8) {
      setLedgerKeyError('轮换时请输入当前要继续使用的账本加密密码');
      return;
    }
    setLedgerKeyBusy(true);
    setLedgerKeyError('');
    try {
      await rotateLedgerKey(newLedgerPassword);
      setNewLedgerPassword('');
      setNewLedgerPasswordConfirm('');
      setSyncNotice('数据密钥已轮换；旧密钥保留用于读取历史提交和附件。');
    } catch (error) {
      setLedgerKeyError(`轮换失败：${msg(error)}`);
    } finally {
      setLedgerKeyBusy(false);
    }
  }

  async function fetchRemoteLedgerKey(profile: SyncServerProfile) {
    setLedgerKeyBusy(true);
    setLedgerKeyError('');
    try {
      const token = await loginProfile(profile);
      const envelope = await fetchLedgerKeyEnvelope(buildBaseUrl(profile), token);
      if (!envelope) throw new Error('该服务器尚未保存账本密钥包，请先从已有设备同步一次');
      adoptLedgerKeyEnvelope(envelope);
      setSyncNotice(`已从“${profile.alias}”取得加密密钥包，请输入账本加密密码解锁。`);
    } catch (error) {
      setLedgerKeyError(`获取失败：${msg(error)}`);
    } finally {
      setLedgerKeyBusy(false);
    }
  }

  function addProfile() {
    const p = { ...newProfile(), id: crypto.randomUUID?.() ?? `server-${Date.now()}`, alias: `服务器${profiles.length + 1}` };
    setProfiles((rows) => [...rows, p]);
    setSelectedId(p.id);
  }

  async function removeProfile(id: string) {
    if (profiles.length <= 1) return;
    try {
      const profile = profiles.find((row) => row.id === id);
      if (profile?.serverId && profile.replicaId && profile.streamEpoch && profile.ledgerId) {
        await store.retireReplica({
          serverId: profile.serverId,
          replicaId: profile.replicaId,
          streamEpoch: profile.streamEpoch,
          ledgerId: profile.ledgerId,
        });
      }
      await deleteCredential(id);
      await store.attachmentState.removeReplicaBlobs(id);
      setProfiles((rows) => rows.filter((row) => row.id !== id));
      setSelectedId((cur) => cur === id ? profiles.find((row) => row.id !== id)?.id ?? '' : cur);
      setCredentials((current) => {
        const next = { ...current };
        delete next[id];
        return next;
      });
    } catch (error) {
      setVaultError(`删除服务器前清理同步凭据失败：${msg(error)}`);
    }
  }

  function chooseWizardMode(mode: WizardMode) {
    setWizardMode(mode);
    if (mode === 'lan' && (!wizardHost || wizardHost === 'localhost' || wizardHost === 'ledger.example.com')) setWizardHost('192.168.1.100');
    if (mode === 'public' && (!wizardHost || wizardHost === '192.168.1.100' || wizardHost === 'localhost')) setWizardHost('ledger.example.com');
  }

  function applyWizard(): SyncServerProfile | undefined {
    if (!selected) return undefined;
    const next = { ...selected, ...wizardPatch(wizardMode, wizardHost, wizardBasePath) };
    patchProfile(selected.id, next);
    setSyncNotice(`已套用“${WIZARD_MODES.find((m) => m.mode === wizardMode)?.label ?? '同步'}”配置；继续填写用户名和服务器账号密码后验证。`);
    return next;
  }

  async function applyWizardAndTest() {
    const next = applyWizard();
    if (next) await testProfile(next, 'health');
  }

  async function testProfile(profile: SyncServerProfile, mode: 'health' | 'auth' = 'auth') {
    const baseUrl = buildBaseUrl(profile);
    const started = performance.now();
    setTestingId(profile.id);
    patchProfile(profile.id, { lastError: mode === 'health' ? '正在测试连通性…' : '正在验证账号密码…' });
    try {
      const health = await fetchHealth(baseUrl);
      const latencyMs = Math.round(performance.now() - started);
      if (!health.ok) throw new Error(`health HTTP ${health.status}`);
      const body = (await health.json()) as { serverId?: string; protocols?: number[]; features?: string[] };
      if (!body.protocols?.includes(3) || !body.features?.includes('encrypted-blobs-v1') || !body.features?.includes('ledger-key-envelope-v1')) {
        throw new Error('服务器不支持当前端到端加密同步协议');
      }
      const cred = credentials[profile.id];
      if (mode === 'auth' && profile.username.trim() && cred?.password) {
        try {
          const session = await withTimeout(loginAccount(baseUrl, profile.username.trim(), cred.password, {
            deviceId,
            deviceName: 'Zichan · 同步设置',
          }), '账号密码验证');
          const usageResponse = await withTimeout(fetch(`${baseUrl}/api/v3/blobs/usage`, { headers: { Authorization: `Bearer ${session.accessToken}` } }), '附件能力测试');
          if (!usageResponse.ok) throw new Error(`附件能力 HTTP ${usageResponse.status}`);
          const usageBody = (await usageResponse.json()) as { usage?: { usedBytes?: number; quotaBytes?: number } };
          const used = usageBody.usage?.usedBytes ?? 0;
          const quota = usageBody.usage?.quotaBytes ?? 0;
          patchCredential(profile.id, {
            accessToken: session.accessToken,
            refreshToken: session.refreshToken,
            accessExpiresAt: session.accessExpiresAt,
            sessionId: session.session.id,
          });
          patchProfile(profile.id, {
            serverId: body.serverId,
            lastStatus: 'online',
            lastLatencyMs: latencyMs,
            lastTestAt: new Date().toISOString(),
            lastError: `账号、密码和附件能力验证通过 · ${formatBytes(used)} / ${formatBytes(quota)}`,
          });
        } catch (e) {
          patchProfile(profile.id, { serverId: body.serverId, lastStatus: 'unauthorized', lastLatencyMs: latencyMs, lastTestAt: new Date().toISOString(), lastError: msg(e) });
        }
      } else {
        const lastError = mode === 'auth' ? '未填写用户名或密码，仅完成连通性测试' : '连通性正常';
        patchProfile(profile.id, { serverId: body.serverId, lastStatus: 'online', lastLatencyMs: latencyMs, lastTestAt: new Date().toISOString(), lastError });
      }
    } catch (e) {
      patchProfile(profile.id, { lastStatus: 'offline', lastLatencyMs: Math.round(performance.now() - started), lastTestAt: new Date().toISOString(), lastError: msg(e) });
    } finally {
      setTestingId('');
    }
  }

  async function registerProfile(profile: SyncServerProfile) {
    const cred = credentials[profile.id];
    if (!profile.username.trim() || !cred?.password) throw new Error('请先填写用户名和密码');
    await registerAccount(buildBaseUrl(profile), profile.username.trim(), cred.password, { inviteCode: cred.inviteCode.trim() || undefined });
    patchProfile(profile.id, { lastError: '注册成功，请登录', lastStatus: 'online' });
  }

  async function loginProfile(profile: SyncServerProfile): Promise<string> {
    const cred = credentials[profile.id];
    if (!profile.username.trim() || !cred?.password) throw new Error('请先填写用户名和密码');
    const session = await loginAccount(buildBaseUrl(profile), profile.username.trim(), cred.password, {
      deviceId,
      deviceName: 'Zichan · 当前设备',
    });
    patchCredential(profile.id, {
      accessToken: session.accessToken,
      refreshToken: session.refreshToken,
      accessExpiresAt: session.accessExpiresAt,
      sessionId: session.session.id,
    });
    patchProfile(profile.id, { lastStatus: 'online', lastError: '登录成功' });
    return session.accessToken;
  }

  async function doSync(profile?: SyncServerProfile) {
    setBusy(true);
    try {
      if (!ledgerKey.unlocked) throw new Error('请先解锁账本加密密钥');
      const targets = profile ? [profile] : profiles.filter((p) => p.enabled);
      if (targets.length === 0) {
        setEndpointRows([]);
        setResult(null);
        setSyncNotice('当前没有启用服务器，请先勾选至少一台服务器。');
        return;
      }
      setSyncNotice('');
      const res = await syncConfiguredServers(store, targets.map((target) => ({ ...target, enabled: true })));
      setEndpointRows(res.endpoints);
      const pending = await store.listConflicts();
      const invalid = await store.listSyncCommits({ state: 'invalid', includeInvalid: true });
      registerSync(deviceId, deviceId, res.applied);
      setDevices(listDevices());
      setResult(res);
      setConflicts(pending);
      setInvalidCommits(invalid);
      setProfiles(loadSyncProfiles());
      setLastSyncAt(new Date(res.finishedAt).toLocaleString());
      if (res.endpoints.some((row) => row.error || row.attachments?.error)) {
        setSyncNotice(res.endpoints.flatMap((row) => [row.error, row.attachments?.error].filter((value): value is string => Boolean(value)).map((value) => `${row.alias}：${value}`)).join('；'));
      } else if (!res.converged) {
        setSyncNotice(`已完成 ${res.rounds} 轮同步，但仍有依赖等待收敛；下次同步会继续。`);
      } else if (res.attachmentSync.localMissing > 0) {
        setSyncNotice(`数据已收敛；${res.attachmentSync.localMissing} 个大附件保留在服务器，查看或导出时按需下载。`);
      } else {
        setSyncNotice(`全部服务器已在 ${res.rounds} 轮内收敛。`);
      }
      bump();
    } catch (error) {
      setSyncNotice(`同步失败：${msg(error)}`);
    } finally {
      setBusy(false);
    }
  }

  async function joinRemoteLedger(profile: SyncServerProfile, ledgerId: string) {
    if (joinConfirmation !== '替换本机') return;
    setBusy(true);
    setSyncNotice('正在清空本机账本并加入远端账本…');
    try {
      await store.resetToLedger(ledgerId);
      await reconcileAttachmentStorage(store);
      setJoinTarget(null);
      setJoinConfirmation('');
      setConflicts([]);
      setInvalidCommits([]);
      setResult(null);
      setEndpointRows([]);
      bump();
    } catch (error) {
      setSyncNotice(`加入远端账本失败：${msg(error)}`);
      setBusy(false);
      return;
    }
    setBusy(false);
    await doSync(profile);
  }

  useEffect(() => {
    if (!autoSyncEnabled) {
      setAutoSyncStatus('未启用');
      return;
    }
    const ready = ledgerKey.unlocked && profiles.some((profile) => profile.enabled && profile.username.trim() && credentials[profile.id]?.password);
    if (!ready) {
      setAutoSyncStatus(!ledgerKey.unlocked ? '等待解锁账本密钥' : vault.kind === 'native-stronghold' && !vault.unlocked ? '等待解锁 Stronghold' : '等待启用服务器和账号密码');
    } else {
      setAutoSyncStatus(`每 ${autoSyncMinutes} 分钟；启动、回前台和联网恢复时同步`);
    }
    const onResult = (event: Event) => {
      const detail = (event as CustomEvent<LifecycleSyncResult>).detail;
      setProfiles(loadSyncProfiles());
      setAutoSyncStatus(detail.errors.length
        ? `自动同步部分失败 · ${detail.finishedAt ? new Date(detail.finishedAt).toLocaleTimeString() : ''}`
        : `上次自动同步 ${new Date(detail.finishedAt).toLocaleTimeString()}`);
      setLastSyncAt(new Date(detail.finishedAt).toLocaleString());
      setDevices(listDevices());
      void Promise.all([
        store.listConflicts(),
        store.listSyncCommits({ state: 'invalid', includeInvalid: true }),
      ]).then(([conflictRows, invalidRows]) => {
        setConflicts(conflictRows);
        setInvalidCommits(invalidRows);
      });
    };
    window.addEventListener(SYNC_LIFECYCLE_RESULT_EVENT, onResult);
    return () => window.removeEventListener(SYNC_LIFECYCLE_RESULT_EVENT, onResult);
  }, [autoSyncEnabled, autoSyncMinutes, credentials, ledgerKey.unlocked, profiles, store, vault.kind, vault.unlocked]);

  async function checkAfterConflictResolution() {
    const first = await checkConsistency(store);
    let final = first;
    let recomputed = false;
    if (first.some((issue) => issue.kind === 'chain_cache_stale')) {
      await recomputeCaches(store);
      recomputed = true;
      final = await checkConsistency(store);
    }
    const time = new Date().toLocaleString();
    if (final.length === 0) {
      setMergeNotice(`冲突处理后自检通过${recomputed ? '，已自动重算缓存' : ''} · ${time}`);
    } else {
      setMergeNotice(`冲突处理后自检发现 ${final.length} 个问题${recomputed ? '，已尝试重算缓存' : ''}，请到设置页查看 · ${time}`);
    }
  }

  function selectedRevision(group: SyncConflictGroupRow, aggregate: ConflictAggregate): string {
    return branchChoices[group.id]?.[aggregate.key]
      ?? aggregate.branches.find((branch) => branch.role === 'local')?.revisionId
      ?? aggregate.branches[0]?.revisionId
      ?? '';
  }

  function chooseBranch(groupId: string, key: string, revisionId: string) {
    setBranchChoices((current) => ({
      ...current,
      [groupId]: { ...(current[groupId] ?? {}), [key]: revisionId },
    }));
  }

  function selectedFieldRevision(group: SyncConflictGroupRow, aggregate: ConflictAggregate, field: string): string {
    return fieldChoices[group.id]?.[aggregate.key]?.[field] ?? selectedRevision(group, aggregate);
  }

  function chooseField(groupId: string, key: string, field: string, revisionId: string) {
    setFieldChoices((current) => ({
      ...current,
      [groupId]: {
        ...(current[groupId] ?? {}),
        [key]: { ...(current[groupId]?.[key] ?? {}), [field]: revisionId },
      },
    }));
  }

  async function finishResolution(groupId: string) {
    await reconcileAttachmentStorage(store);
    setConflicts(await store.listConflicts());
    setBranchChoices((current) => {
      const next = { ...current };
      delete next[groupId];
      return next;
    });
    setFieldChoices((current) => {
      const next = { ...current };
      delete next[groupId];
      return next;
    });
    await checkAfterConflictResolution();
    bump();
  }

  async function keepLocal(group: SyncConflictGroupRow) {
    setBusy(true);
    try {
      await resolveConflictGroup(store, group.id, { action: 'keep_local', note: '保留当前本机工作区' });
      await finishResolution(group.id);
    } catch (error) {
      setMergeNotice(`冲突处理失败：${msg(error)}`);
    } finally {
      setBusy(false);
    }
  }

  async function keepSelected(group: SyncConflictGroupRow) {
    const branchRevisionIds = Object.fromEntries(conflictAggregates(group).map((aggregate) => [aggregate.key, selectedRevision(group, aggregate)]));
    setBusy(true);
    try {
      await resolveConflictGroup(store, group.id, { action: 'keep_branch', branchRevisionIds, note: '按聚合选择分支' });
      await finishResolution(group.id);
    } catch (error) {
      setMergeNotice(`冲突处理失败：${msg(error)}`);
    } finally {
      setBusy(false);
    }
  }

  async function mergeByFields(group: SyncConflictGroupRow) {
    const payloads: Record<string, Record<string, unknown> | null> = {};
    for (const aggregate of conflictAggregates(group)) {
      const selected = aggregate.branches.find((branch) => branch.revisionId === selectedRevision(group, aggregate));
      const fallback = selected?.payload ?? aggregate.branches.find((branch) => branch.payload)?.payload ?? null;
      if (!fallback) {
        payloads[aggregate.key] = null;
        continue;
      }
      const merged = { ...fallback };
      for (const field of conflictFields(aggregate.branches)) {
        const branch = aggregate.branches.find((item) => item.revisionId === selectedFieldRevision(group, aggregate, field));
        if (branch?.payload && field in branch.payload) merged[field] = branch.payload[field];
        else delete merged[field];
      }
      payloads[aggregate.key] = merged;
    }
    setBusy(true);
    try {
      await resolveConflictGroup(store, group.id, { action: 'manual_merge', payloads, note: '按字段合并多个分支' });
      await finishResolution(group.id);
    } catch (error) {
      setMergeNotice(`冲突处理失败：${msg(error)}`);
    } finally {
      setBusy(false);
    }
  }

  function exportConflicts() {
    const blob = new Blob([JSON.stringify({ exportedAt: new Date().toISOString(), range: conflictRange, conflicts: filteredConflicts }, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `zichan-sync-conflicts-${new Date().toISOString().slice(0, 10)}.json`;
    a.click();
    URL.revokeObjectURL(url);
  }

  const cred = selected ? credentials[selected.id] ?? { password: '', inviteCode: '' } : { password: '', inviteCode: '' };
  const enabledProfiles = profiles.filter((p) => p.enabled);
  const onlineProfiles = profiles.filter((p) => p.lastStatus === 'online');
  const syncReadyCount = enabledProfiles.filter((p) => credentials[p.id]?.password).length;
  const filteredConflicts = conflicts.filter((conflict) => isDateInRange(localDateOfInstant(conflict.at), conflictRange));
  const selectedRemoteLedgerId = ledgerMismatchId(selected?.lastError);
  const exportInvalidCommits = () => {
    const blob = new Blob([JSON.stringify(invalidCommits, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = `zichan-invalid-sync-commits-${new Date().toISOString().slice(0, 10)}.json`;
    anchor.click();
    URL.revokeObjectURL(url);
  };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 18, maxWidth: tab === 'admin' ? 980 : 980 }}>
      <div style={{ display: 'flex', gap: 8 }}>
        <button onClick={() => setTab('account')} style={tabBtn(tab === 'account')}>同步中心</button>
        <button onClick={() => setTab('admin')} style={tabBtn(tab === 'admin')}>管理后台</button>
      </div>

      {tab === 'admin' ? <ServerAdmin /> : (
        <>
          <div style={card}>
            <div className="zc-responsive-header" style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 14, marginBottom: 14 }}>
              <div>
                <div style={{ fontSize: 16, fontWeight: 900 }}>同步中心</div>
                <div style={{ fontSize: 12, color: 'var(--fg-subtle)', marginTop: 4 }}>
                  解锁账本密钥并验证服务器账号后，同步全部启用服务器；冲突会进入下方冲突箱。
                </div>
              </div>
              <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', justifyContent: 'flex-end' }}>
                <button onClick={() => void doSync()} disabled={busy || !ledgerKey.unlocked || enabledProfiles.length === 0} style={primary}>{busy ? '同步中…' : '同步全部启用服务器'}</button>
                <button onClick={() => setTab('admin')} style={outline}>打开管理后台</button>
              </div>
            </div>
            <div className="zc-sync-kpi-grid" style={{ display: 'grid', gridTemplateColumns: 'repeat(5, minmax(0, 1fr))', gap: 10 }}>
              <SyncTile label="启用服务器" value={`${enabledProfiles.length} / ${profiles.length}`} tone={enabledProfiles.length ? 'var(--positive)' : 'var(--negative)'} />
              <SyncTile label="在线服务器" value={`${onlineProfiles.length}`} tone={onlineProfiles.length ? 'var(--positive)' : 'var(--fg-subtle)'} />
              <SyncTile label="有账号密码" value={`${syncReadyCount}`} tone={syncReadyCount ? 'var(--positive)' : 'var(--fg-subtle)'} />
              <SyncTile label="待处理冲突" value={`${conflicts.length}`} tone={conflicts.length ? 'var(--negative)' : 'var(--positive)'} />
              <SyncTile label="隔离提交" value={`${invalidCommits.length}`} tone={invalidCommits.length ? 'var(--negative)' : 'var(--positive)'} />
            </div>
            <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap', marginTop: 12, paddingTop: 12, borderTop: '1px solid var(--border)' }}>
              <label style={{ display: 'inline-flex', alignItems: 'center', gap: 7, fontSize: 12, fontWeight: 850, color: 'var(--fg-muted)' }}>
                <input type="checkbox" checked={autoSyncEnabled} onChange={(event) => setAutoSyncEnabled(event.target.checked)} />
                自动同步
              </label>
              <select aria-label="自动同步间隔" className="zc-select" value={autoSyncMinutes} onChange={(event) => setAutoSyncMinutes(Number(event.target.value))} disabled={!autoSyncEnabled} style={{ width: 120 }}>
                {[1, 5, 15, 30, 60].map((minutes) => <option key={minutes} value={minutes}>{minutes} 分钟</option>)}
              </select>
              <span style={{ fontSize: 12, color: 'var(--fg-subtle)' }}>{autoSyncStatus}</span>
            </div>
            {enabledProfiles.length === 0 && (
              <div style={{ marginTop: 12, fontSize: 12, color: 'var(--negative)', fontWeight: 800 }}>
                当前没有启用服务器。勾选服务器后，“同步全部启用服务器”才会运行正式远程同步。
              </div>
            )}
          </div>

          <div style={card}>
            <div className="zc-responsive-header" style={{ display: 'flex', justifyContent: 'space-between', gap: 12, alignItems: 'center', marginBottom: 12 }}>
              <div>
                <div style={{ fontSize: 15, fontWeight: 800 }}>账本端到端加密</div>
                <div style={{ fontSize: 12, color: 'var(--fg-subtle)', marginTop: 4 }}>
                  服务器账号密码只用于登录；此处密码解锁账本数据密钥。密钥正文只保留在当前会话内存中。
                </div>
              </div>
              <span style={{ fontSize: 12, fontWeight: 850, color: ledgerKey.unlocked ? 'var(--positive)' : 'var(--fg-subtle)' }}>
                {ledgerKey.unlocked ? `已解锁 · 第 ${ledgerKey.generation} 代` : ledgerKey.initialized ? '已初始化 · 已锁定' : '未初始化'}
              </span>
            </div>
            {!ledgerKey.unlocked ? (
              <div style={{ display: 'flex', alignItems: 'end', gap: 10, flexWrap: 'wrap' }}>
                <div style={{ minWidth: 230, flex: '1 1 260px' }}><label className="zc-label">账本加密密码</label><input aria-label="账本加密密码" className="zc-input" type="password" autoComplete="off" value={ledgerPassword} onChange={(event) => setLedgerPassword(event.target.value)} /></div>
                {!ledgerKey.initialized && <div style={{ minWidth: 230, flex: '1 1 260px' }}><label className="zc-label">确认账本加密密码</label><input aria-label="确认账本加密密码" className="zc-input" type="password" autoComplete="off" value={ledgerPasswordConfirm} onChange={(event) => setLedgerPasswordConfirm(event.target.value)} /></div>}
                <button type="button" onClick={() => void createOrUnlockLedgerKey()} disabled={ledgerKeyBusy || ledgerPassword.length < 8 || (!ledgerKey.initialized && ledgerPassword !== ledgerPasswordConfirm)} style={primary}>{ledgerKeyBusy ? '处理中…' : ledgerKey.initialized ? '解锁' : '创建密钥包'}</button>
                {selected && <button type="button" onClick={() => void fetchRemoteLedgerKey(selected)} disabled={ledgerKeyBusy || !selected.username.trim() || !credentials[selected.id]?.password} style={outline}>从当前服务器获取</button>}
              </div>
            ) : (
              <div style={{ display: 'flex', alignItems: 'end', gap: 10, flexWrap: 'wrap' }}>
                <div style={{ minWidth: 220, flex: '1 1 240px' }}><label className="zc-label">新的或继续使用的账本密码</label><input aria-label="新的账本密码" className="zc-input" type="password" autoComplete="new-password" value={newLedgerPassword} onChange={(event) => setNewLedgerPassword(event.target.value)} /></div>
                <div style={{ minWidth: 220, flex: '1 1 240px' }}><label className="zc-label">确认新密码</label><input aria-label="确认新的账本密码" className="zc-input" type="password" autoComplete="new-password" value={newLedgerPasswordConfirm} onChange={(event) => setNewLedgerPasswordConfirm(event.target.value)} /></div>
                <button type="button" onClick={() => void changeLedgerKeyPassword()} disabled={ledgerKeyBusy || newLedgerPassword.length < 8 || newLedgerPassword !== newLedgerPasswordConfirm} style={outline}>修改密码</button>
                <button type="button" onClick={() => void rotateLedgerDataKeyNow()} disabled={ledgerKeyBusy || newLedgerPassword.length < 8} style={outline}>轮换数据密钥</button>
                <button type="button" onClick={() => lockLedgerKey()} disabled={ledgerKeyBusy} style={outline}>锁定</button>
              </div>
            )}
            {ledgerKeyError && <div style={{ marginTop: 10, color: 'var(--negative)', fontSize: 12, fontWeight: 750 }}>{ledgerKeyError}</div>}
            {ledgerKey.keyringId && <div style={{ marginTop: 10, color: 'var(--fg-subtle)', fontSize: 11 }}>密钥包 {ledgerKey.keyringId} · 账本 {ledgerKey.ledgerId}</div>}
          </div>

          {invalidCommits.length > 0 && (
            <div style={{ ...card, border: '1px solid var(--negative)' }}>
              <div className="zc-responsive-header" style={{ display: 'flex', justifyContent: 'space-between', gap: 12, alignItems: 'center', marginBottom: 8 }}>
                <div>
                  <div style={{ fontSize: 15, fontWeight: 850 }}>隔离提交 <span style={{ color: 'var(--negative)', fontSize: 12 }}>{invalidCommits.length}</span></div>
                  <div style={{ color: 'var(--fg-subtle)', fontSize: 12, marginTop: 4 }}>这些提交未写入账本。修复来源设备的数据后再同步，或导出诊断信息排查。</div>
                </div>
                <button type="button" onClick={exportInvalidCommits} style={outline}>导出诊断 JSON</button>
              </div>
              <div className="zc-scroll-x">
                <table style={{ width: '100%', borderCollapse: 'collapse' }}>
                  <thead><tr><th style={thStyle}>提交</th><th style={thStyle}>来源设备</th><th style={thStyle}>时间</th><th style={thStyle}>失败原因</th></tr></thead>
                  <tbody>
                    {invalidCommits.map((commit) => (
                      <tr key={commit.commitId}>
                        <td style={tdStyle}>{commit.commitId.slice(0, 12)}</td>
                        <td style={tdStyle}>{commit.originDeviceName || commit.originDeviceId}</td>
                        <td style={tdStyle}>{new Date(commit.receivedAt ?? commit.createdAt).toLocaleString()}</td>
                        <td style={{ ...tdStyle, color: 'var(--negative)' }}>{commit.error ?? '未提供错误详情'}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}

          <div style={card}>
            <div className="zc-responsive-header" style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12, marginBottom: 12 }}>
              <div>
                <div style={{ fontSize: 15, fontWeight: 800 }}>服务器配置</div>
                <div style={{ fontSize: 12, color: 'var(--fg-subtle)', marginTop: 4 }}>
                  每台服务器可使用不同账号密码和服务路径；这些凭据与上方账本加密密码相互独立。{vault.message}。
                </div>
              </div>
              <button onClick={addProfile} style={primary}>新增服务器</button>
            </div>

            {vault.kind === 'native-stronghold' && (
              <div style={{ display: 'flex', alignItems: 'end', gap: 10, flexWrap: 'wrap', padding: 12, marginBottom: 14, borderTop: '1px solid var(--border)', borderBottom: '1px solid var(--border)', background: 'var(--surface-2)' }}>
                <div style={{ minWidth: 230, flex: '1 1 260px' }}>
                  <label className="zc-label">Stronghold 本机密码</label>
                  <input
                    aria-label="Stronghold 本机密码"
                    className="zc-input"
                    type="password"
                    autoComplete="off"
                    spellCheck={false}
                    value={vaultPassword}
                    onChange={(event) => setVaultPassword(event.target.value)}
                    onKeyDown={(event) => { if (event.key === 'Enter' && !vault.unlocked) void unlockVault(); }}
                    placeholder={vault.initialized ? '解锁安全密码库' : '至少 8 个字符，用于创建安全密码库'}
                    disabled={vault.unlocked || vaultBusy}
                  />
                </div>
                {!vault.initialized && !vault.unlocked && (
                  <div style={{ minWidth: 230, flex: '1 1 260px' }}>
                    <label className="zc-label">确认本机密码</label>
                    <input aria-label="确认 Stronghold 本机密码" className="zc-input" type="password" autoComplete="off" spellCheck={false} value={vaultPasswordConfirm} onChange={(event) => setVaultPasswordConfirm(event.target.value)} placeholder="再次输入本机密码" disabled={vaultBusy} />
                  </div>
                )}
                <button type="button" onClick={() => void unlockVault()} disabled={vault.unlocked || vaultBusy || vaultPassword.length < 8 || (!vault.initialized && vaultPassword !== vaultPasswordConfirm)} style={vault.unlocked ? outline : primary}>
                  {vault.unlocked ? '已解锁' : vaultBusy ? '解锁中…' : vault.initialized ? '解锁' : '创建并解锁'}
                </button>
                <div style={{ flex: '1 1 240px', fontSize: 12, color: vaultError ? 'var(--negative)' : vault.unlocked ? 'var(--positive)' : 'var(--fg-subtle)', fontWeight: 700 }}>
                  {vaultError || (vault.unlocked ? `Stronghold 已解锁 · ${vault.platform}` : '解锁后才能读取、保存和自动使用服务器账号密码')}
                </div>
              </div>
            )}

            {vault.kind === 'browser-session' && vaultError && (
              <div style={{ color: 'var(--negative)', fontSize: 12, fontWeight: 700, marginBottom: 12 }}>{vaultError}</div>
            )}

            {selected && (
              <div style={{ border: '1px solid var(--border)', borderRadius: 12, padding: 12, background: 'var(--surface-2)', marginBottom: 14 }}>
                <div className="zc-responsive-header" style={{ display: 'flex', justifyContent: 'space-between', gap: 12, alignItems: 'center', marginBottom: 10 }}>
                  <div>
                    <div style={{ fontSize: 13, fontWeight: 900 }}>首次配置向导</div>
                    <div style={{ fontSize: 12, color: 'var(--fg-subtle)', marginTop: 3 }}>选择服务器位置，先把地址和端口套到当前服务器，再填写账号密码。</div>
                  </div>
                  <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', justifyContent: 'flex-end' }}>
                    {WIZARD_MODES.map((item) => (
                      <button key={item.mode} onClick={() => chooseWizardMode(item.mode)} style={tabBtn(wizardMode === item.mode)} title={item.hint}>{item.label}</button>
                    ))}
                  </div>
                </div>
                {wizardMode !== 'local' && (
                  <div className="zc-sync-wizard-grid" style={{ display: 'grid', gridTemplateColumns: wizardMode === 'public' ? '1fr 180px' : '1fr', gap: 10, marginBottom: 10 }}>
                    <div>
                      <label className="zc-label">{wizardMode === 'public' ? '公网域名' : '局域网 IP / 主机名'}</label>
                      <input className="zc-input" value={wizardHost} onChange={(e) => setWizardHost(e.target.value)} placeholder={wizardMode === 'public' ? 'ledger.example.com' : '192.168.1.100'} />
                    </div>
                    {wizardMode === 'public' && (
                      <div>
                        <label className="zc-label">安全路径</label>
                        <input className="zc-input" value={wizardBasePath} onChange={(e) => setWizardBasePath(e.target.value)} placeholder="/zichan" />
                      </div>
                    )}
                  </div>
                )}
                <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
                  <button onClick={applyWizard} style={outline}>套用到当前服务器</button>
                  <button onClick={() => void applyWizardAndTest()} disabled={testingId === selected.id} style={outline}>{testingId === selected.id ? '测试中…' : '套用并测试连通性'}</button>
                  <span style={{ fontSize: 12, color: 'var(--fg-subtle)', fontWeight: 700 }}>
                    {buildBaseUrl({ ...selected, ...wizardPatch(wizardMode, wizardHost, wizardBasePath) })}
                  </span>
                </div>
                {selectedRemoteLedgerId && (
                  <div style={{ marginTop: 14, paddingTop: 14, borderTop: '1px solid var(--negative)' }}>
                    <div style={{ color: 'var(--negative)', fontSize: 12, fontWeight: 900 }}>此账号已绑定另一个账本</div>
                    <div style={{ color: 'var(--fg-subtle)', fontSize: 11, marginTop: 4 }}>
                      远端账本 {selectedRemoteLedgerId}。加入会清空本机账本和操作历史，未引用附件正文先进入本机回收区，然后从该服务器重新拉取。
                    </div>
                    {joinTarget?.profileId !== selected.id ? (
                      <button type="button" disabled={busy} onClick={() => { setJoinTarget({ profileId: selected.id, ledgerId: selectedRemoteLedgerId }); setJoinConfirmation(''); }} style={{ ...danger, marginTop: 10 }}>加入远端账本</button>
                    ) : (
                      <div style={{ display: 'flex', gap: 8, alignItems: 'end', flexWrap: 'wrap', marginTop: 10 }}>
                        <div style={{ minWidth: 240 }}>
                          <label className="zc-label">输入“替换本机”确认</label>
                          <input aria-label="确认替换本机账本" className="zc-input" value={joinConfirmation} onChange={(event) => setJoinConfirmation(event.target.value)} autoComplete="off" />
                        </div>
                        <button type="button" disabled={busy || joinConfirmation !== '替换本机'} onClick={() => void joinRemoteLedger(selected, selectedRemoteLedgerId)} style={danger}>确认清空并加入</button>
                        <button type="button" disabled={busy} onClick={() => { setJoinTarget(null); setJoinConfirmation(''); }} style={outline}>取消</button>
                      </div>
                    )}
                  </div>
                )}
              </div>
            )}

            <div style={{ overflowX: 'auto', marginBottom: 14 }}>
              <table style={{ width: '100%', borderCollapse: 'collapse' }}>
                <thead><tr><th style={thStyle}>启用</th><th style={thStyle}>别名</th><th style={thStyle}>地址</th><th style={thStyle}>用户</th><th style={thStyle}>状态</th><th style={thStyle}>延迟</th><th style={thStyle}></th></tr></thead>
                <tbody>
                  {profiles.map((p) => (
                    <tr key={p.id} onClick={() => setSelectedId(p.id)} style={{ cursor: 'pointer', background: selected?.id === p.id ? 'var(--accent-soft)' : 'transparent' }}>
                      <td style={tdStyle}><input aria-label={`启用 ${p.alias}`} type="checkbox" checked={p.enabled} onChange={(e) => patchProfile(p.id, { enabled: e.target.checked })} onClick={(e) => e.stopPropagation()} /></td>
                      <td style={tdStyle}>{p.alias}</td>
                      <td style={{ ...tdStyle, color: 'var(--fg-muted)' }}>{buildBaseUrl(p)}</td>
                      <td style={tdStyle}>{p.username || '—'}</td>
                      <td style={{ ...tdStyle, color: p.lastStatus === 'online' ? 'var(--positive)' : p.lastStatus === 'unauthorized' ? 'var(--negative)' : 'var(--fg-muted)', fontWeight: 700 }}>{statusText[p.lastStatus ?? 'idle']}</td>
                      <td style={tdStyle}>{p.lastLatencyMs !== undefined ? `${p.lastLatencyMs}ms` : '—'}</td>
                      <td style={{ ...tdStyle, textAlign: 'right' }}>
                        <button onClick={(e) => { e.stopPropagation(); void testProfile(p, 'health'); }} disabled={testingId === p.id} style={outline}>{testingId === p.id ? '测试中…' : '测试连通性'}</button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            {selected && (
              <div style={{ border: '1px solid var(--border)', borderRadius: 12, padding: 14, background: 'var(--surface-2)' }}>
                <div style={{ fontSize: 13, fontWeight: 800, marginBottom: 10 }}>编辑服务器 · {selected.alias}</div>
                <div className="zc-sync-input-grid" style={inputGrid}>
                  <div><label className="zc-label">中文别名</label><input aria-label="中文别名" className="zc-input" value={selected.alias} onChange={(e) => patchProfile(selected.id, { alias: e.target.value })} /></div>
                  <div><label className="zc-label">协议</label><select aria-label="协议" className="zc-select" value={selected.protocol} onChange={(e) => patchProfile(selected.id, { protocol: e.target.value as Protocol })}><option value="http">http</option><option value="https">https</option></select></div>
                  <div><label className="zc-label">主机 / 域名</label><input aria-label="主机或域名" className="zc-input" value={selected.host} onChange={(e) => patchProfile(selected.id, { host: e.target.value })} /></div>
                  <div><label className="zc-label">端口</label><input aria-label="端口" className="zc-input" value={selected.port} onChange={(e) => patchProfile(selected.id, { port: e.target.value })} placeholder="443" /></div>
                  <div><label className="zc-label">服务路径</label><input aria-label="服务路径" className="zc-input" value={selected.basePath} onChange={(e) => patchProfile(selected.id, { basePath: normalizeBasePath(e.target.value) })} placeholder="/zichan-home" /></div>
                  <div><label className="zc-label">用户名</label><input aria-label="用户名" className="zc-input" value={selected.username} onChange={(e) => patchProfile(selected.id, { username: e.target.value })} /></div>
                  <div><label className="zc-label">服务器账号密码{vault.kind === 'browser-session' ? '（当前标签页）' : '（Stronghold）'}</label><input aria-label="服务器账号密码" className="zc-input" type="password" value={cred.password} disabled={vault.kind === 'native-stronghold' && !vault.unlocked} onChange={(e) => patchCredential(selected.id, { password: e.target.value, accessToken: undefined, refreshToken: undefined, accessExpiresAt: undefined, sessionId: undefined })} /></div>
                  <div><label className="zc-label">邀请码</label><input aria-label="邀请码" className="zc-input" value={cred.inviteCode} disabled={vault.kind === 'native-stronghold' && !vault.unlocked} onChange={(e) => patchCredential(selected.id, { inviteCode: e.target.value })} /></div>
                </div>
                <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
                  <button onClick={() => void testProfile(selected, 'auth')} disabled={busy || testingId === selected.id} style={outline}>{testingId === selected.id ? '验证中…' : '验证账号密码'}</button>
                  <button onClick={() => void registerProfile(selected).catch((e) => patchProfile(selected.id, { lastStatus: 'offline', lastError: msg(e) }))} disabled={busy} style={outline}>注册</button>
                  <button onClick={() => void loginProfile(selected).catch((e) => patchProfile(selected.id, { lastStatus: 'unauthorized', lastError: msg(e) }))} disabled={busy} style={outline}>登录</button>
                  <button onClick={() => void doSync(selected)} disabled={busy || !ledgerKey.unlocked} style={primary}>{busy ? '同步中…' : '同步此服务器'}</button>
                  <button
                    onClick={() => void removeProfile(selected.id)}
                    disabled={profiles.length <= 1 || busy || (vault.kind === 'native-stronghold' && vault.initialized && !vault.unlocked)}
                    title={vault.kind === 'native-stronghold' && vault.initialized && !vault.unlocked ? '请先解锁 Stronghold，确保同步凭据一并删除' : '删除服务器'}
                    style={danger}
                  >删除</button>
                  <span style={{ fontSize: 12, color: 'var(--fg-muted)' }}>
                    {selected.serverId ? `服务器 ID：${selected.serverId}` : '尚未识别服务器 ID'}
                    {selected.replicaId ? ` · 副本 ID：${selected.replicaId}` : ''}
                    {selected.streamEpoch ? ` · 流世代：${selected.streamEpoch}` : ''}
                    {selected.ledgerId ? ` · 账本 ID：${selected.ledgerId}` : ''}
                    {selected.lastError ? ` · ${selected.lastError}` : ''}
                  </span>
                </div>
              </div>
            )}
          </div>

          <div style={card}>
            <div className="zc-responsive-header" style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
              <div>
                <div style={{ fontSize: 15, fontWeight: 800 }}>同步结果</div>
                <div style={{ fontSize: 12, color: 'var(--fg-subtle)', marginTop: 4 }}>
                  本机设备 · <span style={{ fontWeight: 700, color: 'var(--fg-muted)' }}>{deviceId}</span>
                  {lastSyncAt && <> · 上次同步 {lastSyncAt}</>}
                </div>
              </div>
              <button onClick={() => void doSync()} disabled={busy || !ledgerKey.unlocked || enabledProfiles.length === 0} style={{ ...primary, padding: '10px 18px', fontSize: 13 }}>
                {busy ? '同步中…' : '同步全部启用服务器'}
              </button>
            </div>
            {enabledProfiles.length === 0 && (
              <div style={{ fontSize: 12, color: 'var(--fg-subtle)', marginTop: 12 }}>
                当前没有启用服务器；“同步全部启用服务器”不会自动使用本地演示云。
              </div>
            )}
            {syncNotice && (
              <div style={{ fontSize: 12, color: syncNotice.includes('没有启用') ? 'var(--negative)' : 'var(--fg-muted)', marginTop: 10, fontWeight: 800 }}>
                {syncNotice}
              </div>
            )}
            {mergeNotice && (
              <div style={{ fontSize: 12, color: mergeNotice.includes('发现') ? 'var(--negative)' : 'var(--positive)', marginTop: 10, fontWeight: 800 }}>
                {mergeNotice}
              </div>
            )}
            {result && (
              <>
                <div style={{ fontSize: 13, color: 'var(--fg-muted)', marginTop: 12 }}>
                  本次同步：拉取 <b style={{ color: 'var(--fg)' }}>{result.pulled}</b> 个提交，推送 <b style={{ color: 'var(--fg)' }}>{result.pushed}</b> 个提交，应用 <b style={{ color: 'var(--fg)' }}>{result.applied}</b> 个聚合
                  {result.conflicts > 0 && <>，新增 <b style={{ color: 'var(--negative)' }}>{result.conflicts}</b> 个冲突提交</>}
                  {result.conflicts === 0 && <>，无新增冲突</>}；共 {result.rounds} 轮，
                  <b style={{ color: result.converged ? 'var(--positive)' : 'var(--negative)' }}>{result.converged ? '已收敛' : '未完全收敛'}</b>
                </div>
                <div style={{ fontSize: 12, color: 'var(--fg-subtle)', marginTop: 6 }}>
                  附件对象 {result.attachmentSync.references} 个 · 本机可用 {result.attachmentSync.localReady} 个 · 按需下载 {result.attachmentSync.localMissing} 个 · 本轮上传 {result.attachmentSync.endpoints.reduce((sum, row) => sum + row.uploaded, 0)} 个
                </div>
                {endpointRows.length > 0 && (
                  <div className="zc-sync-result-grid" style={{ display: 'grid', gridTemplateColumns: '110px 1fr 140px 60px 60px 90px 120px 70px', gap: 8, marginTop: 12, fontSize: 12 }}>
                    <div style={gridHead}>别名</div><div style={gridHead}>端点</div><div style={gridHead}>副本 ID</div><div style={gridHead}>拉取</div><div style={gridHead}>推送</div><div style={gridHead}>游标 / Head</div><div style={gridHead}>附件</div><div style={gridHead}>延迟</div>
                    {endpointRows.map((row) => (
                      <div key={row.id} style={{ display: 'contents' }}>
                        <div style={{ color: row.error ? 'var(--negative)' : 'var(--fg-muted)', fontWeight: 700 }}>{row.alias}</div>
                        <div style={{ color: row.error || row.attachments?.error ? 'var(--negative)' : 'var(--fg-muted)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{row.url}{row.error ? ` · ${row.error}` : row.attachments?.error ? ` · ${row.attachments.error}` : ''}</div>
                        <div style={{ color: 'var(--fg-muted)' }}>{row.identity?.replicaId ?? '—'}</div>
                        <div>{row.pulled}</div><div>{row.pushed}</div><div>{row.cursor} / {row.headSeq}</div><div>{row.attachments ? `${row.attachments.available}/${result.attachmentSync.references} · ↑${row.attachments.uploaded}` : '—'}</div><div>{row.latencyMs}ms</div>
                      </div>
                    ))}
                  </div>
                )}
              </>
            )}
          </div>

          <div style={card}>
            <div style={{ fontSize: 15, fontWeight: 800, marginBottom: 12 }}>设备</div>
            <div className="zc-scroll-x"><table style={{ width: '100%', borderCollapse: 'collapse' }}>
              <thead><tr><th style={thStyle}>设备 ID</th><th style={thStyle}>上次同步</th><th style={thStyle}>上次应用</th></tr></thead>
              <tbody>
                {devices.map((d) => (
                  <tr key={d.deviceId}>
                    <td style={tdStyle}>{d.deviceId}{d.deviceId === deviceId && <span style={{ color: 'var(--accent)', marginLeft: 6 }}>· 本机</span>}</td>
                    <td style={tdStyle}>{new Date(d.lastSyncAt).toLocaleString()}</td>
                    <td style={tdStyle}>{d.applied} 条</td>
                  </tr>
                ))}
                {devices.length === 0 && <tr><td style={{ ...tdStyle, color: 'var(--fg-subtle)' }} colSpan={3}>还没有设备同步过，点上方同步后这里会出现本机</td></tr>}
              </tbody>
            </table></div>
          </div>

          {conflicts.length > 0 && (
            <div style={{ ...card, border: '1px solid var(--negative)' }}>
              <div className="zc-responsive-header" style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12, marginBottom: 4 }}>
                <div style={{ fontSize: 15, fontWeight: 800 }}>冲突箱 <span style={{ fontSize: 12, color: 'var(--negative)', fontWeight: 700 }}>{filteredConflicts.length}/{conflicts.length}</span></div>
                <button onClick={exportConflicts} style={outline}>导出冲突 JSON</button>
              </div>
              <div style={{ fontSize: 12, color: 'var(--fg-subtle)', marginBottom: 12 }}>
                冲突按原子提交分组，所有设备分支都会保留。可整项选择版本，也可逐字段组合，确认后会生成一条可继续同步的合并提交。
              </div>
              <div style={{ marginBottom: 12 }}><DateRangeBar value={conflictRange} onChange={setConflictRange} compact /></div>
              <div style={{ display: 'flex', flexDirection: 'column' }}>
                {filteredConflicts.map((c) => (
                  <section key={c.id} style={{ borderTop: '1px solid var(--border)', padding: '16px 0' }}>
                    <div className="zc-responsive-header" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'start', gap: 12, marginBottom: 12 }}>
                      <div>
                        <div style={{ fontSize: 13, fontWeight: 900 }}>冲突组 {c.id.slice(0, 8)} · {conflictAggregates(c).length} 个聚合 · {c.remoteCommitIds.length} 个远端提交</div>
                        <div style={{ fontSize: 11, color: 'var(--fg-subtle)', marginTop: 4 }}>
                          {new Date(c.at).toLocaleString()} · {c.changedPaths.map((path) => path.split('.').map(fieldLabel).join(' / ')).join('，') || '因果分支冲突'}
                        </div>
                      </div>
                      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', justifyContent: 'flex-end' }}>
                        <button disabled={busy} onClick={() => void keepLocal(c)} style={outline}>全部保留本机</button>
                        <button disabled={busy} onClick={() => void keepSelected(c)} style={outline}>采用所选分支</button>
                        <button disabled={busy} onClick={() => void mergeByFields(c)} style={primary}>按字段合并</button>
                      </div>
                    </div>
                    {conflictAggregates(c).map((aggregate) => {
                      const fields = conflictFields(aggregate.branches);
                      const selectedId = selectedRevision(c, aggregate);
                      const selectedPayload = aggregate.branches.find((branch) => branch.revisionId === selectedId)?.payload
                        ?? aggregate.branches[0]?.payload
                        ?? null;
                      return (
                        <div key={aggregate.key} style={{ padding: '12px 0', borderTop: '1px solid var(--border)' }}>
                          <div className="zc-responsive-header" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 12, marginBottom: 8 }}>
                            <div style={{ fontSize: 12, fontWeight: 900 }}>{aggregateTitle(aggregate.type, aggregate.id, selectedPayload, snap)}</div>
                            <label style={{ display: 'flex', alignItems: 'center', gap: 7, fontSize: 11, color: 'var(--fg-subtle)', fontWeight: 800 }}>
                              整项采用
                              <select className="zc-select" value={selectedId} onChange={(event) => chooseBranch(c.id, aggregate.key, event.target.value)} style={{ height: 32, minWidth: 190 }}>
                                {aggregate.branches.map((branch, index) => <option key={branch.revisionId} value={branch.revisionId}>{branchLabel(branch, index)}</option>)}
                              </select>
                            </label>
                          </div>
                          <div style={{ overflowX: 'auto' }}>
                            <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12 }}>
                              <thead><tr>
                                <th style={thStyle}>字段</th>
                                {aggregate.branches.map((branch, index) => <th key={branch.revisionId} style={thStyle}>{branchLabel(branch, index)}</th>)}
                                <th style={thStyle}>字段采用</th>
                              </tr></thead>
                              <tbody>
                                {fields.map((field) => (
                                  <tr key={field}>
                                    <td style={tdStyle}>{fieldLabel(field)}</td>
                                    {aggregate.branches.map((branch) => <td key={branch.revisionId} style={{ ...tdStyle, whiteSpace: 'normal', minWidth: 150 }}>{formatValue(field, branch.payload?.[field], snap)}</td>)}
                                    <td style={tdStyle}>
                                      <select aria-label={`冲突字段 ${fieldLabel(field)} 采用`} className="zc-select" value={selectedFieldRevision(c, aggregate, field)} onChange={(event) => chooseField(c.id, aggregate.key, field, event.target.value)} style={{ height: 32, minWidth: 160 }}>
                                        {aggregate.branches.map((branch, index) => <option key={branch.revisionId} value={branch.revisionId}>{branchLabel(branch, index)}</option>)}
                                      </select>
                                    </td>
                                  </tr>
                                ))}
                              </tbody>
                            </table>
                          </div>
                          <details style={{ marginTop: 8 }}>
                            <summary style={{ cursor: 'pointer', color: 'var(--fg-subtle)', fontSize: 11, fontWeight: 700 }}>查看各分支原始 JSON</summary>
                            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(240px, 1fr))', gap: 10, marginTop: 8 }}>
                              {aggregate.branches.map((branch, index) => (
                                <div key={branch.revisionId}>
                                  <div style={{ fontSize: 10, color: 'var(--fg-subtle)', marginBottom: 4 }}>{branchLabel(branch, index)} · {branch.commitId.slice(0, 8)}</div>
                                  <code style={{ display: 'block', color: 'var(--fg-muted)', wordBreak: 'break-all', fontSize: 11 }}>{biz(branch.payload)}</code>
                                </div>
                              ))}
                            </div>
                          </details>
                        </div>
                      );
                    })}
                  </section>
                ))}
                {filteredConflicts.length === 0 && <div style={{ color: 'var(--fg-subtle)', fontSize: 12 }}>该时间范围内没有待处理冲突。</div>}
              </div>
            </div>
          )}
        </>
      )}
    </div>
  );
}

const tabBtn = (active: boolean) => ({
  padding: '9px 16px',
  borderRadius: 10,
  fontSize: 13,
  fontWeight: 800,
  cursor: 'pointer',
  background: active ? 'var(--accent-soft)' : 'var(--surface)',
  color: active ? 'var(--accent)' : 'var(--fg-muted)',
  border: `1px solid ${active ? 'var(--accent)' : 'var(--border)'}`,
}) as const;

const gridHead = { color: 'var(--fg-subtle)', fontWeight: 800 } as const;

function SyncTile({ label, value, tone }: { label: string; value: string; tone: string }) {
  return (
    <div style={{ border: '1px solid var(--border)', borderRadius: 12, padding: 11, background: 'var(--surface-2)' }}>
      <div style={{ fontSize: 11, color: 'var(--fg-subtle)', fontWeight: 800 }}>{label}</div>
      <div style={{ fontSize: 20, color: tone, fontWeight: 900, marginTop: 4 }}>{value}</div>
    </div>
  );
}
