import {
  canonicalJson,
  decryptBackupChunk,
  encryptBackupChunk,
  newId,
  sha256Bytes,
  sha256Json,
  type LedgerCryptoSession,
  type LedgerKeyEnvelope,
} from '@zichan/core';
import type { DeviceRecoveryState } from '@zichan/db';
import {
  activeAttachmentBlobs,
  portableAttachmentSource,
  setPortableAttachmentSource,
  type PortableLedgerBackup,
} from './portable-backup.js';
import { SqlJsDriver } from './sqljs-driver.js';

const MAGIC = new Uint8Array([0x5a, 0x43, 0x42, 0x4b, 0x04, 0x0d, 0x0a, 0x1a]);
const PREFIX_BYTES = MAGIC.length + 4;
const FRAME_PREFIX_BYTES = 8;
const FRAME_HEADER_ESTIMATE_BYTES = 1024;
export const BACKUP_ARCHIVE_CHUNK_BYTES = 1024 * 1024;

export type BackupKind = 'portable' | 'device';
export type BackupReason = 'auto' | 'manual' | 'pre-import';

export interface BackupPayload {
  version: 2;
  kind: BackupKind;
  ledger: PortableLedgerBackup;
  deviceState?: DeviceRecoveryState;
}

export interface BackupArchiveHeader {
  format: 'zichan-encrypted-archive';
  version: 4;
  encoding: 'ndjson-v1';
  archiveId: string;
  kind: BackupKind;
  createdAt: string;
  reason: BackupReason;
  label: string;
  ledgerId: string;
  keyringId: string;
  keyEnvelope: LedgerKeyEnvelope;
  chunkSizeBytes: number;
  frameCount: number;
  ledgerFrameCount: number;
  ledgerSizeBytes: number;
  ledgerSha256: string;
  sourceGeneration?: string;
}

export interface BackupArchiveProgress {
  phase: 'preparing' | 'ledger' | 'attachments' | 'finalizing';
  processedBytes: number;
  totalBytes: number;
}

export interface BackupArchiveOptions {
  signal?: AbortSignal;
  onProgress?: (progress: BackupArchiveProgress) => void;
  sourceGeneration?: string;
}

export interface PreparedBackupArchive {
  header: BackupArchiveHeader;
  estimatedSizeBytes: number;
  createStream(): ReadableStream<Uint8Array>;
}

type FrameKind = 'ledger' | 'blob' | 'end';

interface BackupFrameHeader {
  seq: number;
  kind: FrameKind;
  index: number;
  count: number;
  plainBytes: number;
  cipherBytes: number;
  plaintextSha256: string;
  ivHex: string;
  sha256?: string;
  mimeType?: string;
  totalSizeBytes?: number;
}

interface IndexedFrame {
  header: BackupFrameHeader;
  ciphertextOffset: number;
}

export interface ScannedBackupArchive {
  header: BackupArchiveHeader;
  frames: IndexedFrame[];
}

export interface BackupArchiveSource {
  size: number;
  read(offset: number, length: number): Promise<Uint8Array>;
}

export type BackupArchiveInput = Blob | BackupArchiveSource;

type LedgerSection = Exclude<keyof PortableLedgerBackup, 'version' | 'exportedAt' | 'chains'>;

const LEDGER_SECTIONS = [
  'conversionOperations',
  'costBasisOpenings',
  'assets',
  'accounts',
  'settings',
  'lots',
  'lotConsumptions',
  'priceMarks',
  'dcaPlans',
  'dcaExecutions',
  'games',
  'gameAccounts',
  'gameSeasons',
  'gameRecords',
  'gameCashflowLinks',
  'fixedAssets',
  'fixedAssetCategories',
  'fixedAssetEvents',
  'fixedAssetCashflowLinks',
  'fixedAssetUsageMetrics',
  'fixedAssetUsageLogs',
  'fixedAssetConsumables',
  'fixedAssetGoals',
  'attachments',
  'categories',
  'transactionTags',
  'transactionLocations',
  'transactionTemplates',
  'transactionSavedViews',
  'payees',
  'transactions',
  'transactionSplits',
  'refundAllocations',
  'budgetCategories',
  'scheduledTransactions',
  'scheduledExecutions',
  'reconciliationSessions',
  'reconciliationItems',
] as const satisfies readonly LedgerSection[];

