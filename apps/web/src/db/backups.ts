import {
  newId,
  unlockLedgerKeyEnvelope,
  type LedgerCryptoSession,
} from '@zichan/core';
import {
  checkConsistency,
  createLedgerStore,
  importLedger,
  restoreLedger,
  type BackupPreflight,
  type SqlLedgerStore,
} from '@zichan/db';
import { shareBlobFile } from '../device-capabilities.js';
import {
  requireLedgerCryptoSession,
  runtimeLedgerCryptoSession,
  storedLedgerKeyEnvelope,
} from '../ledger-key-vault.js';
import { isTauriRuntime, tauriInvoke } from '../tauri.js';
import {
  downloadRemoteBackup,
  saveEncryptedBackupToSyncServers,
  type RemoteBackupArchive,
  type RemoteBackupResult,
} from '../remote-backup.js';
import type { SyncConnection } from '../sync-config.js';
import {
  createBackupArchive,
  openBackupArchive,
  prepareBackupArchive,
  readBackupArchiveHeader,
  scanBackupArchive,
  validBackupArchiveHeader,
  type BackupArchiveHeader,
  type BackupArchiveInput,
  type BackupArchiveOptions,
  type BackupArchiveSource,
  type BackupKind,
  type BackupPayload,
} from './backup-archive.js';
import { loadKv, saveKv } from './idb.js';
import {
  exportPortableLedger,
  preflightPortableBackup,
  type PortableLedgerBackup,
} from './portable-backup.js';
import { SqlJsDriver } from './sqljs-driver.js';

const BACKUPS_KEY = 'ledger.encryptedBackups.v3';
const AUTO_MIN_INTERVAL_MS = 60 * 60_000;
const EXTERNAL_HANDLE_KEY = 'ledger.external-backup-directory.v1';
const HOUR_MS = 60 * 60_000;
const DAY_MS = 24 * HOUR_MS;
const DESKTOP_TRANSFER_BYTES = 512 * 1024;

interface BackupWindow extends Window {
  showDirectoryPicker?: (options?: { mode?: 'read' | 'readwrite' }) => Promise<FileSystemDirectoryHandle>;
}

interface WritableDirectoryHandle extends FileSystemDirectoryHandle {
  requestPermission(options?: { mode?: 'read' | 'readwrite' }): Promise<PermissionState>;
}

export type { BackupKind, BackupPayload };
export type BackupTier = 'pinned' | 'hourly' | 'daily' | 'weekly';

export interface CreatedEncryptedBackup {
  header: BackupArchiveHeader;
  blob: Blob;
}

export interface PreparedEncryptedBackup {
  header: BackupArchiveHeader;
  estimatedSizeBytes: number;
  createStream(): ReadableStream<Uint8Array>;
}

export interface ParsedEncryptedBackup {
  container: BackupArchiveHeader;
  payload: BackupPayload;
  session: LedgerCryptoSession;
  usedCurrentSession: boolean;
}

export class BackupPassphraseRequiredError extends Error {
  readonly code = 'BACKUP_PASSPHRASE_REQUIRED';

  constructor() {
    super('请输入创建该备份时使用的账本密码');
    this.name = 'BackupPassphraseRequiredError';
  }
}

export interface ExternalBackupStatus {
  kind: 'portable' | 'directory' | 'none';
  configured: boolean;
  label: string;
}

export interface SavedBackup {
  id: string;
  createdAt: string;
  reason: BackupArchiveHeader['reason'];
  label: string;
  kind: BackupKind;
  tier: BackupTier;
  pinned: boolean;
  container: BackupArchiveHeader;
  archive?: Blob;
  nativeFileName?: string;
  preflight: BackupPreflight;
  checksum: string;
  sizeBytes: number;
  /** Local archive path. On Windows portable builds this remains inside data/backups. */
  localPath?: string;
  externalSaved?: boolean;
  externalPath?: string;
  externalError?: string;
  remoteCopies?: RemoteBackupResult[];
}

