import { useEffect, useMemo, useRef, useState } from 'react';
import {
  requestJson, aggregateKey, registerAccount, loginAccount, fetchAuthMe, fetchLedgerKeyEnvelope, checkConsistency, recomputeCaches, resolveConflictGroup,
  type StoredSyncCommit, type SyncConflictBranchRow, type SyncConflictGroupRow,
} from '@zichan/db';
import { ProfileOperations, type ProfileOperation } from '../profile-operation.js';
import { revokeConnectionSession } from '../revoke-connection-session.js';
import { ConfirmDialog } from '../ui/ConfirmDialog.js';
import { accountProtection } from '../account-protection.js';
import { LedgerProtectionPanel } from '../ui/LedgerProtectionPanel.js';
import { ServerCustodyPanel } from '../ui/ServerCustodyPanel.js';
import { isDateInRange } from '@zichan/core';
import { useStore } from '../db/store.js';
import { useSnapshot, type Snapshot } from '../db/snapshot.js';
import { reconcileAttachmentStorage } from '../db/attachment-storage.js';
import { saveLedgerBackup } from '../db/backups.js';
import {
  getDeviceId,
  listDevices,
  registerSync,
} from '../db/cloud.js';
import { btnDanger, btnOutline, btnPrimary, card, td as tdStyle, th as thStyle } from '../ui/styles.js';
import { categoryLabel, TYPE_LABEL } from '../transactionMeta.js';
import { DateRangeBar, dateRangeValue, localDateOfInstant, type DateRangeValue } from '../ui/DateRangeBar.js';
import {
  buildSyncBaseUrl as buildBaseUrl,
  buildSyncUrlFromParts,
  isDeviceLocalSyncUrl,
  loadAutoSync,
  loadSyncConnections,
  mergeSyncUrlScopes,
  newSyncConnection as newProfile,
  normalizeSyncBaseUrl,
  parseSyncBaseUrl,
  saveAutoSync,
  saveSyncConnections,
  syncAddressPresetUrl,
  type ServerCredential,
  type SyncAddressPreset,
  type SyncConnection,
  type SyncConnectionStatus,
  type SyncProtocol as Protocol,
  type SyncUrlParts,
} from '../sync-config.js';
import {
  CREDENTIALS_CHANGED_EVENT,
  VAULT_STATE_CHANGED_EVENT,
  credentialRevision, runtimeCredential, credentialVaultState,
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
  adoptUnlockedLedgerKeyEnvelope,
  initializeLedgerKey,
  ledgerKeyState,
  lockLedgerKey,
  requireLedgerCryptoSession,
  rotateLedgerKey,
  storedLedgerKeyEnvelope,
  unlockLedgerKey,
  updateLedgerPassphrase,
  type LedgerKeyState,
} from '../ledger-key-vault.js';
import { commitRemoteLedgerJoin, prepareRemoteLedgerJoin } from '../remote-ledger-join.js';
import { successfulBackupSafetyPatch, writeSafetyState } from '../db/safety.js';
import {
  loadSharedSyncDirectory,
  mergeSharedSyncDirectory,
  saveSharedSyncDirectory,
  sharedDirectoryFromConnections,
} from '../sync-server-directory.js';
import {
  clearConnectionLinkHash,
  connectionLinkFromLocation,
  createSyncConnectionLink,
  fingerprintServerPublicKey,
  parseSyncConnectionLink,
} from '../connection-link.js';
import { copyTextToClipboard } from '../ui/diagnostics.js';
import { authenticateSyncProfile, hasAccountSession, preferredSessionTransport } from '../sync-auth.js';
import { isPrimaryWebConnection } from '../web-sync-connections.js';

const REQUEST_TIMEOUT_MS = 5_000;
type WizardMode = SyncAddressPreset;

interface SyncHealthInfo {
  serverId: string;
  serverPublicKey: string;
  claimed: boolean;
  registrationMode: 'open' | 'invite' | 'closed';
}

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
      && a.sessionTransport === b.sessionTransport
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
  { mode: 'current', label: '当前网站', hint: '使用当前 Web 所在地址及部署路径' },
  { mode: 'local', label: '本机服务器', hint: '桌面端或当前电脑运行 8787 服务' },
  { mode: 'lan', label: '局域网电脑', hint: '家里常开电脑、NAS 或固定内网 IP' },
  { mode: 'public', label: '公网域名', hint: 'HTTPS 域名，可带安全路径' },
];

function wizardPatch(mode: WizardMode, host: string, path: string): Partial<SyncConnection> {
  const baseUrl = syncAddressPresetUrl(mode, { host, path });
  const local = isDeviceLocalSyncUrl(baseUrl);
  const alias = mode === 'current'
    ? '当前网站'
    : mode === 'local'
      ? '本机服务器'
      : mode === 'lan'
        ? '家里电脑'
        : '公网服务器';
  return {
    alias,
    baseUrl,
    activeUrl: baseUrl,
    sharedUrls: local ? [] : [baseUrl],
    deviceUrls: local ? [baseUrl] : [],
    alternateUrls: [],
    enabled: true,
    status: 'unchecked',
    lastError: undefined,
  };
}

function fetchHealth(baseUrl: string, signal?: AbortSignal) {
  return requestJson(`${baseUrl}/api/health`, { redirect: 'error', cache: 'no-store' }, { signal, timeoutMs: REQUEST_TIMEOUT_MS });
}

const statusText: Record<SyncConnectionStatus, string> = {
  unchecked: '未测试',
  online: '在线',
  login_required: '需要登录',
  offline: '离线',
  identity_changed: '身份已变化',
};

const outline = btnOutline;
const primary = btnPrimary;
const danger = btnDanger;
const inputGrid = { display: 'grid', gridTemplateColumns: '1fr 120px 1fr 100px', gap: 10, marginBottom: 10 } as const;