interface BackupManifestRecord {
  record: 'manifest';
  payloadVersion: 2;
  backupKind: BackupKind;
  ledgerVersion: 7 | 8;
  exportedAt: string;
  chainCount: number;
  sections: { name: LedgerSection; count: number }[];
  deviceState?: {
    version: 1;
    tables: { name: string; count: number }[];
  };
}

type BackupNdjsonRecord =
  | BackupManifestRecord
  | { record: 'chain'; value: unknown }
  | { record: 'entity'; section: LedgerSection; value: unknown }
  | { record: 'device'; table: string; value: Record<string, unknown> };

const encoder = new TextEncoder();
const decoder = new TextDecoder();

function u32(value: number): Uint8Array {
  const bytes = new Uint8Array(4);
  new DataView(bytes.buffer).setUint32(0, value, true);
  return bytes;
}

function readU32(bytes: Uint8Array, offset = 0): number {
  if (offset < 0 || offset + 4 > bytes.byteLength) throw new Error('备份归档长度字段截断');
  return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(offset, true);
}

function hex(bytes: Uint8Array): string {
  return [...bytes].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

function unhex(value: string): Uint8Array {
  if (!/^[0-9a-f]+$/i.test(value) || value.length % 2) throw new Error('备份分块 IV 编码无效');
  const out = new Uint8Array(value.length / 2);
  for (let index = 0; index < out.length; index += 1) out[index] = Number.parseInt(value.slice(index * 2, index * 2 + 2), 16);
  return out;
}

function jsonBytes(value: unknown): Uint8Array {
  return encoder.encode(canonicalJson(value));
}

function ndjsonBytes(value: unknown): Uint8Array {
  return encoder.encode(`${canonicalJson(value)}\n`);
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw new DOMException('备份操作已取消', 'AbortError');
}

function validKeyEnvelope(value: unknown): value is LedgerKeyEnvelope {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const row = value as Partial<LedgerKeyEnvelope>;
  return row.v === 1 && row.kdf === 'argon2id'
    && typeof row.ledgerId === 'string' && typeof row.keyringId === 'string'
    && Number.isSafeInteger(row.generation)
    && typeof row.salt === 'string' && Number.isSafeInteger(row.memoryKiB)
    && Number.isSafeInteger(row.iterations) && Number.isSafeInteger(row.parallelism)
    && typeof row.iv === 'string' && typeof row.ct === 'string';
}

export function validBackupArchiveHeader(value: unknown): value is BackupArchiveHeader {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const row = value as Partial<BackupArchiveHeader>;
  return row.format === 'zichan-encrypted-archive' && row.version === 4
    && row.encoding === 'ndjson-v1'
    && typeof row.archiveId === 'string'
    && (row.kind === 'portable' || row.kind === 'device')
    && (row.reason === 'auto' || row.reason === 'manual' || row.reason === 'pre-import')
    && typeof row.createdAt === 'string' && typeof row.label === 'string'
    && typeof row.ledgerId === 'string' && typeof row.keyringId === 'string'
    && validKeyEnvelope(row.keyEnvelope)
    && row.keyEnvelope.ledgerId === row.ledgerId && row.keyEnvelope.keyringId === row.keyringId
    && row.chunkSizeBytes === BACKUP_ARCHIVE_CHUNK_BYTES
    && Number.isSafeInteger(row.frameCount) && (row.frameCount ?? 0) > 1
    && Number.isSafeInteger(row.ledgerFrameCount) && (row.ledgerFrameCount ?? 0) > 0
    && (row.ledgerFrameCount ?? 0) < (row.frameCount ?? 0)
    && Number.isSafeInteger(row.ledgerSizeBytes) && (row.ledgerSizeBytes ?? -1) >= 0
    && typeof row.ledgerSha256 === 'string' && /^[0-9a-f]{64}$/.test(row.ledgerSha256)
    && (row.sourceGeneration == null
      || (typeof row.sourceGeneration === 'string' && /^[A-Za-z0-9:_-]{1,256}$/.test(row.sourceGeneration)));
}

function manifestFor(payload: BackupPayload): BackupManifestRecord {
  if (payload.version !== 2 || (payload.kind !== 'portable' && payload.kind !== 'device')) {
    throw new Error('备份正文版本无效');
  }
  if (payload.ledger.version !== 7 && payload.ledger.version !== 8) throw new Error('账本备份版本无效');
  if (payload.kind === 'device' && payload.deviceState?.version !== 1) {
    throw new Error('完整设备备份缺少设备恢复状态');
  }
  return {
    record: 'manifest',
    payloadVersion: 2,
    backupKind: payload.kind,
    ledgerVersion: payload.ledger.version,
    exportedAt: payload.ledger.exportedAt,
    chainCount: payload.ledger.chains.length,
    sections: LEDGER_SECTIONS.filter((name) => payload.ledger.version === 8 || (name !== 'costBasisOpenings' && name !== 'conversionOperations')).map((name) => ({
      name,
      count: (payload.ledger[name] as unknown[] | undefined)?.length ?? 0,
    })),
    ...(payload.kind === 'device' ? {
      deviceState: {
        version: 1 as const,
        tables: Object.entries(payload.deviceState!.tables)
          .sort(([left], [right]) => left.localeCompare(right))
          .map(([name, rows]) => ({ name, count: rows.length })),
      },
    } : {}),
  };
}

function* payloadRecords(payload: BackupPayload): Generator<BackupNdjsonRecord> {
  const manifest = manifestFor(payload);
  yield manifest;
  for (const value of payload.ledger.chains) yield { record: 'chain', value };
  for (const { name: section } of manifest.sections) {
    for (const value of (payload.ledger[section] as unknown[] | undefined) ?? []) {
      yield { record: 'entity', section, value };
    }
  }
  if (payload.kind === 'device') {
    for (const table of manifest.deviceState!.tables) {
      for (const value of payload.deviceState!.tables[table.name] ?? []) {
        yield { record: 'device', table: table.name, value };
      }
    }
  }
}

async function* ledgerPayloadChunks(payload: BackupPayload): AsyncGenerator<Uint8Array> {
  let buffer = new Uint8Array(BACKUP_ARCHIVE_CHUNK_BYTES);
  let used = 0;
  for (const record of payloadRecords(payload)) {
    const bytes = ndjsonBytes(record);
    let offset = 0;
    while (offset < bytes.byteLength) {
      const copied = Math.min(buffer.byteLength - used, bytes.byteLength - offset);
      buffer.set(bytes.subarray(offset, offset + copied), used);
      used += copied;
      offset += copied;
      if (used === buffer.byteLength) {
        yield buffer;
        buffer = new Uint8Array(BACKUP_ARCHIVE_CHUNK_BYTES);
        used = 0;
      }
    }
  }
  if (used > 0) yield buffer.slice(0, used);
}

async function inspectLedgerPayload(payload: BackupPayload): Promise<{
  sizeBytes: number;
  frameHashes: string[];
}> {
  let sizeBytes = 0;
  const frameHashes: string[] = [];
  for await (const chunk of ledgerPayloadChunks(payload)) {
    sizeBytes += chunk.byteLength;
    frameHashes.push(await sha256Bytes(chunk));
  }
  if (!frameHashes.length) throw new Error('备份账本正文为空');
  return { sizeBytes, frameHashes };
}

function frameContext(
  archive: BackupArchiveHeader,
  frame: Omit<BackupFrameHeader, 'ivHex'>,
): Record<string, unknown> {
  return { archive, frame };
}

async function encryptedFrame(
  session: LedgerCryptoSession,
  archive: BackupArchiveHeader,
  frame: Omit<BackupFrameHeader, 'ivHex' | 'cipherBytes' | 'plaintextSha256'>,
  plaintext: Uint8Array,
): Promise<Uint8Array[]> {
  const base = {
    ...frame,
    cipherBytes: plaintext.byteLength + 16,
    plaintextSha256: await sha256Bytes(plaintext),
  };
  const encrypted = await encryptBackupChunk(session, plaintext, frameContext(archive, base));
  const header: BackupFrameHeader = { ...base, ivHex: hex(encrypted.iv) };
  const headerBytes = jsonBytes(header);
  if (headerBytes.byteLength > 64 * 1024) throw new Error('备份分块头过大');
  return [u32(headerBytes.byteLength), u32(encrypted.ciphertext.byteLength), headerBytes, encrypted.ciphertext];
}

function frameCountFor(size: number): number {
  return Math.max(1, Math.ceil(size / BACKUP_ARCHIVE_CHUNK_BYTES));
}

async function* archiveParts(
  session: LedgerCryptoSession,
  header: BackupArchiveHeader,
  payload: BackupPayload,
  options?: BackupArchiveOptions,
): AsyncGenerator<Uint8Array> {
  const headerBytes = jsonBytes(header);
  yield MAGIC;
  yield u32(headerBytes.byteLength);
  yield headerBytes;

  const refs = activeAttachmentBlobs(payload.ledger);
  const totalBytes = header.ledgerSizeBytes + refs.reduce((total, ref) => total + ref.sizeBytes, 0);
  let processedBytes = 0;
  let seq = 0;
  let ledgerIndex = 0;
  for await (const chunk of ledgerPayloadChunks(payload)) {
    throwIfAborted(options?.signal);
    for (const part of await encryptedFrame(session, header, {
      seq,
      kind: 'ledger',
      index: ledgerIndex,
      count: header.ledgerFrameCount,
      plainBytes: chunk.byteLength,
    }, chunk)) yield part;
    seq += 1;
    ledgerIndex += 1;
    processedBytes += chunk.byteLength;
    options?.onProgress?.({ phase: 'ledger', processedBytes, totalBytes });
  }

  const source = portableAttachmentSource(payload.ledger);
  for (const ref of refs) {
    throwIfAborted(options?.signal);
    if (!source) throw new Error(`附件 ${ref.sha256.slice(0, 12)}… 缺少正文来源`);
    const blob = await source(ref.sha256, ref.mimeType, ref.sizeBytes);
    if (blob.size !== ref.sizeBytes) throw new Error(`附件 ${ref.sha256.slice(0, 12)}… 大小与清单不一致`);
    const count = frameCountFor(blob.size);
    for (let index = 0; index < count; index += 1) {
      throwIfAborted(options?.signal);
      const chunk = new Uint8Array(await blob.slice(
        index * BACKUP_ARCHIVE_CHUNK_BYTES,
        Math.min(blob.size, (index + 1) * BACKUP_ARCHIVE_CHUNK_BYTES),
      ).arrayBuffer());
      for (const part of await encryptedFrame(session, header, {
        seq,
        kind: 'blob',
        index,
        count,
        plainBytes: chunk.byteLength,
        sha256: ref.sha256,
        mimeType: ref.mimeType,
        totalSizeBytes: ref.sizeBytes,
      }, chunk)) yield part;
      seq += 1;
      processedBytes += chunk.byteLength;
      options?.onProgress?.({ phase: 'attachments', processedBytes, totalBytes });
    }
  }

  throwIfAborted(options?.signal);
  for (const part of await encryptedFrame(session, header, {
    seq, kind: 'end', index: 0, count: 1, plainBytes: 0,
  }, new Uint8Array())) yield part;
  if (seq + 1 !== header.frameCount) throw new Error('备份归档分块计数内部不一致');
  options?.onProgress?.({ phase: 'finalizing', processedBytes: totalBytes, totalBytes });
}

function streamFromGenerator(generator: AsyncGenerator<Uint8Array>): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const next = await generator.next();
        if (next.done) controller.close();
        else controller.enqueue(next.value);
      } catch (error) {
        controller.error(error);
      }
    },
    async cancel() {
      await generator.return(undefined);
    },
  });
}