interface NativeBackupFile {
  fileName: string;
  path: string;
  sizeBytes: number;
  headerBytes: number[];
}

interface DesktopBackupStatus {
  directory: string;
  availableBytes: number;
}

const automaticBackupFlights = new WeakMap<SqlLedgerStore, Promise<SavedBackup | null>>();
const pendingAutomaticBackupFlights = new Set<Promise<SavedBackup | null>>();
let automaticBackupSuspensions = 0;

export interface AutomaticBackupSuspension {
  /** Wait for every backup that started before this suspension to settle. */
  drain(): Promise<void>;
  /** Allow automatic backups again. Safe to call more than once. */
  resume(): void;
}

/**
 * Atomically stop new automatic backups and provide a drain for work already in flight.
 * Reset keeps the suspension active until the document reloads so a late React effect
 * cannot recreate IndexedDB after it has been deleted.
 */
export function suspendAutomaticBackups(): AutomaticBackupSuspension {
  automaticBackupSuspensions += 1;
  let active = true;
  return {
    async drain() {
      while (pendingAutomaticBackupFlights.size) {
        await Promise.allSettled([...pendingAutomaticBackupFlights]);
      }
    },
    resume() {
      if (!active) return;
      active = false;
      automaticBackupSuspensions = Math.max(0, automaticBackupSuspensions - 1);
    },
  };
}

const emptyPreflight = (): BackupPreflight => ({
  ok: true,
  issues: [],
  summary: { entities: 0, chains: 0, steps: 0, byType: {} },
});

function newBackupId(): string {
  return `bk-${newId()}`;
}

function backupFileName(entry: Pick<SavedBackup, 'createdAt' | 'reason' | 'id'>): string {
  return `zichan-${entry.createdAt.replace(/[:.]/g, '-')}-${entry.reason}-${entry.id}.zcbak`;
}

export function sharedBackupFileName(createdAt: string): string {
  return `zichan-backup-${createdAt.replace(/[:.]/g, '-')}.zcbak`;
}

async function unlockArchive(
  header: BackupArchiveHeader,
  passphrase?: string,
): Promise<{ session: LedgerCryptoSession; usedCurrentSession: boolean }> {
  const current = runtimeLedgerCryptoSession();
  if (current?.ledgerId === header.ledgerId
    && current.keyringId === header.keyringId
    && (current.generation === header.keyEnvelope.generation || (current.retiredBackupSecrets?.length ?? 0) > 0)) {
    return { session: current, usedCurrentSession: true };
  }
  if (!passphrase) throw new BackupPassphraseRequiredError();
  try {
    return {
      session: await unlockLedgerKeyEnvelope(passphrase, header.keyEnvelope),
      usedCurrentSession: false,
    };
  } catch {
    throw new Error('备份加密密码错误，或备份密钥封套已经损坏');
  }
}

export async function createEncryptedBackupContainer(
  payload: BackupPayload,
  reason: BackupArchiveHeader['reason'],
  label: string,
  createdAt = new Date().toISOString(),
  options?: BackupArchiveOptions,
): Promise<CreatedEncryptedBackup> {
  const session = requireLedgerCryptoSession();
  const keyEnvelope = storedLedgerKeyEnvelope();
  if (!keyEnvelope
    || keyEnvelope.ledgerId !== session.ledgerId
    || keyEnvelope.keyringId !== session.keyringId
    || keyEnvelope.generation !== session.generation) {
    throw new Error('本机账本密钥封套与已解锁会话不一致，请重新解锁后再备份');
  }
  return createBackupArchive(session, keyEnvelope, payload, reason, label, createdAt, options);
}