export function Sync() {
  const { store, bump } = useStore();
  const snap = useSnapshot('sync');
  const [profiles, setProfiles] = useState<SyncConnection[]>(loadSyncConnections);
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
  const operations = useRef(new ProfileOperations());
  const activeOperation = useRef<ProfileOperation>();
  const loginFeedbackGeneration = useRef(0);
  const [passwordConfirm, setPasswordConfirm] = useState('');
  const [removeTarget, setRemoveTarget] = useState<string>();
  const [removeWarning, setRemoveWarning] = useState('');
  useEffect(() => () => { loginFeedbackGeneration.current++; operations.current.cancelAll(); }, []);
  const [lastSyncAt, setLastSyncAt] = useState('');
  const [syncNotice, setSyncNotice] = useState('');
  const [mergeNotice, setMergeNotice] = useState('');
  const [endpointRows, setEndpointRows] = useState<ConfiguredSyncEndpoint[]>([]);
  const [healthByConnection, setHealthByConnection] = useState<Record<string, SyncHealthInfo>>({});
  const [sharedDirectoryReady, setSharedDirectoryReady] = useState(false);
  const [directoryError, setDirectoryError] = useState('');
  const [directoryRetry, setDirectoryRetry] = useState(0);
  const [connectionLinkDraft, setConnectionLinkDraft] = useState('');
  const [connectionShare, setConnectionShare] = useState<{ link: string; qrDataUrl: string } | null>(null);
  const [wizardMode, setWizardMode] = useState<WizardMode>('local');
  const [wizardHost, setWizardHost] = useState('192.168.1.100');
  const [wizardBasePath, setWizardBasePath] = useState('/zichan');
  const [joinTarget, setJoinTarget] = useState<{ profileId: string; ledgerId: string } | null>(null);
  const [joinConfirmation, setJoinConfirmation] = useState('');
  const [joinLedgerPassword, setJoinLedgerPassword] = useState('');
  const deviceId = getDeviceId();
  const [devices, setDevices] = useState(listDevices());
  const msg = (e: unknown) => (e instanceof Error ? e.message : String(e));

  const selected = useMemo(() => profiles.find((p) => p.id === selectedId) ?? profiles[0], [profiles, selectedId]);
  const selectedConnectionId = selected?.id;
  const primaryConnection = profiles.find(isPrimaryWebConnection);
  const selectedIsPrimary = Boolean(selected && isPrimaryWebConnection(selected));
  const selectedBaseUrl = selected?.baseUrl;
  const sharedDirectorySignature = useMemo(() => JSON.stringify(sharedDirectoryFromConnections(profiles)), [profiles]);
  const latestProfiles = useRef(profiles);
  latestProfiles.current = profiles;
  const [addressDraft, setAddressDraft] = useState(selected?.baseUrl ?? '');
  const [addressParts, setAddressParts] = useState<SyncUrlParts>(() => parseSyncBaseUrl(selected?.baseUrl ?? syncAddressPresetUrl('current')));
  const [addressError, setAddressError] = useState('');
  const [advancedAddress, setAdvancedAddress] = useState(false);

  useEffect(() => {
    saveSyncConnections(profiles);
  }, [profiles]);

  useEffect(() => {
    const payload = connectionLinkFromLocation();
    if (payload) importConnectionLink(globalThis.location.href);
    // Importing the initial hash is intentionally a mount-only action; the handler clears it.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    let cancelled = false;
    setSharedDirectoryReady(false);
    setDirectoryError('');
    void loadSharedSyncDirectory(store).then((servers) => {
      if (cancelled) return;
      setProfiles((current) => mergeSharedSyncDirectory(current, servers));
      setSharedDirectoryReady(true);
    }).catch((error) => {
      if (!cancelled) {
        setSharedDirectoryReady(false);
        setDirectoryError(`共享服务器目录读取失败，已暂停自动写回：${msg(error)}`);
      }
    });
    return () => { cancelled = true; };
  }, [store, directoryRetry]);

  useEffect(() => {
    if (!sharedDirectoryReady) return;
    const timer = window.setTimeout(() => {
      void saveSharedSyncDirectory(store, latestProfiles.current).catch((error) => {
        setSharedDirectoryReady(false);
        setDirectoryError(`共享服务器目录保存失败，已暂停自动写回：${msg(error)}`);
      });
    }, 500);
    return () => window.clearTimeout(timer);
  }, [sharedDirectoryReady, sharedDirectorySignature, store]);

  useEffect(() => {
    setPasswordConfirm('');
    const pending = operations.current;
    const feedback = loginFeedbackGeneration;
    return () => {
      if (!selectedConnectionId) return;
      feedback.current++;
      pending.cancel(selectedConnectionId);
      const current = runtimeCredential(selectedConnectionId);
      if (current?.password || current?.inviteCode) setRuntimeCredential(selectedConnectionId, { ...current, password: '', inviteCode: '' });
    };
  }, [selectedConnectionId]);

  useEffect(() => {
    if (!selectedBaseUrl) return;
    setAddressDraft(selectedBaseUrl);
    try {
      setAddressParts(parseSyncBaseUrl(selectedBaseUrl));
      setAddressError('');
    } catch (error) {
      setAddressError(msg(error));
    }
  }, [selectedConnectionId, selectedBaseUrl]);

  useEffect(() => {
    const refreshCredentials = () => {
      operations.current.cancelStale();
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
        if (credential?.refreshToken) {
          void persistCredential(profile.id, credential).catch((error) => setVaultError(`保存 ${profile.alias} 的会话失败：${msg(error)}`));
        } else if (credential && !credential.password && !credential.inviteCode) {
          void deleteCredential(profile.id).catch((error) => setVaultError(`删除 ${profile.alias} 的会话失败：${msg(error)}`));
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

  function patchProfile(id: string, patch: Partial<SyncConnection>) {
    if (isPrimaryWebConnection({ id })) {
      // Editing a sync target must not change the account owning this Web cache.
      const { username: _username, baseUrl: _baseUrl, activeUrl: _activeUrl, enabled: _enabled, ...safe } = patch;
      patch = safe;
    }
    if (patch.username !== undefined && latestProfiles.current.find((row) => row.id === id)?.username !== patch.username) {
      patch = { ...patch, accountId: undefined, role: undefined, ledgerId: undefined, replicaId: undefined, streamEpoch: undefined, status: 'login_required' };
      patchCredential(id, { password: '', inviteCode: '', accessToken: undefined, refreshToken: undefined, accessExpiresAt: undefined, sessionId: undefined, sessionTransport: undefined });
    }
    const previous = latestProfiles.current.find((row) => row.id === id);
    if (previous && (patch.username !== undefined && patch.username !== previous.username
      || patch.baseUrl !== undefined && patch.baseUrl !== previous.baseUrl
      || patch.activeUrl !== undefined && patch.activeUrl !== previous.activeUrl
      || patch.expectedServerPublicKeyFingerprint !== undefined && patch.expectedServerPublicKeyFingerprint !== previous.expectedServerPublicKeyFingerprint)) {
      loginFeedbackGeneration.current++;
      operations.current.cancel(id);
    }
    const next = latestProfiles.current.map((row) => row.id === id ? { ...row, ...patch } : row);
    latestProfiles.current = next;
    setProfiles(next);
  }

  function editAddressDraft(value: string) {
    loginFeedbackGeneration.current++;
    if (selected) operations.current.cancel(selected.id);
    setAddressDraft(value);
    try {
      setAddressParts(parseSyncBaseUrl(value));
      setAddressError('');
    } catch (error) {
      setAddressError(msg(error));
    }
  }

  function editAddressPart(patch: Partial<SyncUrlParts>) {
    loginFeedbackGeneration.current++;
    if (selected) operations.current.cancel(selected.id);
    const next = { ...addressParts, ...patch };
    setAddressParts(next);
    try {
      setAddressDraft(buildSyncUrlFromParts(next));
      setAddressError('');
    } catch (error) {
      setAddressError(msg(error));
    }
  }

  function saveAddress() {
    if (!selected || selectedIsPrimary) return;
    try {
      const baseUrl = normalizeSyncBaseUrl(addressDraft);
      const local = isDeviceLocalSyncUrl(baseUrl);
      const previousUrls = selected.serverId ? [selected.baseUrl, ...selected.alternateUrls] : [];
      const alternateUrls = [...new Set(previousUrls.filter((url) => url !== baseUrl))];
      patchProfile(selected.id, {
        baseUrl,
        activeUrl: baseUrl,
        alternateUrls,
        sharedUrls: local ? selected.sharedUrls.filter((url) => url !== baseUrl) : [...new Set([...selected.sharedUrls, baseUrl])],
        deviceUrls: local ? [...new Set([...selected.deviceUrls, baseUrl])] : selected.deviceUrls.filter((url) => url !== baseUrl),
        status: 'unchecked',
        lastError: '地址已保存，请先验证服务器身份后再登录',
      });
      setAddressDraft(baseUrl);
      setAddressParts(parseSyncBaseUrl(baseUrl));
      setAddressError('');
    } catch (error) {
      setAddressError(msg(error));
    }
  }

  function setActiveAddressShared(shared: boolean) {
    if (!selected) return;
    const baseUrl = normalizeSyncBaseUrl(selected.baseUrl);
    patchProfile(selected.id, {
      sharedUrls: shared
        ? [...new Set([...selected.sharedUrls, baseUrl])]
        : selected.sharedUrls.filter((url) => url !== baseUrl),
      deviceUrls: shared
        ? selected.deviceUrls.filter((url) => url !== baseUrl)
        : [...new Set([...selected.deviceUrls, baseUrl])],
    });
  }

  function patchCredential(id: string, patch: Partial<ServerCredential>) {
    if (patch.password !== undefined || patch.inviteCode !== undefined) loginFeedbackGeneration.current++;
    if (patch.password !== undefined) setPasswordConfirm('');
    const next = { password: '', inviteCode: '', ...runtimeCredential(id), ...patch };
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
      setSyncNotice(vault.initialized ? 'Stronghold 已解锁，自动同步可以使用已保存会话。' : 'Stronghold 已创建，后续登录会话会加密保存，不保存账号密码。');
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

  async function fetchRemoteLedgerKey(profile: SyncConnection) {
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
    const p = {
      ...newProfile(),
      alias: `服务器${profiles.length + 1}`,
      username: profiles.find((profile) => profile.username.trim())?.username ?? '',
    };
    setProfiles((rows) => [...rows, p]);
    setSelectedId(p.id);
  }

  function importConnectionLink(input: string) {
    try {
      const payload = parseSyncConnectionLink(input);
      const existing = profiles.find((profile) => profile.serverId === payload.serverId);
      if (existing) {
        if (isPrimaryWebConnection(existing)) throw new Error('这是本站登录服务器；登录地址保持不变，请为其他服务器添加连接。');
        const local = isDeviceLocalSyncUrl(payload.url);
        patchProfile(existing.id, {
          baseUrl: payload.url,
          activeUrl: payload.url,
          alternateUrls: [...new Set([existing.baseUrl, ...existing.alternateUrls].filter((url) => url !== payload.url))],
          sharedUrls: local ? existing.sharedUrls : [...new Set([...existing.sharedUrls, payload.url])],
          deviceUrls: local ? [...new Set([...existing.deviceUrls, payload.url])] : existing.deviceUrls,
          expectedServerPublicKeyFingerprint: payload.serverPublicKeyFingerprint,
          status: 'unchecked',
          lastError: '已导入备用地址，请验证服务器身份',
        });
        setSelectedId(existing.id);
      } else {
        const connection = {
          ...newProfile(payload.url),
          alias: payload.alias,
          serverId: payload.serverId,
          expectedServerPublicKeyFingerprint: payload.serverPublicKeyFingerprint,
          status: 'unchecked' as const,
          lastError: '连接来自无秘密分享链接；登录前必须验证服务器身份',
        };
        setProfiles((rows) => [...rows, connection]);
        setSelectedId(connection.id);
      }
      setConnectionLinkDraft('');
      clearConnectionLinkHash();
      setSyncNotice('连接链接已导入；链接不含用户名、密码或会话，请先测试身份再登录。');
    } catch (error) {
      setSyncNotice(`连接链接导入失败：${msg(error)}`);
    }
  }

  async function createConnectionShare(profile: SyncConnection) {
    if (!profile.serverId || !profile.serverPublicKey) {
      setSyncNotice('请先测试连通性并固定服务器身份，再创建连接链接。');
      return;
    }
    try {
      const fingerprint = await fingerprintServerPublicKey(profile.serverPublicKey);
      const link = createSyncConnectionLink({
        version: 1,
        alias: profile.alias,
        url: profile.baseUrl,
        serverId: profile.serverId,
        serverPublicKeyFingerprint: fingerprint,
      });
      const { toDataURL } = await import('qrcode');
      const qrDataUrl = await toDataURL(link, { errorCorrectionLevel: 'M', margin: 2, width: 260, color: { dark: '#672f20', light: '#fffdf9' } });
      setConnectionShare({ link, qrDataUrl });
    } catch (error) {
      setSyncNotice(`连接链接生成失败：${msg(error)}`);
    }
  }

  async function removeProfile(id: string, localOnly = false) {
    if (profiles.length <= 1 || isPrimaryWebConnection({ id })) return;
    operations.current.cancel(id);
    setBusy(true);
    try {
      const profile = latestProfiles.current.find((row) => row.id === id);
      if (!profile) { setRemoveTarget(undefined); return; }
      if (!localOnly && !await revokeConnectionSession(profile, runtimeCredential(id))) {
        setRemoveWarning('服务器会话撤销未确认（可能离线、登录已过期或服务器身份变化）。你可以取消并稍后重试，或仅删除本机连接；远端会话可能仍有效，请在目标服务器的设备管理中撤销。');
        return;
      }
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
      latestProfiles.current = latestProfiles.current.filter((row) => row.id !== id);
      setProfiles(latestProfiles.current);
      setRemoveTarget(undefined);
      setSyncNotice(localOnly ? '已仅删除本机连接和凭据；服务器会话撤销未确认，服务器账本未删除。' : '已删除本机连接并完成会话清理；服务器账本未删除。');
      setSelectedId((cur) => cur === id ? profiles.find((row) => row.id !== id)?.id ?? '' : cur);
      setCredentials((current) => {
        const next = { ...current };
        delete next[id];
        return next;
      });
    } catch (error) {
      throw new Error(`删除服务器前清理同步凭据失败：${msg(error)}`);
    } finally { setBusy(false); }
  }

  function chooseWizardMode(mode: WizardMode) {
    setWizardMode(mode);
    if (mode === 'lan' && (!wizardHost || wizardHost === 'localhost' || wizardHost === 'ledger.example.com')) setWizardHost('192.168.1.100');
    if (mode === 'public' && (!wizardHost || wizardHost === '192.168.1.100' || wizardHost === 'localhost')) setWizardHost('ledger.example.com');
  }

  function applyWizard(): SyncConnection | undefined {
    if (!selected || selectedIsPrimary) return undefined;
    const next = { ...selected, ...wizardPatch(wizardMode, wizardHost, wizardBasePath) };
    patchProfile(selected.id, next);
    setAddressDraft(next.baseUrl);
    setAddressParts(parseSyncBaseUrl(next.baseUrl));
    setAddressError('');
    setSyncNotice(`已套用“${WIZARD_MODES.find((m) => m.mode === wizardMode)?.label ?? '同步'}”配置；继续填写用户名和服务器账号密码后验证。`);
    return next;
  }

  async function applyWizardAndTest() {
    const next = applyWizard();
    if (next) await testProfile(next, 'health');
  }

  function startOperation(profile: SyncConnection) {
    setTestingId(profile.id);
    const operation = operations.current.start(profile.id, () => {
      const row = latestProfiles.current.find((item) => item.id === profile.id);
      return JSON.stringify([row?.id, row?.username, row?.baseUrl, row?.activeUrl, credentialRevision(profile.id)]);
    });
    activeOperation.current = operation;
    return operation;
  }

  function finishOperation(profile: SyncConnection, operation: ProfileOperation) {
    operations.current.finish(profile.id, operation);
    if (activeOperation.current === operation) {
      activeOperation.current = undefined;
      setTestingId('');
    }
  }

  async function testProfile(profile: SyncConnection, mode: 'health' | 'auth' = 'auth') {
    const operation = startOperation(profile);
    const baseUrl = buildBaseUrl(profile);
    const started = performance.now();
    setTestingId(profile.id);
    patchProfile(profile.id, { lastError: mode === 'health' ? '正在测试连通性…' : '正在验证账号密码…' });
    try {
      const health = await fetchHealth(baseUrl, operation.signal);
      operation.assertCurrent();
      const latencyMs = Math.round(performance.now() - started);
      if (!health.ok) throw new Error(`health HTTP ${health.status}`);
      const body = (await health.json()) as {
        serverId?: string;
        serverPublicKey?: string;
        claimed?: boolean;
        registrationMode?: 'open' | 'invite' | 'closed';
        protocols?: number[];
        capabilities?: string[];
      };
      if (!body.protocols?.includes(3) || !body.capabilities?.includes('encrypted-blobs-v1') || !body.capabilities?.includes('ledger-key-envelope-v1')) {
        throw new Error('服务器不支持当前端到端加密同步协议');
      }
      const serverPublicKey = body.serverPublicKey;
      if (!body.serverId || !serverPublicKey || !body.registrationMode) {
        throw new Error('服务器身份或注册策略响应不完整');
      }
      const serverPublicKeyFingerprint = await fingerprintServerPublicKey(serverPublicKey);
      operation.assertCurrent();
      if (profile.expectedServerPublicKeyFingerprint
        && profile.expectedServerPublicKeyFingerprint !== serverPublicKeyFingerprint) {
        patchProfile(profile.id, {
          status: 'identity_changed',
          lastLatencyMs: latencyMs,
          lastTestAt: new Date().toISOString(),
          lastError: '服务器公钥指纹与连接链接不一致，已阻止发送账号密码',
        });
        return;
      }
      if ((profile.serverId && profile.serverId !== body.serverId)
        || (profile.serverPublicKey && profile.serverPublicKey !== serverPublicKey)) {
        patchProfile(profile.id, {
          status: 'identity_changed',
          lastLatencyMs: latencyMs,
          lastTestAt: new Date().toISOString(),
          lastError: '服务器身份与已信任记录不一致，已阻止发送账号密码',
        });
        return;
      }
      const conflictingIdentity = profiles.find((row) => row.id !== profile.id && row.serverId === body.serverId && row.serverPublicKey && row.serverPublicKey !== serverPublicKey);
      if (conflictingIdentity) {
        patchProfile(profile.id, {
          status: 'identity_changed',
          lastLatencyMs: latencyMs,
          lastTestAt: new Date().toISOString(),
          lastError: `服务器 ID 与“${conflictingIdentity.alias}”相同，但 OPAQUE 公钥不同，已阻止连接`,
        });
        return;
      }
      const duplicate = profiles.find((row) => row.id !== profile.id && row.serverId === body.serverId && row.serverPublicKey === serverPublicKey);
      if (duplicate) {
        const candidates = [...new Set([duplicate.baseUrl, ...duplicate.alternateUrls, profile.baseUrl, ...profile.alternateUrls])];
        const { sharedUrls, deviceUrls } = mergeSyncUrlScopes(duplicate, profile, candidates);
        setProfiles((rows) => rows
          .filter((row) => row.id !== profile.id)
          .map((row) => row.id === duplicate.id ? {
            ...row,
            alternateUrls: candidates.filter((url) => url !== row.baseUrl),
            sharedUrls,
            deviceUrls,
            lastError: `已把 ${profile.baseUrl} 合并为同一服务器的备用地址`,
          } : row));
        // Merging addresses never copies credentials between account profiles.
        void deleteCredential(profile.id).catch((error) => setVaultError(`删除重复服务器凭据失败：${msg(error)}`));
        setSelectedId(duplicate.id);
        setHealthByConnection((current) => ({
          ...current,
          [duplicate.id]: {
            serverId: body.serverId!,
            serverPublicKey,
            claimed: body.claimed === true,
            registrationMode: body.registrationMode!,
          },
        }));
        setSyncNotice(`检测到同一服务器身份；地址已合并到“${duplicate.alias}”，不会创建重复连接。`);
        return;
      }
      setHealthByConnection((current) => ({
        ...current,
        [profile.id]: {
          serverId: body.serverId!,
          serverPublicKey,
          claimed: body.claimed === true,
          registrationMode: body.registrationMode!,
        },
      }));
      const cred = runtimeCredential(profile.id);
      if (mode === 'auth' && !isPrimaryWebConnection(profile) && profile.username.trim() && cred?.password) {
        await loginProfileNow({ ...profile, serverId: body.serverId, serverPublicKey }, operation, true);
      } else {
        const lastError = isPrimaryWebConnection(profile) ? '本站登录连接身份校验通过' : mode === 'auth' ? '未填写用户名或密码，仅完成连通性测试' : '连通性正常';
        patchProfile(profile.id, { serverId: body.serverId, serverPublicKey, status: 'online', lastLatencyMs: latencyMs, lastTestAt: new Date().toISOString(), lastError });
      }
    } catch (e) {
      if (operation.current()) patchProfile(profile.id, { status: 'offline', lastLatencyMs: Math.round(performance.now() - started), lastTestAt: new Date().toISOString(), lastError: msg(e) });
    } finally {
      finishOperation(profile, operation);
    }
  }

  async function inspectConnectionIdentity(profile: SyncConnection, operation: ProfileOperation): Promise<SyncHealthInfo> {
    const baseUrl = buildBaseUrl(profile);
    const response = await fetchHealth(baseUrl, operation.signal);
    operation.assertCurrent();
    if (!response.ok) throw new Error(`health HTTP ${response.status}`);
    const body = await response.json() as {
      serverId?: string;
      serverPublicKey?: string;
      claimed?: boolean;
      registrationMode?: 'open' | 'invite' | 'closed';
      protocols?: number[];
      capabilities?: string[];
    };
    const serverPublicKey = body.serverPublicKey;
    if (!body.serverId || !serverPublicKey || !body.registrationMode
      || !body.protocols?.includes(3)
      || !body.capabilities?.includes('opaque-pake-v1')
      || !body.capabilities.includes('ledger-key-envelope-v1')) {
      throw new Error('服务器身份或端到端加密能力响应不完整');
    }
    if (profile.serverId && profile.serverId !== body.serverId) throw new Error('服务器 ID 与已信任记录不一致');
    if (profile.serverPublicKey && profile.serverPublicKey !== serverPublicKey) throw new Error('服务器 OPAQUE 公钥与已信任记录不一致');
    const fingerprint = await fingerprintServerPublicKey(serverPublicKey);
    operation.assertCurrent();
    if (profile.expectedServerPublicKeyFingerprint && profile.expectedServerPublicKeyFingerprint !== fingerprint) {
      throw new Error('服务器 OPAQUE 公钥指纹与连接链接不一致');
    }
    const identity = {
      serverId: body.serverId,
      serverPublicKey,
      claimed: body.claimed === true,
      registrationMode: body.registrationMode,
    };
    setHealthByConnection((current) => ({ ...current, [profile.id]: identity }));
    patchProfile(profile.id, { serverId: identity.serverId, serverPublicKey: identity.serverPublicKey });
    return identity;
  }

  async function registerProfile(profile: SyncConnection) {
    const operation = startOperation(profile);
    let registered = false;
    try {
      if (isPrimaryWebConnection(profile)) throw new Error('本站账号请在退出后使用登录注册入口。');
      const cred = runtimeCredential(profile.id);
      if (!profile.username.trim() || !cred?.password) throw new Error('请先填写用户名和密码');
      if (cred.password !== passwordConfirm) throw new Error('两次输入的服务器账号密码不一致');
      const identity = await inspectConnectionIdentity(profile, operation);
      operation.assertCurrent();
      if (!identity.claimed) throw new Error('服务器尚未初始化，请联系部署者先完成独立管理后台设置。');
      await registerAccount(buildBaseUrl(profile), profile.username.trim(), cred.password, {
        signal: operation.signal, inviteCode: cred.inviteCode.trim() || undefined,
        expectedServerId: identity.serverId, expectedServerPublicKey: identity.serverPublicKey,
      });
      registered = true;
      operation.assertCurrent();
      await loginProfileNow({ ...profile, ...identity }, operation);
      setPasswordConfirm('');
    } catch (error) {
      if (operation.current()) patchProfile(profile.id, { status: 'login_required', lastError: registered
        ? `账号已注册，但自动登录未完成；请直接登录，不要重复注册。原因：${msg(error)}` : msg(error) });
    } finally { finishOperation(profile, operation); }
  }

  async function loginProfile(profile: SyncConnection): Promise<string> {
    const credential = runtimeCredential(profile.id);
    if (isPrimaryWebConnection(profile) || !credential?.password && hasAccountSession(credential)) return authenticateSyncProfile(profile);
    const operation = startOperation(profile);
    try { return await loginProfileNow(profile, operation); }
    catch (error) {
      if (operation.current()) patchProfile(profile.id, { status: 'login_required', lastError: msg(error) });
      throw error;
    } finally { finishOperation(profile, operation); }
  }

  async function submitLogin(profile: SyncConnection): Promise<void> {
    const generation = ++loginFeedbackGeneration.current;
    setSyncNotice('');
    try {
      await loginProfile(profile);
    } catch (error) {
      // Session refresh can legitimately rotate or clear credentials. Report its
      // error independently of the credential fence, but never after a form edit.
      if (generation === loginFeedbackGeneration.current) {
        setSyncNotice(`${profile.alias}（${profile.username}）登录未完成：${msg(error)}`);
      }
    }
  }

  async function loginProfileNow(profile: SyncConnection, operation: ProfileOperation, verifyAttachments = false): Promise<string> {
    operation.assertCurrent();
    const cred = runtimeCredential(profile.id);
    if (isPrimaryWebConnection(profile) || !cred?.password && hasAccountSession(cred)) {
      const token = await authenticateSyncProfile(profile);
      operation.assertCurrent();
      return token;
    }
    if (!profile.username.trim() || !cred?.password) throw new Error('请先填写用户名和密码');
    const identity = await inspectConnectionIdentity(profile, operation);
    operation.assertCurrent();
    const session = await loginAccount(buildBaseUrl(profile), profile.username.trim(), cred.password, {
      signal: operation.signal,
      sessionTransport: isTauriRuntime() ? preferredSessionTransport(buildBaseUrl(profile)) : 'token',
      deviceId, deviceName: 'Zichan · 当前设备',
      expectedServerPublicKey: identity.serverPublicKey, expectedServerId: identity.serverId,
    });
    operation.assertCurrent();
    const account = await fetchAuthMe(buildBaseUrl(profile), session.accessToken, { signal: operation.signal });
    operation.assertCurrent();
    if (account.username !== profile.username.trim().normalize('NFKC').toLowerCase()
      || account.session.id !== session.session.id || account.accountId !== session.accountId) {
      throw new Error('账号或会话身份不匹配，已阻止保存');
    }
    if (verifyAttachments) {
      const usage = await requestJson(`${buildBaseUrl(profile)}/api/v3/blobs/usage`, {
        headers: { Authorization: `Bearer ${session.accessToken}` }, redirect: 'error',
      }, { signal: operation.signal, timeoutMs: REQUEST_TIMEOUT_MS });
      operation.assertCurrent();
      if (!usage.ok) throw new Error(`附件能力验证失败：HTTP ${usage.status}`);
    }
    patchProfile(profile.id, {
      status: 'online', role: account.role, accountId: account.accountId,
      ledgerId: account.ledgerId, replicaId: account.replicaId, streamEpoch: account.streamEpoch,
      lastError: verifyAttachments ? '账号、密码和附件能力验证通过' : '登录成功',
    });
    // Commit credentials last: changing their revision invalidates the operation.
    patchCredential(profile.id, {
      password: '', inviteCode: '', sessionTransport: session.sessionTransport,
      accessToken: session.accessToken, refreshToken: session.refreshToken,
      accessExpiresAt: session.accessExpiresAt, sessionId: session.session.id,
    });
    setPasswordConfirm('');
    return session.accessToken;
  }

  async function doSync(profile?: SyncConnection) {
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
      setProfiles(mergeSharedSyncDirectory(loadSyncConnections(), await loadSharedSyncDirectory(store)));
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

  async function joinRemoteLedger(profile: SyncConnection, ledgerId: string) {
    if (joinConfirmation !== '替换本机' || joinLedgerPassword.length < 8) return;
    setBusy(true);
    setSyncNotice('正在只读预检远端账本、验证密码和全部提交…');
    try {
      const localLedgerId = await store.getLedgerId();
      const localEnvelope = storedLedgerKeyEnvelope();
      const localSession = requireLedgerCryptoSession(localLedgerId);
      if (!localEnvelope
        || localEnvelope.ledgerId !== localSession.ledgerId
        || localEnvelope.keyringId !== localSession.keyringId
        || localEnvelope.generation !== localSession.generation) {
        throw new Error('本机账本密钥封套与已解锁会话不一致，请重新解锁后再加入');
      }
      const token = await loginProfile(profile);
      const prepared = await prepareRemoteLedgerJoin({
        baseUrl: buildBaseUrl(profile),
        token,
        ledgerId,
        passphrase: joinLedgerPassword,
        endpointLabel: profile.alias,
        expectedServerId: profile.serverId,
      });
      const joinedAt = new Date().toISOString();
      const localProfiles = loadSyncConnections();
      if (!localProfiles.some((row) => row.id === profile.id)) {
        throw new Error('本机同步服务器配置在预检期间发生变化，请重新选择后再试');
      }
      const joinedProfiles = localProfiles.map((row) => row.id === profile.id ? {
        ...row,
        serverId: prepared.identity.serverId,
        replicaId: prepared.identity.replicaId,
        streamEpoch: prepared.identity.streamEpoch,
        ledgerId: prepared.identity.ledgerId,
        status: 'online' as const,
        lastSyncAt: joinedAt,
        lastError: '',
        lastSyncError: undefined,
      } : row);
      setSyncNotice('远端账本已验证；正在创建本机保护备份并原子替换…');
      await commitRemoteLedgerJoin(store, prepared, {
        createProtectionBackup: async () => {
          const protection = await saveLedgerBackup(store, 'pre-import', `加入远端账本 ${ledgerId} 前`, 'device');
          writeSafetyState(successfulBackupSafetyPatch(protection));
        },
        adoptRemoteKey: () => {
          adoptUnlockedLedgerKeyEnvelope(prepared.keyEnvelope, prepared.cryptoSession, true);
        },
        restoreLocalKey: () => {
          adoptUnlockedLedgerKeyEnvelope(localEnvelope, localSession, true);
        },
        commitClientState: () => saveSyncConnections(joinedProfiles),
        restoreClientState: () => saveSyncConnections(localProfiles),
        reconcileAttachments: () => reconcileAttachmentStorage(store),
      });
      const joinedWithSharedDirectory = mergeSharedSyncDirectory(joinedProfiles, await loadSharedSyncDirectory(store));
      saveSyncConnections(joinedWithSharedDirectory);
      setProfiles(joinedWithSharedDirectory);
      setJoinTarget(null);
      setJoinConfirmation('');
      setJoinLedgerPassword('');
      setConflicts(await store.listConflicts());
      setInvalidCommits(await store.listSyncCommits({ state: 'invalid', includeInvalid: true }));
      setResult(null);
      setEndpointRows([]);
      setLastSyncAt(new Date(joinedAt).toLocaleString());
      setSyncNotice(`已安全加入远端账本；预检并拉取 ${prepared.pulled} 条提交，本机原账本已保存为导入前保护备份。`);
      bump();
    } catch (error) {
      setSyncNotice(`加入远端账本失败：${msg(error)}`);
    } finally {
      setBusy(false);
    }
  }

  useEffect(() => {
    if (!autoSyncEnabled) {
      setAutoSyncStatus('未启用');
      return;
    }
    const ready = ledgerKey.unlocked && profiles.some((profile) => profile.enabled && profile.username.trim() && hasAccountSession(credentials[profile.id]));
    if (!ready) {
      setAutoSyncStatus(!ledgerKey.unlocked ? '等待解锁账本密钥' : vault.kind === 'native-stronghold' && !vault.unlocked ? '等待解锁 Stronghold' : '等待启用服务器并登录账号');
    } else {
      setAutoSyncStatus(`每 ${autoSyncMinutes} 分钟；启动、回前台和联网恢复时同步`);
    }
    const onResult = (event: Event) => {
      const detail = (event as CustomEvent<LifecycleSyncResult>).detail;
      void loadSharedSyncDirectory(store).then((servers) => {
        setProfiles(mergeSharedSyncDirectory(loadSyncConnections(), servers));
      }).catch((error) => setAutoSyncStatus(`共享服务器目录读取失败 · ${msg(error)}`));
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
  const selectedHealth = selected ? healthByConnection[selected.id] : undefined;
  const enabledProfiles = profiles.filter((p) => p.enabled);
  const onlineProfiles = profiles.filter((p) => p.status === 'online');
  const syncReadyCount = enabledProfiles.filter((p) => hasAccountSession(credentials[p.id])).length;
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
    <div style={{ display: 'flex', flexDirection: 'column', gap: 18, maxWidth: 980 }}>
        <>
          <div style={card}>
            <div className="zc-responsive-header" style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 14, marginBottom: 14 }}>
              <div>
                <div style={{ fontSize: 'var(--fs-title)', fontWeight: 'var(--fw-bold)' }}>同步中心</div>
                <div style={{ fontSize: 'var(--fs-caption)', color: 'var(--text-tertiary)', marginTop: 4 }}>
                  解锁账本密钥并验证服务器账号后，同步全部启用服务器；冲突会进入下方冲突箱。
                </div>
              </div>
              <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', justifyContent: 'flex-end' }}>
                <button onClick={() => void doSync()} disabled={busy || !ledgerKey.unlocked || enabledProfiles.length === 0} style={primary}>{busy ? '同步中…' : '同步全部启用服务器'}</button>
              </div>
            </div>
            <div className="zc-sync-kpi-grid" style={{ display: 'grid', gridTemplateColumns: 'repeat(5, minmax(0, 1fr))', gap: 10 }}>
              <SyncTile label="启用服务器" value={`${enabledProfiles.length} / ${profiles.length}`} tone={enabledProfiles.length ? 'var(--positive)' : 'var(--negative)'} />
              <SyncTile label="在线服务器" value={`${onlineProfiles.length}`} tone={onlineProfiles.length ? 'var(--positive)' : 'var(--fg-subtle)'} />
              <SyncTile label="已登录账号" value={`${syncReadyCount}`} tone={syncReadyCount ? 'var(--positive)' : 'var(--fg-subtle)'} />
              <SyncTile label="待处理冲突" value={`${conflicts.length}`} tone={conflicts.length ? 'var(--negative)' : 'var(--positive)'} />
              <SyncTile label="隔离提交" value={`${invalidCommits.length}`} tone={invalidCommits.length ? 'var(--negative)' : 'var(--positive)'} />
            </div>
            <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap', marginTop: 12, paddingTop: 12, borderTop: '1px solid var(--border)' }}>
              <label style={{ display: 'inline-flex', alignItems: 'center', gap: 7, fontSize: 'var(--fs-caption)', fontWeight: 'var(--fw-bold)', color: 'var(--text-secondary)' }}>
                <input type="checkbox" checked={autoSyncEnabled} onChange={(event) => setAutoSyncEnabled(event.target.checked)} />
                自动同步
              </label>
              <select aria-label="自动同步间隔" className="zc-select" value={autoSyncMinutes} onChange={(event) => setAutoSyncMinutes(Number(event.target.value))} disabled={!autoSyncEnabled} style={{ width: 120 }}>
                {[1, 5, 15, 30, 60].map((minutes) => <option key={minutes} value={minutes}>{minutes} 分钟</option>)}
              </select>
              <span style={{ fontSize: 'var(--fs-caption)', color: 'var(--text-tertiary)' }}>{autoSyncStatus}</span>
            </div>
            {enabledProfiles.length === 0 && (
              <div style={{ marginTop: 12, fontSize: 'var(--fs-caption)', color: 'var(--negative)', fontWeight: 'var(--fw-bold)' }}>
                当前没有启用服务器。勾选服务器后，“同步全部启用服务器”才会运行正式远程同步。
              </div>
            )}
          </div>

          {selected && <ServerCustodyPanel key={`${selected.id}:${selected.username}:${selected.baseUrl}`} profile={selected} />}
          {accountProtection() ? <LedgerProtectionPanel store={store} /> : (
          <div style={card}>
            <div className="zc-responsive-header" style={{ display: 'flex', justifyContent: 'space-between', gap: 12, alignItems: 'center', marginBottom: 12 }}>
              <div>
                <div style={{ fontSize: 'var(--fs-title)', fontWeight: 'var(--fw-bold)' }}>本地账本加密</div>
                <div style={{ fontSize: 'var(--fs-caption)', color: 'var(--text-tertiary)', marginTop: 4 }}>
                  服务器账号密码只用于登录；此处密码解锁账本数据密钥。密钥正文只保留在当前会话内存中。
                </div>
              </div>
              <span style={{ fontSize: 'var(--fs-caption)', fontWeight: 'var(--fw-bold)', color: ledgerKey.unlocked ? 'var(--positive)' : 'var(--fg-subtle)' }}>
                {ledgerKey.unlocked ? `已解锁 · 第 ${ledgerKey.generation} 代` : ledgerKey.initialized ? '已初始化 · 已锁定' : '未初始化'}
              </span>
            </div>
            {!ledgerKey.unlocked ? (
              <div style={{ display: 'flex', alignItems: 'end', gap: 10, flexWrap: 'wrap' }}>
                <div style={{ minWidth: 230, flex: '1 1 260px' }}><label className="zc-label">账本加密密码</label><input aria-label="账本加密密码" className="zc-input" type="password" autoComplete="off" value={ledgerPassword} onChange={(event) => setLedgerPassword(event.target.value)} /></div>
                {!ledgerKey.initialized && <div style={{ minWidth: 230, flex: '1 1 260px' }}><label className="zc-label">确认账本加密密码</label><input aria-label="确认账本加密密码" className="zc-input" type="password" autoComplete="off" value={ledgerPasswordConfirm} onChange={(event) => setLedgerPasswordConfirm(event.target.value)} /></div>}
                <button type="button" onClick={() => void createOrUnlockLedgerKey()} disabled={ledgerKeyBusy || ledgerPassword.length < 8 || (!ledgerKey.initialized && ledgerPassword !== ledgerPasswordConfirm)} style={primary}>{ledgerKeyBusy ? '处理中…' : ledgerKey.initialized ? '解锁' : '创建密钥包'}</button>
                {selected && <button type="button" onClick={() => void fetchRemoteLedgerKey(selected)} disabled={ledgerKeyBusy || !selected.username.trim() || !hasAccountSession(credentials[selected.id])} style={outline}>从当前服务器获取</button>}
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
            {ledgerKeyError && <div style={{ marginTop: 10, color: 'var(--negative)', fontSize: 'var(--fs-caption)', fontWeight: 'var(--fw-bold)' }}>{ledgerKeyError}</div>}
            {ledgerKey.keyringId && <div style={{ marginTop: 10, color: 'var(--text-tertiary)', fontSize: 'var(--fs-meta)' }}>密钥包 {ledgerKey.keyringId} · 账本 {ledgerKey.ledgerId}</div>}
          </div>
          )}

          {invalidCommits.length > 0 && (
            <div style={{ ...card, border: '1px solid var(--negative)' }}>
              <div className="zc-responsive-header" style={{ display: 'flex', justifyContent: 'space-between', gap: 12, alignItems: 'center', marginBottom: 8 }}>
                <div>
                  <div style={{ fontSize: 'var(--fs-title)', fontWeight: 'var(--fw-bold)' }}>隔离提交 <span style={{ color: 'var(--negative)', fontSize: 'var(--fs-caption)' }}>{invalidCommits.length}</span></div>
                  <div style={{ color: 'var(--text-tertiary)', fontSize: 'var(--fs-caption)', marginTop: 4 }}>这些提交未写入账本。修复来源设备的数据后再同步，或导出诊断信息排查。</div>
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

          {<div style={card}>
            <div className="zc-responsive-header" style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12, marginBottom: 12 }}>
              <div>
                <div style={{ fontSize: 'var(--fs-title)', fontWeight: 'var(--fw-bold)' }}>服务器配置</div>
                <div style={{ fontSize: 'var(--fs-caption)', color: 'var(--text-tertiary)', marginTop: 4 }}>
                  每台服务器可使用不同账号密码和服务路径；这些凭据与上方账本加密密码相互独立。{vault.message}。
                  {!isTauriRuntime() && '本站账号负责登录与缓存隔离，附加服务器独立使用令牌会话，保存在此标签页的 sessionStorage；关闭标签页后需重新登录，不覆盖本站 Cookie。'}
                </div>
              </div>
              <button onClick={addProfile} style={primary}>新增服务器</button>
            </div>

            <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap', padding: '10px 0 14px', borderTop: '1px solid var(--border)' }}>
              <input
                aria-label="服务器连接链接"
                className="zc-input"
                style={{ flex: '1 1 420px' }}
                value={connectionLinkDraft}
                onChange={(event) => setConnectionLinkDraft(event.target.value)}
                placeholder="粘贴不含秘密的连接链接"
                spellCheck={false}
              />
              <button type="button" onClick={() => importConnectionLink(connectionLinkDraft)} disabled={!connectionLinkDraft.trim()} style={outline}>导入连接</button>
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
                <div style={{ flex: '1 1 240px', fontSize: 'var(--fs-caption)', color: vaultError ? 'var(--negative)' : vault.unlocked ? 'var(--positive)' : 'var(--fg-subtle)', fontWeight: 'var(--fw-bold)' }}>
                  {vaultError || (vault.unlocked ? `Stronghold 已解锁 · ${vault.platform}` : '解锁后才能读取、保存和自动使用服务器账号密码')}
                </div>
              </div>
            )}

            {vault.kind === 'browser-session' && vaultError && (
              <div style={{ color: 'var(--negative)', fontSize: 'var(--fs-caption)', fontWeight: 'var(--fw-bold)', marginBottom: 12 }}>{vaultError}</div>
            )}

            {selected && !selectedIsPrimary && (
              <div style={{ border: '1px solid var(--border)', borderRadius: 'var(--r-md)', padding: 12, background: 'var(--surface-2)', marginBottom: 14 }}>
                <div className="zc-responsive-header" style={{ display: 'flex', justifyContent: 'space-between', gap: 12, alignItems: 'center', marginBottom: 10 }}>
                  <div>
                    <div style={{ fontSize: 'var(--fs-body)', fontWeight: 'var(--fw-bold)' }}>首次配置向导</div>
                    <div style={{ fontSize: 'var(--fs-caption)', color: 'var(--text-tertiary)', marginTop: 3 }}>选择服务器位置，先把地址和端口套到当前服务器，再填写账号密码。</div>
                  </div>
                  <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', justifyContent: 'flex-end' }}>
                    {WIZARD_MODES.map((item) => (
                      <button key={item.mode} onClick={() => chooseWizardMode(item.mode)} style={tabBtn(wizardMode === item.mode)} title={item.hint}>{item.label}</button>
                    ))}
                  </div>
                </div>
                {(wizardMode === 'lan' || wizardMode === 'public') && (
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
                  <span style={{ fontSize: 'var(--fs-caption)', color: 'var(--text-tertiary)', fontWeight: 'var(--fw-bold)' }}>
                    {buildBaseUrl({ ...selected, ...wizardPatch(wizardMode, wizardHost, wizardBasePath) })}
                  </span>
                </div>
                {selectedRemoteLedgerId && (
                  <div style={{ marginTop: 14, paddingTop: 14, borderTop: '1px solid var(--negative)' }}>
                    <div style={{ color: 'var(--negative)', fontSize: 'var(--fs-caption)', fontWeight: 'var(--fw-bold)' }}>此账号已绑定另一个账本</div>
                    <div style={{ color: 'var(--text-tertiary)', fontSize: 'var(--fs-meta)', marginTop: 4 }}>
                      远端账本 {selectedRemoteLedgerId}。系统会先只读验证远端密码、提交和账本一致性，再保存本机保护备份并原子替换；任何一步失败都会保留本机账本。
                    </div>
                    {joinTarget?.profileId !== selected.id ? (
                      <button type="button" disabled={busy} onClick={() => { setJoinTarget({ profileId: selected.id, ledgerId: selectedRemoteLedgerId }); setJoinConfirmation(''); setJoinLedgerPassword(''); }} style={{ ...danger, marginTop: 10 }}>加入远端账本</button>
                    ) : (
                      <div style={{ display: 'flex', gap: 8, alignItems: 'end', flexWrap: 'wrap', marginTop: 10 }}>
                        <div style={{ minWidth: 240 }}>
                          <label className="zc-label">输入“替换本机”确认</label>
                          <input aria-label="确认替换本机账本" className="zc-input" value={joinConfirmation} onChange={(event) => setJoinConfirmation(event.target.value)} autoComplete="off" />
                        </div>
                        <div style={{ minWidth: 240 }}>
                          <label className="zc-label">远端账本加密密码</label>
                          <input aria-label="远端账本加密密码" className="zc-input" type="password" value={joinLedgerPassword} onChange={(event) => setJoinLedgerPassword(event.target.value)} autoComplete="off" />
                        </div>
                        <button type="button" disabled={busy || joinConfirmation !== '替换本机' || joinLedgerPassword.length < 8} onClick={() => void joinRemoteLedger(selected, selectedRemoteLedgerId)} style={danger}>验证、备份并加入</button>
                        <button type="button" disabled={busy} onClick={() => { setJoinTarget(null); setJoinConfirmation(''); setJoinLedgerPassword(''); }} style={outline}>取消</button>
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
                      <td style={tdStyle}><span className="zc-check-target" onClick={(e) => e.stopPropagation()}><input aria-label={`启用 ${p.alias}`} type="checkbox" checked={p.enabled} disabled={isPrimaryWebConnection(p)} onChange={(e) => patchProfile(p.id, { enabled: e.target.checked })} onClick={(e) => e.stopPropagation()} /></span></td>
                      <td style={tdStyle}>{p.alias}{isPrimaryWebConnection(p) && ' · 本站登录'}</td>
                      <td style={{ ...tdStyle, color: 'var(--text-secondary)' }}>{buildBaseUrl(p)}</td>
                      <td style={tdStyle}>{p.username || '—'}</td>
                      <td style={{ ...tdStyle, color: p.status === 'online' ? 'var(--positive)' : p.status === 'offline' || p.status === 'identity_changed' ? 'var(--negative)' : 'var(--fg-muted)', fontWeight: 'var(--fw-bold)' }}>{statusText[p.status]}</td>
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
              <div style={{ border: '1px solid var(--border)', borderRadius: 'var(--r-md)', padding: 14, background: 'var(--surface-2)' }}>
                <div style={{ fontSize: 'var(--fs-body)', fontWeight: 'var(--fw-bold)', marginBottom: 10 }}>编辑服务器 · {selected.alias}</div>
                <div style={{ marginBottom: 10 }}>
                  <label className="zc-label">完整服务器地址</label>
                  <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
                    <input
                      aria-label="完整服务器地址"
                      disabled={selectedIsPrimary}
                      className="zc-input"
                      style={{ flex: '1 1 420px' }}
                      value={addressDraft}
                      onChange={(event) => editAddressDraft(event.target.value)}
                      placeholder="https://ledger.example.com/zichan"
                      spellCheck={false}
                    />
                    <button type="button" onClick={() => setAdvancedAddress((value) => !value)} style={outline}>{advancedAddress ? '收起高级设置' : '高级设置'}</button>
                    <button type="button" onClick={saveAddress} disabled={selectedIsPrimary || Boolean(addressError) || addressDraft === selected.baseUrl} style={primary}>保存地址</button>
                  </div>
                  <div style={{ marginTop: 5, fontSize: 'var(--fs-meta)', color: addressError ? 'var(--negative)' : 'var(--fg-subtle)', fontWeight: addressError ? 'var(--fw-bold)' : 'var(--fw-regular)' }}>
                    {addressError || '完整 URL 是唯一保存值；高级字段只是同一地址的编辑视图。公网必须使用 HTTPS。'}
                  </div>
                  <div style={{ marginTop: 4, fontSize: 'var(--fs-meta)', color: 'var(--text-tertiary)', lineHeight: 1.5 }}>
                    HTTPS 网站中的浏览器可能阻止普通 HTTP 局域网地址；可改用可信 HTTPS、服务器自带 Web，或 Windows 便携版。
                  </div>
                </div>
                {selectedIsPrimary && <p>此连接属于本站登录账号，地址和用户名不可在同步设置中替换。切换账号请先退出；其他服务器使用“新增服务器”配置。</p>}
                {advancedAddress && !selectedIsPrimary && (
                  <>
                    <div className="zc-sync-input-grid" style={inputGrid}>
                      <div><label className="zc-label">协议</label><select aria-label="协议" className="zc-select" value={addressParts.protocol} onChange={(e) => editAddressPart({ protocol: e.target.value as Protocol })}><option value="http">http</option><option value="https">https</option></select></div>
                      <div><label className="zc-label">主机 / 域名</label><input aria-label="主机或域名" className="zc-input" value={addressParts.host} onChange={(e) => editAddressPart({ host: e.target.value })} /></div>
                      <div><label className="zc-label">端口</label><input aria-label="端口" className="zc-input" value={addressParts.port} onChange={(e) => editAddressPart({ port: e.target.value })} placeholder="443" /></div>
                      <div><label className="zc-label">服务路径</label><input aria-label="服务路径" className="zc-input" value={addressParts.path} onChange={(e) => editAddressPart({ path: e.target.value })} placeholder="/zichan" /></div>
                    </div>
                    <label style={{ display: 'flex', gap: 8, alignItems: 'flex-start', margin: '-2px 0 12px', fontSize: 'var(--fs-meta)', color: 'var(--text-tertiary)', lineHeight: 1.5 }}>
                      <input type="checkbox" checked={selected.sharedUrls.includes(selected.baseUrl)} onChange={(event) => setActiveAddressShared(event.target.checked)} />
                      将此地址写入账本的加密服务器目录，供其他设备发现。公网 HTTPS 默认开启；localhost 或局域网地址默认仅当前设备，手动共享前请确认其他设备也能访问该地址。
                    </label>
                  </>
                )}
                <div className="zc-sync-input-grid" style={inputGrid}>
                  <div><label className="zc-label">中文别名</label><input aria-label="中文别名" className="zc-input" value={selected.alias} onChange={(e) => patchProfile(selected.id, { alias: e.target.value })} /></div>
                  <div><label className="zc-label">用户名</label><input aria-label="用户名" disabled={selectedIsPrimary} className="zc-input" value={selected.username} onChange={(e) => patchProfile(selected.id, { username: e.target.value })} /></div>
                  {!selectedIsPrimary && <div><label className="zc-label">服务器账号密码（仅本次登录使用，不保存密码）</label><input aria-label="服务器账号密码" className="zc-input" type="password" value={cred.password} disabled={vault.kind === 'native-stronghold' && !vault.unlocked} onChange={(e) => patchCredential(selected.id, { password: e.target.value, accessToken: undefined, refreshToken: undefined, accessExpiresAt: undefined, sessionId: undefined, sessionTransport: undefined })} /></div>}
                  {!selectedIsPrimary && <div><label className="zc-label">确认服务器账号密码（仅注册需要）</label><input aria-label="确认服务器账号密码" className="zc-input" type="password" value={passwordConfirm} onChange={(e) => setPasswordConfirm(e.target.value)} /></div>}
                  {selectedHealth?.registrationMode === 'invite' && <div><label className="zc-label">邀请码</label><input aria-label="邀请码" className="zc-input" value={cred.inviteCode} disabled={vault.kind === 'native-stronghold' && !vault.unlocked} onChange={(e) => patchCredential(selected.id, { inviteCode: e.target.value })} /></div>}
                </div>
                {selectedHealth && (
                  <div style={{ margin: '-2px 0 10px', fontSize: 'var(--fs-meta)', color: !selectedHealth.claimed ? 'var(--positive)' : 'var(--fg-subtle)', fontWeight: !selectedHealth.claimed ? 'var(--fw-bold)' : 'var(--fw-regular)' }}>
                    {!selectedHealth.claimed
                      ? '尚未初始化：请联系部署者先完成独立管理后台设置。用户端不创建管理员。'
                      : `注册策略：${selectedHealth.registrationMode === 'open' ? '开放注册' : selectedHealth.registrationMode === 'invite' ? '仅邀请码' : '已关闭'}${selected.role ? ` · 当前账号：${selected.role === 'owner' ? '所有者' : selected.role === 'admin' ? '管理员' : '成员'}` : ''}`}
                  </div>
                )}
                <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
                  <button onClick={() => void testProfile(selected, 'auth')} disabled={busy || testingId === selected.id} style={outline}>{testingId === selected.id ? '验证中…' : '验证账号密码'}</button>
                  <button onClick={() => void registerProfile(selected)} disabled={selectedIsPrimary || busy || Boolean(testingId) || selectedHealth?.claimed === false || selectedHealth?.registrationMode === 'closed'} style={outline}>注册</button>
                  <button onClick={() => void submitLogin(selected)} disabled={selectedIsPrimary || busy || Boolean(testingId)} style={outline}>登录</button>
                  <button onClick={() => void doSync(selected)} disabled={busy || !ledgerKey.unlocked} style={primary}>{busy ? '同步中…' : '同步此服务器'}</button>
                  <button type="button" onClick={() => void createConnectionShare(selected)} disabled={busy || !selected.serverId || !selected.serverPublicKey} style={outline}>连接链接 / 二维码</button>
                  <button
                    onClick={() => { operations.current.cancel(selected.id); setRemoveWarning(''); setRemoveTarget(selected.id); }}
                    disabled={selectedIsPrimary || profiles.length <= 1 || busy || (vault.kind === 'native-stronghold' && vault.initialized && !vault.unlocked)}
                    title={vault.kind === 'native-stronghold' && vault.initialized && !vault.unlocked ? '请先解锁 Stronghold，确保同步凭据一并删除' : '删除服务器'}
                    style={danger}
                  >删除</button>
                  <span style={{ fontSize: 'var(--fs-caption)', color: 'var(--text-secondary)' }}>
                    {selected.serverId ? `服务器 ID：${selected.serverId}` : '尚未识别服务器 ID'}
                    {selected.replicaId ? ` · 副本 ID：${selected.replicaId}` : ''}
                    {selected.streamEpoch ? ` · 流世代：${selected.streamEpoch}` : ''}
                    {selected.ledgerId ? ` · 账本 ID：${selected.ledgerId}` : ''}
                    {selected.lastError ? ` · ${selected.lastError}` : ''}
                  </span>
                </div>
                {connectionShare && (
                  <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))', gap: 14, alignItems: 'center', marginTop: 14, padding: 12, border: '1px solid var(--border)', borderRadius: 'var(--r-sm)', background: 'var(--surface)' }}>
                    <img src={connectionShare.qrDataUrl} alt="服务器连接二维码" width={260} height={260} style={{ display: 'block', width: '100%', maxWidth: 260, height: 'auto', imageRendering: 'pixelated' }} />
                    <div style={{ minWidth: 0 }}>
                      <div style={{ fontSize: 'var(--fs-caption)', fontWeight: 'var(--fw-bold)' }}>无秘密连接信息</div>
                      <div style={{ marginTop: 5, fontSize: 'var(--fs-meta)', color: 'var(--text-tertiary)', lineHeight: 1.6 }}>只包含应用入口、服务器完整 URL、serverId 和 OPAQUE 公钥指纹；扫码或导入后仍必须单独登录。</div>
                      <textarea readOnly value={connectionShare.link} aria-label="无秘密连接链接" onFocus={(event) => event.currentTarget.select()} style={{ boxSizing: 'border-box', width: '100%', minHeight: 92, marginTop: 9, padding: 9, resize: 'vertical', border: '1px solid var(--border)', borderRadius: 'var(--r-sm)', background: 'var(--surface-2)', color: 'var(--text-secondary)', fontSize: 'var(--fs-meta)', userSelect: 'text', WebkitUserSelect: 'text' }} />
                      <div style={{ display: 'flex', gap: 8, marginTop: 8, flexWrap: 'wrap' }}>
                        <button type="button" onClick={() => void copyTextToClipboard(connectionShare.link).then(() => setSyncNotice('连接链接已复制。')).catch((error) => setSyncNotice(`复制失败：${msg(error)}`))} style={outline}>复制链接</button>
                        <button type="button" onClick={() => setConnectionShare(null)} style={outline}>关闭</button>
                      </div>
                    </div>
                  </div>
                )}
              </div>
            )}
          </div>}

          {!isTauriRuntime() && <div style={card}><h3>本站登录账号</h3><p>{primaryConnection?.username} · {primaryConnection?.accountId}</p><p>切换上方同步服务器不会切换本站账号。切换账号请到设置退出后重新登录；不同账号的缓存独立保存。</p></div>}
          <div style={card}>
            <div className="zc-responsive-header" style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
              <div>
                <div style={{ fontSize: 'var(--fs-title)', fontWeight: 'var(--fw-bold)' }}>同步结果</div>
                <div style={{ fontSize: 'var(--fs-caption)', color: 'var(--text-tertiary)', marginTop: 4 }}>
                  本机设备 · <span style={{ fontWeight: 'var(--fw-bold)', color: 'var(--text-secondary)' }}>{deviceId}</span>
                  {lastSyncAt && <> · 上次同步 {lastSyncAt}</>}
                </div>
              </div>
              <button onClick={() => void doSync()} disabled={busy || !ledgerKey.unlocked || enabledProfiles.length === 0} style={{ ...primary, padding: '10px 18px', fontSize: 'var(--fs-body)' }}>
                {busy ? '同步中…' : '同步全部启用服务器'}
              </button>
            </div>
            {enabledProfiles.length === 0 && (
              <div style={{ fontSize: 'var(--fs-caption)', color: 'var(--text-tertiary)', marginTop: 12 }}>
                当前没有启用服务器；“同步全部启用服务器”不会自动使用本地演示云。
              </div>
            )}
            {removeTarget && <ConfirmDialog title="删除服务器连接" tone="danger" busy={busy}
              cancelLabel="取消"
              confirmLabel={removeWarning ? '仅删除本机连接' : '撤销会话并删除连接'}
              onCancel={() => setRemoveTarget(undefined)}
              onConfirm={() => removeProfile(removeTarget, Boolean(removeWarning))}>
              <p>将移除“{profiles.find((row) => row.id === removeTarget)?.alias}”的本机连接和登录凭据，不删除本机账本，也不删除服务器上的账号或账本。</p>
              {removeWarning && <p role="alert">{removeWarning}</p>}
            </ConfirmDialog>}
            {directoryError && <div role="alert">{directoryError}<button onClick={() => setDirectoryRetry((value) => value + 1)}>重新读取共享目录</button></div>}
            {syncNotice && (
              <div style={{ fontSize: 'var(--fs-caption)', color: syncNotice.includes('没有启用') ? 'var(--negative)' : 'var(--fg-muted)', marginTop: 10, fontWeight: 'var(--fw-bold)' }}>
                {syncNotice}
              </div>
            )}
            {mergeNotice && (
              <div style={{ fontSize: 'var(--fs-caption)', color: mergeNotice.includes('发现') ? 'var(--negative)' : 'var(--positive)', marginTop: 10, fontWeight: 'var(--fw-bold)' }}>
                {mergeNotice}
              </div>
            )}
            {result && (
              <>
                <div style={{ fontSize: 'var(--fs-body)', color: 'var(--text-secondary)', marginTop: 12 }}>
                  本次同步：拉取 <b style={{ color: 'var(--text-primary)' }}>{result.pulled}</b> 个提交，推送 <b style={{ color: 'var(--text-primary)' }}>{result.pushed}</b> 个提交，应用 <b style={{ color: 'var(--text-primary)' }}>{result.applied}</b> 个聚合
                  {result.conflicts > 0 && <>，新增 <b style={{ color: 'var(--negative)' }}>{result.conflicts}</b> 个冲突提交</>}
                  {result.conflicts === 0 && <>，无新增冲突</>}；共 {result.rounds} 轮，
                  <b style={{ color: result.converged ? 'var(--positive)' : 'var(--negative)' }}>{result.converged ? '已收敛' : '未完全收敛'}</b>
                </div>
                <div style={{ fontSize: 'var(--fs-caption)', color: 'var(--text-tertiary)', marginTop: 6 }}>
                  附件对象 {result.attachmentSync.references} 个 · 本机可用 {result.attachmentSync.localReady} 个 · 按需下载 {result.attachmentSync.localMissing} 个 · 本轮上传 {result.attachmentSync.endpoints.reduce((sum, row) => sum + row.uploaded, 0)} 个
                </div>
                {endpointRows.length > 0 && (
                  <div className="zc-sync-result-grid" style={{ display: 'grid', gridTemplateColumns: '110px 1fr 140px 60px 60px 90px 120px 70px', gap: 8, marginTop: 12, fontSize: 'var(--fs-caption)' }}>
                    <div className="zc-sync-result-head" style={gridHead}>别名</div><div className="zc-sync-result-head" style={gridHead}>端点</div><div className="zc-sync-result-head" style={gridHead}>副本 ID</div><div className="zc-sync-result-head" style={gridHead}>拉取</div><div className="zc-sync-result-head" style={gridHead}>推送</div><div className="zc-sync-result-head" style={gridHead}>游标 / Head</div><div className="zc-sync-result-head" style={gridHead}>附件</div><div className="zc-sync-result-head" style={gridHead}>延迟</div>
                    {endpointRows.map((row) => (
                      <div key={row.id} className="zc-sync-result-row">
                        <div data-label="别名" style={{ color: row.error ? 'var(--negative)' : 'var(--fg-muted)', fontWeight: 'var(--fw-bold)' }}>{row.alias}</div>
                        <div data-label="端点" style={{ color: row.error || row.attachments?.error ? 'var(--negative)' : 'var(--fg-muted)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{row.url}{row.error ? ` · ${row.error}` : row.attachments?.error ? ` · ${row.attachments.error}` : ''}</div>
                        <div data-label="副本 ID" style={{ color: 'var(--text-secondary)' }}>{row.identity?.replicaId ?? '—'}</div>
                        <div data-label="拉取">{row.pulled}</div><div data-label="推送">{row.pushed}</div><div data-label="游标 / Head">{row.cursor} / {row.headSeq}</div><div data-label="附件">{row.attachments ? `${row.attachments.available}/${result.attachmentSync.references} · ↑${row.attachments.uploaded}` : '—'}</div><div data-label="延迟">{row.latencyMs}ms</div>
                      </div>
                    ))}
                  </div>
                )}
              </>
            )}
          </div>

          <div style={card}>
            <div style={{ fontSize: 'var(--fs-title)', fontWeight: 'var(--fw-bold)', marginBottom: 12 }}>设备</div>
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
                {devices.length === 0 && <tr><td style={{ ...tdStyle, color: 'var(--text-tertiary)' }} colSpan={3}>还没有设备同步过，点上方同步后这里会出现本机</td></tr>}
              </tbody>
            </table></div>
          </div>

          {conflicts.length > 0 && (
            <div style={{ ...card, border: '1px solid var(--negative)' }}>
              <div className="zc-responsive-header" style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12, marginBottom: 4 }}>
                <div style={{ fontSize: 'var(--fs-title)', fontWeight: 'var(--fw-bold)' }}>冲突箱 <span style={{ fontSize: 'var(--fs-caption)', color: 'var(--negative)', fontWeight: 'var(--fw-bold)' }}>{filteredConflicts.length}/{conflicts.length}</span></div>
                <button onClick={exportConflicts} style={outline}>导出冲突 JSON</button>
              </div>
              <div style={{ fontSize: 'var(--fs-caption)', color: 'var(--text-tertiary)', marginBottom: 12 }}>
                冲突按原子提交分组，所有设备分支都会保留。可整项选择版本，也可逐字段组合，确认后会生成一条可继续同步的合并提交。
              </div>
              <div style={{ marginBottom: 12 }}><DateRangeBar value={conflictRange} onChange={setConflictRange} compact /></div>
              <div style={{ display: 'flex', flexDirection: 'column' }}>
                {filteredConflicts.map((c) => (
                  <section key={c.id} style={{ borderTop: '1px solid var(--border)', padding: '16px 0' }}>
                    <div className="zc-responsive-header" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'start', gap: 12, marginBottom: 12 }}>
                      <div>
                        <div style={{ fontSize: 'var(--fs-body)', fontWeight: 'var(--fw-bold)' }}>冲突组 {c.id.slice(0, 8)} · {conflictAggregates(c).length} 个聚合 · {c.remoteCommitIds.length} 个远端提交</div>
                        <div style={{ fontSize: 'var(--fs-meta)', color: 'var(--text-tertiary)', marginTop: 4 }}>
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
                            <div style={{ fontSize: 'var(--fs-caption)', fontWeight: 'var(--fw-bold)' }}>{aggregateTitle(aggregate.type, aggregate.id, selectedPayload, snap)}</div>
                            <label style={{ display: 'flex', alignItems: 'center', gap: 7, fontSize: 'var(--fs-meta)', color: 'var(--text-tertiary)', fontWeight: 'var(--fw-bold)' }}>
                              整项采用
                              <select className="zc-select" value={selectedId} onChange={(event) => chooseBranch(c.id, aggregate.key, event.target.value)} style={{ height: 32, minWidth: 190 }}>
                                {aggregate.branches.map((branch, index) => <option key={branch.revisionId} value={branch.revisionId}>{branchLabel(branch, index)}</option>)}
                              </select>
                            </label>
                          </div>
                          <div style={{ overflowX: 'auto' }}>
                            <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 'var(--fs-caption)' }}>
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
                            <summary style={{ cursor: 'pointer', color: 'var(--text-tertiary)', fontSize: 'var(--fs-meta)', fontWeight: 'var(--fw-bold)' }}>查看各分支原始 JSON</summary>
                            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(240px, 1fr))', gap: 10, marginTop: 8 }}>
                              {aggregate.branches.map((branch, index) => (
                                <div key={branch.revisionId}>
                                  <div style={{ fontSize: 'var(--fs-meta)', color: 'var(--text-tertiary)', marginBottom: 4 }}>{branchLabel(branch, index)} · {branch.commitId.slice(0, 8)}</div>
                                  <code style={{ display: 'block', color: 'var(--text-secondary)', wordBreak: 'break-all', fontSize: 'var(--fs-meta)' }}>{biz(branch.payload)}</code>
                                </div>
                              ))}
                            </div>
                          </details>
                        </div>
                      );
                    })}
                  </section>
                ))}
                {filteredConflicts.length === 0 && <div style={{ color: 'var(--text-tertiary)', fontSize: 'var(--fs-caption)' }}>该时间范围内没有待处理冲突。</div>}
              </div>
            </div>
          )}
        </>
    </div>
  );
}

const tabBtn = (active: boolean) => ({
  padding: '9px 16px',
  borderRadius: 'var(--r-sm)',
  fontSize: 'var(--fs-body)',
  fontWeight: 'var(--fw-bold)',
  cursor: 'pointer',
  background: active ? 'var(--accent-soft)' : 'var(--surface)',
  color: active ? 'var(--accent)' : 'var(--fg-muted)',
  border: `1px solid ${active ? 'var(--accent)' : 'var(--border)'}`,
}) as const;

const gridHead = { color: 'var(--text-tertiary)', fontWeight: 'var(--fw-bold)' } as const;

function SyncTile({ label, value, tone }: { label: string; value: string; tone: string }) {
  return (
    <div style={{ border: '1px solid var(--border)', borderRadius: 'var(--r-md)', padding: 11, background: 'var(--surface-2)' }}>
      <div style={{ fontSize: 'var(--fs-meta)', color: 'var(--text-tertiary)', fontWeight: 'var(--fw-bold)' }}>{label}</div>
      <div style={{ fontSize: 'var(--fs-heading)', color: tone, fontWeight: 'var(--fw-bold)', marginTop: 4 }}>{value}</div>
    </div>
  );
}
import { isTauriRuntime } from '../tauri.js';