export async function prepareBackupArchive(
  session: LedgerCryptoSession,
  keyEnvelope: LedgerKeyEnvelope,
  payload: BackupPayload,
  reason: BackupReason,
  label: string,
  createdAt = new Date().toISOString(),
  options?: BackupArchiveOptions,
): Promise<PreparedBackupArchive> {
  if (keyEnvelope.ledgerId !== session.ledgerId
    || keyEnvelope.keyringId !== session.keyringId
    || keyEnvelope.generation !== session.generation) {
    throw new Error('本机账本密钥封套与已解锁会话不一致，请重新解锁后再备份');
  }
  throwIfAborted(options?.signal);
  options?.onProgress?.({ phase: 'preparing', processedBytes: 0, totalBytes: 0 });
  const inspected = await inspectLedgerPayload(payload);
  const refs = activeAttachmentBlobs(payload.ledger);
  const blobFrames = refs.reduce((total, ref) => total + frameCountFor(ref.sizeBytes), 0);
  const header: BackupArchiveHeader = {
    format: 'zichan-encrypted-archive',
    version: 4,
    encoding: 'ndjson-v1',
    archiveId: newId(),
    kind: payload.kind,
    createdAt,
    reason,
    label,
    ledgerId: session.ledgerId,
    keyringId: session.keyringId,
    keyEnvelope,
    chunkSizeBytes: BACKUP_ARCHIVE_CHUNK_BYTES,
    frameCount: inspected.frameHashes.length + blobFrames + 1,
    ledgerFrameCount: inspected.frameHashes.length,
    ledgerSizeBytes: inspected.sizeBytes,
    ledgerSha256: await sha256Json({
      encoding: 'ndjson-v1',
      frameHashes: inspected.frameHashes,
    }),
    ...(options?.sourceGeneration ? { sourceGeneration: options.sourceGeneration } : {}),
  };
  const plainBytes = inspected.sizeBytes + refs.reduce((total, ref) => total + ref.sizeBytes, 0);
  const estimatedSizeBytes = PREFIX_BYTES + jsonBytes(header).byteLength + plainBytes
    + header.frameCount * (FRAME_PREFIX_BYTES + FRAME_HEADER_ESTIMATE_BYTES + 16);
  return {
    header,
    estimatedSizeBytes,
    createStream: () => streamFromGenerator(archiveParts(session, header, payload, options)),
  };
}