export async function prepareEncryptedBackupContainer(
  payload: BackupPayload,
  reason: BackupArchiveHeader['reason'],
  label: string,
  createdAt = new Date().toISOString(),
  options?: BackupArchiveOptions,
): Promise<PreparedEncryptedBackup> {
  const session = requireLedgerCryptoSession();
  const keyEnvelope = storedLedgerKeyEnvelope();
  if (!keyEnvelope
    || keyEnvelope.ledgerId !== session.ledgerId
    || keyEnvelope.keyringId !== session.keyringId
    || keyEnvelope.generation !== session.generation) {
    throw new Error('本机账本密钥封套与已解锁会话不一致，请重新解锁后再备份');
  }
  return prepareBackupArchive(session, keyEnvelope, payload, reason, label, createdAt, options);
}

export async function parseEncryptedBackup(
  source: BackupArchiveInput,
  passphrase?: string,
): Promise<ParsedEncryptedBackup> {
  const scanned = await scanBackupArchive(source);
  const unlocked = await unlockArchive(scanned.header, passphrase);
  const opened = await openBackupArchive(source, unlocked.session, scanned);
  return {
    container: opened.header,
    payload: opened.payload,
    session: unlocked.session,
    usedCurrentSession: unlocked.usedCurrentSession,
  };
}

export const openBackupContainer = parseEncryptedBackup;

function browserArchiveSource(blob: Blob): BackupArchiveSource {
  return {
    size: blob.size,
    async read(offset, length) {
      return new Uint8Array(await blob.slice(offset, offset + length).arrayBuffer());
    },
  };
}

function nativeArchiveSource(fileName: string, size: number): BackupArchiveSource {
  return {
    size,
    async read(offset, length) {
      const result = new Uint8Array(length);
      for (let readOffset = 0; readOffset < length; readOffset += DESKTOP_TRANSFER_BYTES) {
        const chunkLength = Math.min(DESKTOP_TRANSFER_BYTES, length - readOffset);
        const request = tauriInvoke<number[]>('desktop_read_backup_chunk', {
          fileName,
          offset: offset + readOffset,
          length: chunkLength,
        });
        if (!request) throw new Error('当前环境不能读取桌面备份文件');
        const chunk = new Uint8Array(await request);
        if (chunk.byteLength !== chunkLength) throw new Error('桌面备份分块读取长度不一致');
        result.set(chunk, readOffset);
      }
      return result;
    },
  };
}

function archiveSource(entry: SavedBackup): BackupArchiveSource {
  if (entry.archive) return browserArchiveSource(entry.archive);
  if (entry.nativeFileName) return nativeArchiveSource(entry.nativeFileName, entry.sizeBytes);
  throw new Error('备份正文不在本机，无法读取');
}

async function archiveToBlob(source: BackupArchiveSource): Promise<Blob> {
  const parts: ArrayBuffer[] = [];
  for (let offset = 0; offset < source.size; offset += DESKTOP_TRANSFER_BYTES) {
    const chunk = await source.read(offset, Math.min(DESKTOP_TRANSFER_BYTES, source.size - offset));
    parts.push(chunk.slice().buffer as ArrayBuffer);
  }
  return new Blob(parts, { type: 'application/x-zichan-backup' });
}

async function externalDirectory(): Promise<FileSystemDirectoryHandle | null> {
  return loadKv<FileSystemDirectoryHandle>(EXTERNAL_HANDLE_KEY);
}

export async function externalBackupStatus(): Promise<ExternalBackupStatus> {
  const desktop = tauriInvoke<DesktopBackupStatus>('desktop_backup_status');
  if (desktop) {
    const status = await desktop;
    return {
      kind: 'portable',
      configured: false,
      label: `${status.directory}（便携目录内，非独立副本）`,
    };
  }
  const handle = await externalDirectory();
  return handle
    ? { kind: 'directory', configured: true, label: handle.name }
    : { kind: 'none', configured: false, label: '仅保存在当前浏览器存储' };
}