export async function createBackupArchive(
  session: LedgerCryptoSession,
  keyEnvelope: LedgerKeyEnvelope,
  payload: BackupPayload,
  reason: BackupReason,
  label: string,
  createdAt = new Date().toISOString(),
  options?: BackupArchiveOptions,
): Promise<{ header: BackupArchiveHeader; blob: Blob }> {
  const prepared = await prepareBackupArchive(
    session,
    keyEnvelope,
    payload,
    reason,
    label,
    createdAt,
    options,
  );
  const blob = await new Response(prepared.createStream()).blob();
  return {
    header: prepared.header,
    blob: blob.slice(0, blob.size, 'application/x-zichan-backup'),
  };
}

function sourceSize(source: BackupArchiveInput): number {
  return source.size;
}

async function readBytes(source: BackupArchiveInput, offset: number, length: number): Promise<Uint8Array> {
  if (offset < 0 || length < 0 || offset + length > sourceSize(source)) throw new Error('备份归档被截断');
  if (source instanceof Blob) return new Uint8Array(await source.slice(offset, offset + length).arrayBuffer());
  const bytes = await source.read(offset, length);
  if (bytes.byteLength !== length) throw new Error('备份归档分块读取长度不一致');
  return bytes;
}

export async function readBackupArchiveHeader(source: BackupArchiveInput): Promise<BackupArchiveHeader> {
  if (sourceSize(source) < PREFIX_BYTES) throw new Error('文件太小，不是当前备份归档');
  const prefix = await readBytes(source, 0, PREFIX_BYTES);
  if (!MAGIC.every((value, index) => prefix[index] === value)) throw new Error('文件不是当前版本的加密备份归档');
  const headerLength = readU32(prefix, MAGIC.length);
  if (headerLength < 128 || headerLength > 1024 * 1024 || PREFIX_BYTES + headerLength > sourceSize(source)) {
    throw new Error('备份归档头长度无效');
  }
  const parsed = JSON.parse(decoder.decode(await readBytes(source, PREFIX_BYTES, headerLength))) as unknown;
  if (!validBackupArchiveHeader(parsed)) throw new Error('备份归档头无效或版本不受支持');
  return parsed;
}