export async function configureExternalBackupDirectory(): Promise<ExternalBackupStatus> {
  const desktop = await externalBackupStatus();
  if (desktop.kind === 'portable') throw new Error('便携桌面的 data/backups 是本地恢复点；请使用同步服务器或“分享 / 下载”保存到其他磁盘');
  const picker = (window as BackupWindow).showDirectoryPicker;
  if (!picker) throw new Error('当前浏览器不支持选择外部备份目录');
  const handle = await picker({ mode: 'readwrite' });
  await saveKv(EXTERNAL_HANDLE_KEY, handle);
  return { kind: 'directory', configured: true, label: handle.name };
}

async function writeDesktopArchive(
  fileName: string,
  stream: ReadableStream<Uint8Array>,
  estimatedSizeBytes: number,
  expectedArchiveId: string,
  signal?: AbortSignal,
): Promise<{ path: string; sizeBytes: number }> {
  const begin = tauriInvoke<void>('desktop_begin_backup_write', { fileName, estimatedSizeBytes });
  if (!begin) throw new Error('当前环境不能写入桌面备份');
  await begin;
  const reader = stream.getReader();
  let sizeBytes = 0;
  try {
    while (true) {
      if (signal?.aborted) throw new DOMException('备份操作已取消', 'AbortError');
      const next = await reader.read();
      if (next.done) break;
      for (let offset = 0; offset < next.value.byteLength; offset += DESKTOP_TRANSFER_BYTES) {
        if (signal?.aborted) throw new DOMException('备份操作已取消', 'AbortError');
        const chunk = next.value.subarray(offset, Math.min(next.value.byteLength, offset + DESKTOP_TRANSFER_BYTES));
        const append = tauriInvoke<void>('desktop_append_backup_chunk', { fileName, chunk: [...chunk] });
        if (!append) throw new Error('桌面备份分块写入能力不可用');
        await append;
        sizeBytes += chunk.byteLength;
      }
    }
    const commit = tauriInvoke<{ path: string }>('desktop_commit_backup_write', {
      fileName,
      expectedSizeBytes: sizeBytes,
    });
    if (!commit) throw new Error('桌面备份提交能力不可用');
    const result = await commit;
    const header = await readBackupArchiveHeader(nativeArchiveSource(fileName, sizeBytes));
    if (header.archiveId !== expectedArchiveId) {
      await tauriInvoke('desktop_delete_backup_file', { fileName });
      throw new Error('桌面备份写入后的归档头校验失败');
    }
    return { path: result.path, sizeBytes };
  } catch (error) {
    await reader.cancel(error).catch(() => undefined);
    await tauriInvoke('desktop_abort_backup_write', { fileName });
    throw error;
  } finally {
    reader.releaseLock();
  }
}

async function writeExternalBackup(
  entry: SavedBackup,
  stream: ReadableStream<Uint8Array>,
  estimatedSizeBytes: number,
  signal?: AbortSignal,
): Promise<{ saved: boolean; sizeBytes: number; path?: string; error?: string }> {
  try {
    const fileName = backupFileName(entry);
    if (isTauriRuntime()) throw new Error('便携目录内的本地备份不能登记为外部副本');
    const handle = await externalDirectory();
    if (!handle) return { saved: false, sizeBytes: 0, error: '尚未选择外部备份目录' };
    const permission = await (handle as WritableDirectoryHandle).requestPermission({ mode: 'readwrite' });
    if (permission !== 'granted') return { saved: false, sizeBytes: 0, error: '外部备份目录没有写入权限' };
    const file = await handle.getFileHandle(fileName, { create: true });
    const writable = await file.createWritable();
    const reader = stream.getReader();
    let sizeBytes = 0;
    try {
      while (true) {
        if (signal?.aborted) throw new DOMException('备份操作已取消', 'AbortError');
        const next = await reader.read();
        if (next.done) break;
        await writable.write(next.value.slice().buffer as ArrayBuffer);
        sizeBytes += next.value.byteLength;
      }
      await writable.close();
    } catch (error) {
      await reader.cancel(error).catch(() => undefined);
      await writable.abort(error).catch(() => undefined);
      throw error;
    } finally {
      reader.releaseLock();
    }
    const written = await file.getFile();
    if (written.size !== sizeBytes
      || (await readBackupArchiveHeader(written)).archiveId !== entry.container.archiveId) {
      throw new Error('外部备份写入后校验失败');
    }
    return { saved: true, sizeBytes, path: `${handle.name}/${fileName}` };
  } catch (error) {
    return { saved: false, sizeBytes: 0, error: error instanceof Error ? error.message : String(error) };
  }
}