function validFrameHeader(value: unknown, seq: number): value is BackupFrameHeader {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const row = value as Partial<BackupFrameHeader>;
  return row.seq === seq
    && (row.kind === 'ledger' || row.kind === 'blob' || row.kind === 'end')
    && Number.isSafeInteger(row.index) && (row.index ?? -1) >= 0
    && Number.isSafeInteger(row.count) && (row.count ?? 0) > 0
    && Number.isSafeInteger(row.plainBytes) && (row.plainBytes ?? -1) >= 0
    && Number.isSafeInteger(row.cipherBytes) && row.cipherBytes === (row.plainBytes ?? 0) + 16
    && typeof row.plaintextSha256 === 'string' && /^[0-9a-f]{64}$/.test(row.plaintextSha256)
    && typeof row.ivHex === 'string' && /^[0-9a-f]{24}$/.test(row.ivHex)
    && (row.kind !== 'blob'
      || (typeof row.sha256 === 'string' && /^[0-9a-f]{64}$/.test(row.sha256)
        && typeof row.mimeType === 'string'
        && Number.isSafeInteger(row.totalSizeBytes) && (row.totalSizeBytes ?? -1) >= 0));
}

export async function scanBackupArchive(source: BackupArchiveInput): Promise<ScannedBackupArchive> {
  const header = await readBackupArchiveHeader(source);
  const headerBytes = jsonBytes(header);
  let offset = PREFIX_BYTES + headerBytes.byteLength;
  const frames: IndexedFrame[] = [];
  for (let seq = 0; seq < header.frameCount; seq += 1) {
    const prefix = await readBytes(source, offset, FRAME_PREFIX_BYTES);
    offset += FRAME_PREFIX_BYTES;
    const frameHeaderLength = readU32(prefix, 0);
    const ciphertextLength = readU32(prefix, 4);
    if (frameHeaderLength < 64 || frameHeaderLength > 64 * 1024) throw new Error(`备份分块 ${seq} 的头长度无效`);
    if (ciphertextLength < 16 || ciphertextLength > BACKUP_ARCHIVE_CHUNK_BYTES + 16) throw new Error(`备份分块 ${seq} 的正文长度无效`);
    const frameHeader = JSON.parse(decoder.decode(await readBytes(source, offset, frameHeaderLength))) as unknown;
    offset += frameHeaderLength;
    if (!validFrameHeader(frameHeader, seq) || frameHeader.cipherBytes !== ciphertextLength) {
      throw new Error(`备份分块 ${seq} 的清单无效`);
    }
    frames.push({ header: frameHeader, ciphertextOffset: offset });
    offset += ciphertextLength;
    if (offset > sourceSize(source)) throw new Error(`备份分块 ${seq} 被截断`);
  }
  if (offset !== sourceSize(source)) throw new Error('备份归档尾部存在未声明数据');
  if (frames.at(-1)?.header.kind !== 'end') throw new Error('备份归档缺少完成标记');
  return { header, frames };
}