function autoRetention(rows: SavedBackup[], now = Date.now()): SavedBackup[] {
  const pinned = rows
    .filter((row) => row.pinned || row.reason !== 'auto')
    .map((row) => ({ ...row, tier: 'pinned' as const, pinned: true }));
  const auto = rows
    .filter((row) => row.reason === 'auto' && !row.pinned)
    .sort((left, right) => right.createdAt.localeCompare(left.createdAt));
  const kept: SavedBackup[] = [];
  const buckets = new Set<string>();
  for (const row of auto) {
    const age = Math.max(0, now - Date.parse(row.createdAt));
    const date = new Date(row.createdAt);
    const tier: Exclude<BackupTier, 'pinned'> = age < DAY_MS ? 'hourly' : age < 31 * DAY_MS ? 'daily' : 'weekly';
    const key = tier === 'hourly' ? `${tier}:${row.createdAt.slice(0, 13)}`
      : tier === 'daily' ? `${tier}:${row.createdAt.slice(0, 10)}`
        : `${tier}:${date.getUTCFullYear()}:${Math.floor((Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()) - Date.UTC(date.getUTCFullYear(), 0, 1)) / (7 * DAY_MS))}`;
    if (buckets.has(key)) continue;
    if (tier === 'weekly' && kept.filter((item) => item.tier === 'weekly').length >= 12) continue;
    buckets.add(key);
    kept.push({ ...row, tier });
  }
  return [...pinned, ...kept].sort((left, right) => right.createdAt.localeCompare(left.createdAt));
}

function savedFromArchive(
  header: BackupArchiveHeader,
  sizeBytes: number,
  extra: Partial<SavedBackup> = {},
): SavedBackup {
  return {
    id: extra.id ?? newBackupId(),
    createdAt: header.createdAt,
    reason: header.reason,
    label: header.label,
    kind: header.kind,
    tier: header.reason === 'auto' ? 'hourly' : 'pinned',
    pinned: header.reason !== 'auto',
    container: header,
    preflight: extra.preflight ?? emptyPreflight(),
    checksum: header.ledgerSha256,
    sizeBytes,
    ...extra,
  };
}

export async function listSavedBackups(): Promise<SavedBackup[]> {
  const native = tauriInvoke<NativeBackupFile[]>('desktop_list_backup_files');
  if (native) {
    const fileNames = new Map<string, string>();
    const entries: SavedBackup[] = [];
    for (const file of await native) {
      try {
        const bytes = new Uint8Array(file.headerBytes);
        const header = await readBackupArchiveHeader(new Blob([bytes.slice().buffer as ArrayBuffer]));
        const id = /-(bk-[a-z0-9-]+)\.zcbak$/i.exec(file.fileName)?.[1] ?? file.fileName;
        fileNames.set(id, file.fileName);
        entries.push(savedFromArchive(header, file.sizeBytes, {
          id,
          nativeFileName: file.fileName,
          localPath: file.path,
          externalSaved: false,
        }));
      } catch {
        // A partial or unsupported file is not offered as a restore point.
      }
    }
    const retained = autoRetention(entries);
    const retainedIds = new Set(retained.map((entry) => entry.id));
    for (const entry of entries.filter((row) => row.reason === 'auto' && !retainedIds.has(row.id))) {
      const fileName = fileNames.get(entry.id);
      if (fileName) await tauriInvoke('desktop_delete_backup_file', { fileName });
    }
    return retained;
  }
  const rows = await loadKv<SavedBackup[]>(BACKUPS_KEY);
  return autoRetention((Array.isArray(rows) ? rows : []).filter((row) =>
    row.archive instanceof Blob
    && row.archive.size === row.sizeBytes
    && validBackupArchiveHeader(row.container)));
}