async function decryptFrame(
  source: BackupArchiveInput,
  archive: BackupArchiveHeader,
  frame: IndexedFrame,
  session: LedgerCryptoSession,
): Promise<Uint8Array> {
  const { ivHex, ...contextHeader } = frame.header;
  const ciphertext = await readBytes(source, frame.ciphertextOffset, frame.header.cipherBytes);
  const plaintext = await decryptBackupChunk(session, {
    v: 1,
    iv: unhex(ivHex),
    ciphertext,
  }, frameContext(archive, contextHeader));
  if (plaintext.byteLength !== frame.header.plainBytes
    || await sha256Bytes(plaintext) !== frame.header.plaintextSha256) {
    throw new Error(`备份分块 ${frame.header.seq} 解密后校验失败`);
  }
  return plaintext;
}

function validManifest(value: unknown, archive: BackupArchiveHeader): value is BackupManifestRecord {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const row = value as Partial<BackupManifestRecord>;
  if (row.record !== 'manifest' || row.payloadVersion !== 2 || row.backupKind !== archive.kind
    || (row.ledgerVersion !== 7 && row.ledgerVersion !== 8) || typeof row.exportedAt !== 'string'
    || !Number.isSafeInteger(row.chainCount) || (row.chainCount ?? -1) < 0
    || !Array.isArray(row.sections) || row.sections.length !== LEDGER_SECTIONS.length - (row.ledgerVersion === 7 ? 2 : 0)) return false;
  const expected = new Set<string>(LEDGER_SECTIONS.filter((name) => row.ledgerVersion === 8 || (name !== 'costBasisOpenings' && name !== 'conversionOperations')));
  if (row.sections.some((section) =>
    !section || !expected.delete(section.name)
    || !Number.isSafeInteger(section.count) || section.count < 0)) return false;
  if (archive.kind === 'portable') return row.deviceState == null;
  return row.deviceState?.version === 1
    && Array.isArray(row.deviceState.tables)
    && new Set(row.deviceState.tables.map((table) => table.name)).size === row.deviceState.tables.length
    && row.deviceState.tables.every((table) =>
      /^[a-z][a-z0-9_]{0,63}$/.test(table.name)
      && Number.isSafeInteger(table.count) && table.count >= 0);
}

function parseRecord(line: string): unknown {
  try {
    return JSON.parse(line) as unknown;
  } catch {
    throw new Error('备份 NDJSON 正文包含无效记录');
  }
}

async function decodeLedgerPayload(
  source: BackupArchiveInput,
  index: ScannedBackupArchive,
  session: LedgerCryptoSession,
): Promise<BackupPayload> {
  const ledgerFrames = index.frames.filter((frame) => frame.header.kind === 'ledger')
    .sort((left, right) => left.header.index - right.header.index);
  if (ledgerFrames.length !== index.header.ledgerFrameCount
    || ledgerFrames.some((frame, position) =>
      frame.header.index !== position || frame.header.count !== ledgerFrames.length)
    || ledgerFrames.reduce((total, frame) => total + frame.header.plainBytes, 0) !== index.header.ledgerSizeBytes
    || await sha256Json({
      encoding: 'ndjson-v1',
      frameHashes: ledgerFrames.map((frame) => frame.header.plaintextSha256),
    }) !== index.header.ledgerSha256) {
    throw new Error('备份账本正文分块不连续或清单校验失败');
  }

  let manifest: BackupManifestRecord | undefined;
  let pending = '';
  const textDecoder = new TextDecoder();
  const sectionCounts = new Map<LedgerSection, number>();
  const deviceCounts = new Map<string, number>();
  let chainCount = 0;
  const staging = await SqlJsDriver.open(null);
  let sequence = 0;
  try {
    await staging.run(
      `CREATE TABLE backup_restore_staging (
        seq INTEGER PRIMARY KEY,
        record_kind TEXT NOT NULL,
        section_name TEXT,
        value_json TEXT NOT NULL
      )`,
    );
    await staging.run(
      'CREATE INDEX backup_restore_staging_lookup ON backup_restore_staging(record_kind, section_name, seq)',
    );

    const stage = async (record: unknown) => {
      if (!manifest) {
        if (!validManifest(record, index.header)) throw new Error('备份 NDJSON 清单无效');
        manifest = record;
        for (const section of LEDGER_SECTIONS) sectionCounts.set(section, 0);
        return;
      }
      if (!record || typeof record !== 'object' || Array.isArray(record)) {
        throw new Error('备份 NDJSON 记录无效');
      }
      const row = record as Partial<BackupNdjsonRecord>;
      let kind: 'chain' | 'entity' | 'device';
      let section: string;
      let value: unknown;
      if (row.record === 'chain') {
        kind = 'chain';
        section = '';
        value = row.value;
        chainCount += 1;
      } else if (row.record === 'entity' && typeof row.section === 'string'
        && LEDGER_SECTIONS.includes(row.section as LedgerSection)) {
        kind = 'entity';
        section = row.section;
        value = row.value;
        sectionCounts.set(row.section as LedgerSection, (sectionCounts.get(row.section as LedgerSection) ?? 0) + 1);
      } else if (row.record === 'device' && manifest.deviceState
        && typeof row.table === 'string'
        && manifest.deviceState.tables.some((table) => table.name === row.table)
        && row.value && typeof row.value === 'object' && !Array.isArray(row.value)) {
        kind = 'device';
        section = row.table;
        value = row.value;
        deviceCounts.set(row.table, (deviceCounts.get(row.table) ?? 0) + 1);
      } else {
        throw new Error('备份 NDJSON 包含未知或顺序错误的记录');
      }
      const valueJson = JSON.stringify(value);
      if (typeof valueJson !== 'string') throw new Error('备份 NDJSON 记录正文无法序列化');
      await staging.run(
        `INSERT INTO backup_restore_staging
         (seq, record_kind, section_name, value_json) VALUES (?, ?, ?, ?)`,
        [sequence, kind, section || null, valueJson],
      );
      sequence += 1;
    };

    for (const frame of ledgerFrames) {
      const chunk = await decryptFrame(source, index.header, frame, session);
      pending += textDecoder.decode(chunk, { stream: true });
      const lines = pending.split('\n');
      pending = lines.pop() ?? '';
      for (const line of lines) {
        if (!line) throw new Error('备份 NDJSON 包含空记录');
        await stage(parseRecord(line));
      }
    }
    pending += textDecoder.decode();
    if (pending.length) throw new Error('备份 NDJSON 最后一条记录未完整结束');
    if (!manifest || chainCount !== manifest.chainCount
      || manifest.sections.some((section) => sectionCounts.get(section.name) !== section.count)
      || manifest.deviceState?.tables.some((table) => (deviceCounts.get(table.name) ?? 0) !== table.count)) {
      throw new Error('备份 NDJSON 实体数量与清单不一致');
    }

    const stagedValues = async (kind: 'chain' | 'entity' | 'device', section?: string): Promise<unknown[]> => {
      const result: unknown[] = [];
      let cursor = -1;
      while (true) {
        const rows = await staging.all<{ seq: number; value_json: string }>(
          `SELECT seq, value_json FROM backup_restore_staging
           WHERE record_kind = ? AND seq > ? ${section === undefined ? '' : 'AND section_name = ?'}
           ORDER BY seq LIMIT 500`,
          section === undefined ? [kind, cursor] : [kind, cursor, section],
        );
        if (!rows.length) break;
        for (const row of rows) result.push(JSON.parse(row.value_json) as unknown);
        cursor = Number(rows.at(-1)!.seq);
      }
      return result;
    };
    const ledger = {
      version: manifest.ledgerVersion,
      exportedAt: manifest.exportedAt,
      chains: await stagedValues('chain') as PortableLedgerBackup['chains'],
    } as unknown as PortableLedgerBackup;
    for (const { name: section } of manifest.sections) {
      (ledger as unknown as Record<string, unknown[]>)[section] = await stagedValues('entity', section);
    }
    return {
      version: 2,
      kind: manifest.backupKind,
      ledger,
      ...(manifest.deviceState ? {
        deviceState: {
          version: 1,
          tables: Object.fromEntries(await Promise.all(manifest.deviceState.tables.map(async (table) => [
            table.name,
            await stagedValues('device', table.name) as Record<string, unknown>[],
          ]))),
        },
      } : {}),
    };
  } finally {
    await staging.close();
  }
}