async function writeBackups(rows: SavedBackup[]): Promise<void> {
  if (!isTauriRuntime()) await saveKv(BACKUPS_KEY, autoRetention(rows));
  window.dispatchEvent(new CustomEvent('zichan:safety-updated'));
}

export async function saveLedgerBackup(
  store: SqlLedgerStore,
  reason: SavedBackup['reason'],
  label?: string,
  kind: BackupKind = 'device',
  options?: BackupArchiveOptions,
): Promise<SavedBackup> {
  const archiveOptions: BackupArchiveOptions = {
    ...options,
    sourceGeneration: options?.sourceGeneration ?? await store.backupGeneration(),
  };
  const ledger = await exportPortableLedger(store);
  const preflight = await preflightPortableBackup(ledger);
  if (!preflight.ok) throw new Error('当前账本未通过备份预检，已停止写入');
  const payload: BackupPayload = {
    version: 2,
    kind,
    ledger,
    ...(kind === 'device' ? { deviceState: await store.exportDeviceRecoveryState() } : {}),
  };
  const prepared = await prepareEncryptedBackupContainer(
    payload,
    reason,
    label ?? (reason === 'auto' ? '自动备份' : reason === 'pre-import' ? '导入前备份' : '手动备份'),
    new Date().toISOString(),
    archiveOptions,
  );
  let entry: SavedBackup;
  let external: Awaited<ReturnType<typeof writeExternalBackup>> = { saved: false, sizeBytes: 0 };
  let remoteCopies: RemoteBackupResult[] = [];
  if (isTauriRuntime()) {
    entry = savedFromArchive(prepared.header, 0, { preflight });
    const fileName = backupFileName(entry);
    const local = await writeDesktopArchive(
      fileName,
      prepared.createStream(),
      prepared.estimatedSizeBytes,
      entry.container.archiveId,
      archiveOptions.signal,
    );
    entry.sizeBytes = local.sizeBytes;
    entry.nativeFileName = fileName;
    entry.localPath = local.path;
    remoteCopies = await saveEncryptedBackupToSyncServers(
      prepared.header,
      nativeArchiveSource(fileName, local.sizeBytes),
    );
  } else {
    const body = await new Response(prepared.createStream()).blob();
    const archive = body.slice(0, body.size, 'application/x-zichan-backup');
    entry = savedFromArchive(prepared.header, archive.size, { archive, preflight });
    external = await writeExternalBackup(
      entry,
      archive.stream(),
      archive.size,
      archiveOptions.signal,
    );
    remoteCopies = await saveEncryptedBackupToSyncServers(prepared.header, archive);
  }
  const remoteSaved = remoteCopies.filter((copy) => copy.saved);
  const remoteErrors = remoteCopies.filter((copy) => !copy.saved && copy.error);
  Object.assign(entry, {
    externalSaved: external.saved || remoteSaved.length > 0,
    externalPath: external.path
      ?? (remoteSaved.length ? `同步服务器：${remoteSaved.map((copy) => copy.alias).join('、')}` : undefined),
    externalError: [
      external.saved ? undefined : external.error,
      ...remoteErrors.map((copy) => `${copy.alias}：${copy.error}`),
    ].filter(Boolean).join('；') || undefined,
    remoteCopies,
  });
  if (isTauriRuntime() && !entry.externalSaved && !entry.externalError) {
    entry.externalError = '仅保存在便携目录 data/backups；尚无远端或外部目录副本';
  }
  await writeBackups([entry, ...await listSavedBackups()]);
  return entry;
}