export async function openBackupArchive(
  source: BackupArchiveInput,
  session: LedgerCryptoSession,
  scanned?: ScannedBackupArchive,
): Promise<{ header: BackupArchiveHeader; payload: BackupPayload }> {
  const index = scanned ?? await scanBackupArchive(source);
  if (session.ledgerId !== index.header.ledgerId || session.keyringId !== index.header.keyringId) {
    throw new Error('账本密钥与备份归档不匹配');
  }
  const end = index.frames.at(-1)!;
  await decryptFrame(source, index.header, end, session);
  const payload = await decodeLedgerPayload(source, index, session);

  const blobFrames = new Map<string, IndexedFrame[]>();
  for (const frame of index.frames.filter((row) => row.header.kind === 'blob')) {
    const key = frame.header.sha256!;
    const rows = blobFrames.get(key) ?? [];
    rows.push(frame);
    blobFrames.set(key, rows);
  }
  setPortableAttachmentSource(payload.ledger, async (sha256, mimeType, expectedSizeBytes) => {
    const rows = (blobFrames.get(sha256) ?? []).sort((left, right) => left.header.index - right.header.index);
    if (!rows.length
      || rows.some((frame, position) =>
        frame.header.index !== position
        || frame.header.count !== rows.length
        || frame.header.sha256 !== sha256
        || frame.header.totalSizeBytes !== expectedSizeBytes)) {
      throw new Error(`附件 ${sha256.slice(0, 12)}… 的归档分块缺失或不连续`);
    }
    const parts: ArrayBuffer[] = [];
    for (const frame of rows) {
      const part = await decryptFrame(source, index.header, frame, session);
      parts.push(part.slice().buffer as ArrayBuffer);
    }
    const body = new Blob(parts, { type: mimeType });
    if (body.size !== expectedSizeBytes) throw new Error(`附件 ${sha256.slice(0, 12)}… 解密后大小不一致`);
    return body;
  });
  return { header: index.header, payload };
}