export function maybeAutoBackup(store: SqlLedgerStore): Promise<SavedBackup | null> {
  if (automaticBackupSuspensions > 0) return Promise.resolve(null);
  const active = automaticBackupFlights.get(store);
  if (active) return active;
  const flight = (async () => {
    if (!runtimeLedgerCryptoSession()) return null;
    const rows = await listSavedBackups();
    const latestAuto = rows.find((row) => row.reason === 'auto');
    if (latestAuto && Date.now() - Date.parse(latestAuto.createdAt) < AUTO_MIN_INTERVAL_MS) return null;
    const sourceGeneration = await store.backupGeneration();
    if (latestAuto?.container.sourceGeneration === sourceGeneration) return null;
    return saveLedgerBackup(store, 'auto', undefined, 'device', { sourceGeneration });
  })();
  automaticBackupFlights.set(store, flight);
  pendingAutomaticBackupFlights.add(flight);
  void flight.then(
    () => {
      if (automaticBackupFlights.get(store) === flight) automaticBackupFlights.delete(store);
      pendingAutomaticBackupFlights.delete(flight);
    },
    () => {
      if (automaticBackupFlights.get(store) === flight) automaticBackupFlights.delete(store);
      pendingAutomaticBackupFlights.delete(flight);
    },
  );
  return flight;
}

export interface RestoreRehearsal {
  ok: boolean;
  preflight: BackupPreflight;
  consistencyIssues: { kind: string; entityType: string; entityId: string; detail: string }[];
  error?: string;
  checksumOk?: boolean;
  exactMatch?: boolean;
}

export async function rehearseRestore(backup: PortableLedgerBackup): Promise<RestoreRehearsal> {
  const preflight = await preflightPortableBackup(backup);
  if (!preflight.ok) return { ok: false, preflight, consistencyIssues: [] };
  let temp: SqlLedgerStore | null = null;
  try {
    temp = await createLedgerStore(await SqlJsDriver.open(null));
    await importLedger(temp, backup);
    const firstAsset = backup.assets.find((row) => !(row as { isDeleted?: boolean }).isDeleted) as Record<string, unknown> | undefined;
    if (firstAsset) {
      await temp.assets.put({
        ...firstAsset,
        id: 'restore-rehearsal-sentinel',
        code: '__RESTORE_SENTINEL__',
        name: 'restore sentinel',
        createdAt: '',
        updatedAt: '',
        version: 1,
        isDeleted: false,
      } as never);
    }
    await restoreLedger(temp, backup);
    const consistencyIssues = await checkConsistency(temp);
    const sentinelRemoved = !firstAsset
      || !(await temp.assets.list()).some((row) => row.id === 'restore-rehearsal-sentinel');
    return {
      ok: consistencyIssues.length === 0 && sentinelRemoved,
      preflight,
      consistencyIssues,
      exactMatch: sentinelRemoved,
    };
  } catch (error) {
    return {
      ok: false,
      preflight,
      consistencyIssues: [],
      error: error instanceof Error ? error.message : String(error),
    };
  } finally {
    await temp?.close();
  }
}

export async function openSavedBackup(entry: SavedBackup, passphrase?: string): Promise<BackupPayload> {
  return (await parseSavedBackup(entry, passphrase)).payload;
}

export async function parseSavedBackup(
  entry: SavedBackup,
  passphrase?: string,
): Promise<ParsedEncryptedBackup> {
  return parseEncryptedBackup(archiveSource(entry), passphrase);
}

export async function openVerifiedSavedBackup(
  entry: SavedBackup,
  passphrase?: string,
): Promise<ParsedEncryptedBackup> {
  const source = archiveSource(entry);
  const header = await readBackupArchiveHeader(source);
  if (header.archiveId !== entry.container.archiveId || header.ledgerSha256 !== entry.checksum) {
    throw new Error('备份目录元数据与归档校验信息不一致');
  }
  const opened = await parseEncryptedBackup(source, passphrase);
  const preflight = await preflightPortableBackup(opened.payload.ledger);
  if (!preflight.ok) throw new Error('备份账本预检未通过');
  return opened;
}

export async function verifySavedBackup(entry: SavedBackup, passphrase?: string): Promise<boolean> {
  try {
    await openVerifiedSavedBackup(entry, passphrase);
    return true;
  } catch (error) {
    if (error instanceof BackupPassphraseRequiredError || passphrase) throw error;
    return false;
  }
}

export async function prepareRemoteBackupForRestore(
  profile: SyncConnection,
  remote: RemoteBackupArchive,
  passphrase?: string,
): Promise<{ entry: SavedBackup; opened: ParsedEncryptedBackup }> {
  const archive = await downloadRemoteBackup(profile, remote);
  const parsed = await parseEncryptedBackup(archive, passphrase);
  if (parsed.container.archiveId !== remote.archiveId
    || parsed.container.ledgerId !== remote.ledgerId
    || parsed.container.createdAt !== remote.createdAt) {
    throw new Error('服务器备份目录与解密后的归档不一致');
  }
  const preflight = await preflightPortableBackup(parsed.payload.ledger);
  if (!preflight.ok) {
    throw new Error(`服务器备份预检失败：${preflight.issues
      .filter((issue) => issue.level === 'error')
      .map((issue) => issue.message)
      .join('；')}`);
  }
  const entry = savedFromArchive(parsed.container, archive.size, {
    id: `remote-${profile.id}-${remote.archiveId}`,
    archive,
    preflight,
    externalSaved: true,
    externalPath: `同步服务器：${profile.alias}`,
    remoteCopies: [{
      profileId: profile.id,
      alias: profile.alias,
      saved: true,
      archiveId: remote.archiveId,
    }],
  });
  return { entry, opened: parsed };
}

export async function downloadBackup(
  entry: SavedBackup | { backup: PortableLedgerBackup; createdAt: string; label: string },
): Promise<'shared' | 'downloaded' | 'cancelled'> {
  if ('container' in entry && entry.nativeFileName && isTauriRuntime()) {
    const request = tauriInvoke<{ path: string } | null>('desktop_export_backup_file', {
      fileName: entry.nativeFileName,
    });
    if (!request) throw new Error('当前桌面版本不支持原生备份另存为；请更新便携包');
    return (await request) ? 'downloaded' : 'cancelled';
  }
  const created = 'container' in entry
    ? { header: entry.container, blob: entry.archive ?? await archiveToBlob(archiveSource(entry)) }
    : await createEncryptedBackupContainer({
      version: 2,
      kind: 'portable',
      ledger: entry.backup,
    }, 'manual', entry.label, entry.createdAt);
  const fileName = sharedBackupFileName(created.header.createdAt);
  try {
    if (await shareBlobFile(
      created.blob,
      fileName,
      'application/x-zichan-backup',
      created.header.label || '资产生命周期账本加密备份',
    )) return 'shared';
  } catch (error) {
    if (error instanceof DOMException && error.name === 'AbortError') return 'cancelled';
  }
  const url = URL.createObjectURL(created.blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = fileName;
  anchor.click();
  URL.revokeObjectURL(url);
  return 'downloaded';
}

export function describePreflight(preflight: BackupPreflight): string {
  const errors = preflight.issues.filter((issue) => issue.level === 'error').length;
  const warnings = preflight.issues.filter((issue) => issue.level === 'warning').length;
  return `${preflight.summary.entities} 条实体，${preflight.summary.chains} 条链路，${preflight.summary.steps} 个步骤 · ${errors} 错误 / ${warnings} 警告`;
}
