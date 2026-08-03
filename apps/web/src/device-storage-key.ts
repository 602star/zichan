import {
  createLedgerKeyEnvelope,
  decryptAttachmentChunk,
  deriveAttachmentCryptoContext,
  encryptAttachmentChunk,
  newId,
  unlockLedgerKeyEnvelope,
  type LedgerCryptoSession,
  type LedgerKeyEnvelope,
} from '@zichan/core';
import {
  credentialVaultState,
  lockCredentialVault,
  readCredentialVaultRecord,
  refreshCredentialVaultState,
  unlockCredentialVault,
  writeCredentialVaultRecord,
} from './credential-vault.js';
import { loadSyncProfiles } from './sync-config.js';
import { isTauriRuntime } from './tauri.js';

export const DEVICE_STORAGE_ENVELOPE_KEY = 'zichan.device.storageEnvelope.v1';
export const DEVICE_STORAGE_STATE_CHANGED_EVENT = 'zichan:device-storage-state-changed';

const NATIVE_STORAGE_RECORD = 'device-storage:v1';
const ATTACHMENT_MAGIC = new TextEncoder().encode('ZCATENC1');
const ATTACHMENT_CHUNK_BYTES = 1024 * 1024;

interface NativeStorageRecord {
  v: 1;
  storageId: string;
  databaseKeyHex: string;
  attachmentSecret: string;
  backupSecret: string;
}

interface AttachmentChunkHeader {
  index: number;
  iv: string;
  ciphertextSha256: string;
  ciphertextBytes: number;
}

interface EncryptedAttachmentHeader {
  format: 'zichan-device-attachment';
  version: 1;
  storageId: string;
  keyringId: string;
  plaintextSha256: string;
  sizeBytes: number;
  mimeType: string;
  chunks: AttachmentChunkHeader[];
}

export interface DeviceStorageState {
  kind: 'browser-envelope' | 'native-stronghold';
  initialized: boolean;
  unlocked: boolean;
  platform: string;
  storageId?: string;
  message: string;
}

export interface DeviceStorageSession {
  state: DeviceStorageState;
  cryptoSession: LedgerCryptoSession;
  databaseKeyHex?: string;
}

let runtimeSession: DeviceStorageSession | undefined;

function emit(): void {
  globalThis.dispatchEvent?.(new CustomEvent(DEVICE_STORAGE_STATE_CHANGED_EVENT));
}

function bytesToBase64(bytes: Uint8Array): string {
  let binary = '';
  for (let offset = 0; offset < bytes.length; offset += 32_768) {
    binary += String.fromCharCode(...bytes.subarray(offset, Math.min(offset + 32_768, bytes.length)));
  }
  return btoa(binary);
}

function base64ToBytes(value: string): Uint8Array {
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return bytes;
}

function hex(bytes: Uint8Array): string {
  return [...bytes].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

function validEnvelope(value: unknown): value is LedgerKeyEnvelope {
  if (!value || typeof value !== 'object') return false;
  const row = value as Partial<LedgerKeyEnvelope>;
  return row.v === 1 && row.kdf === 'argon2id'
    && typeof row.ledgerId === 'string' && typeof row.keyringId === 'string'
    && Number.isSafeInteger(row.generation) && typeof row.salt === 'string'
    && typeof row.iv === 'string' && typeof row.ct === 'string';
}

function storedBrowserEnvelope(): LedgerKeyEnvelope | undefined {
  try {
    const raw = globalThis.localStorage?.getItem(DEVICE_STORAGE_ENVELOPE_KEY);
    if (!raw) return undefined;
    const parsed = JSON.parse(raw) as unknown;
    return validEnvelope(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
}

function validNativeRecord(value: unknown): value is NativeStorageRecord {
  if (!value || typeof value !== 'object') return false;
  const row = value as Partial<NativeStorageRecord>;
  return row.v === 1
    && typeof row.storageId === 'string' && /^[A-Za-z0-9_-]{16,128}$/.test(row.storageId)
    && typeof row.databaseKeyHex === 'string' && /^[a-f0-9]{64}$/.test(row.databaseKeyHex)
    && typeof row.attachmentSecret === 'string'
    && typeof row.backupSecret === 'string';
}

function nativeCryptoSession(record: NativeStorageRecord): LedgerCryptoSession {
  const attachmentSecret = base64ToBytes(record.attachmentSecret);
  const backupSecret = base64ToBytes(record.backupSecret);
  if (attachmentSecret.length !== 32 || backupSecret.length !== 32) throw new Error('Stronghold 中的设备存储密钥长度无效');
  return {
    v: 1,
    ledgerId: record.storageId,
    keyringId: `device_${record.storageId}`,
    generation: 1,
    activeKeyId: 'device-storage',
    dataKeys: new Map(),
    attachmentSecret,
    backupSecret,
  };
}

function createNativeRecord(): NativeStorageRecord {
  const databaseKey = crypto.getRandomValues(new Uint8Array(32));
  const attachmentSecret = crypto.getRandomValues(new Uint8Array(32));
  const backupSecret = crypto.getRandomValues(new Uint8Array(32));
  return {
    v: 1,
    storageId: newId(),
    databaseKeyHex: hex(databaseKey),
    attachmentSecret: bytesToBase64(attachmentSecret),
    backupSecret: bytesToBase64(backupSecret),
  };
}

export async function refreshDeviceStorageState(): Promise<DeviceStorageState> {
  if (runtimeSession) return { ...runtimeSession.state };
  if (isTauriRuntime()) {
    const vault = await refreshCredentialVaultState();
    return {
      kind: 'native-stronghold',
      initialized: vault.initialized,
      unlocked: false,
      platform: vault.platform,
      message: vault.initialized ? '输入本机数据密码解锁加密账本' : '设置本机数据密码并创建加密账本',
    };
  }
  const envelope = storedBrowserEnvelope();
  return {
    kind: 'browser-envelope',
    initialized: !!envelope,
    unlocked: false,
    platform: 'web',
    storageId: envelope?.ledgerId,
    message: envelope ? '输入本机数据密码解锁浏览器账本' : '设置本机数据密码并创建加密浏览器账本',
  };
}

export async function unlockDeviceStorage(passphrase: string): Promise<DeviceStorageSession> {
  if (passphrase.length < 8) throw new Error('本机数据密码至少需要 8 个字符');
  if (isTauriRuntime()) {
    await unlockCredentialVault(passphrase, loadSyncProfiles().map((profile) => profile.id));
    const raw = await readCredentialVaultRecord(NATIVE_STORAGE_RECORD);
    let record: NativeStorageRecord;
    if (raw?.length) {
      const parsed = JSON.parse(new TextDecoder().decode(new Uint8Array(raw))) as unknown;
      if (!validNativeRecord(parsed)) throw new Error('Stronghold 中的设备存储密钥已损坏');
      record = parsed;
    } else {
      record = createNativeRecord();
      await writeCredentialVaultRecord(
        NATIVE_STORAGE_RECORD,
        new TextEncoder().encode(JSON.stringify(record)),
      );
    }
    const vault = credentialVaultState();
    runtimeSession = {
      state: {
        kind: 'native-stronghold',
        initialized: true,
        unlocked: true,
        platform: vault.platform,
        storageId: record.storageId,
        message: 'SQLite 与附件已由 Stronghold 设备密钥保护',
      },
      cryptoSession: nativeCryptoSession(record),
      databaseKeyHex: record.databaseKeyHex,
    };
  } else {
    const envelope = storedBrowserEnvelope();
    const unlocked = envelope
      ? { envelope, session: await unlockLedgerKeyEnvelope(passphrase, envelope) }
      : await createLedgerKeyEnvelope(newId(), passphrase);
    if (!envelope) globalThis.localStorage?.setItem(DEVICE_STORAGE_ENVELOPE_KEY, JSON.stringify(unlocked.envelope));
    runtimeSession = {
      state: {
        kind: 'browser-envelope',
        initialized: true,
        unlocked: true,
        platform: 'web',
        storageId: unlocked.session.ledgerId,
        message: 'IndexedDB 数据库与附件已加密保存',
      },
      cryptoSession: unlocked.session,
    };
  }
  emit();
  return runtimeSession;
}

export function requireDeviceStorageSession(): DeviceStorageSession {
  if (!runtimeSession) throw new Error('请先解锁本机加密数据');
  return runtimeSession;
}

export async function lockDeviceStorage(): Promise<void> {
  runtimeSession = undefined;
  if (isTauriRuntime() && credentialVaultState().unlocked) await lockCredentialVault();
  emit();
}

function u32(value: number): Uint8Array {
  const bytes = new Uint8Array(4);
  new DataView(bytes.buffer).setUint32(0, value, true);
  return bytes;
}

function readU32(bytes: Uint8Array, offset: number): number {
  if (offset + 4 > bytes.length) throw new Error('加密附件头已截断');
  return new DataView(bytes.buffer, bytes.byteOffset + offset, 4).getUint32(0, true);
}

function blobPart(bytes: Uint8Array): ArrayBuffer {
  return bytes.slice().buffer as ArrayBuffer;
}

async function localAttachmentContext(session: LedgerCryptoSession) {
  return deriveAttachmentCryptoContext(session, {
    serverId: 'local-device-storage',
    ledgerId: session.ledgerId,
    username: session.keyringId,
  });
}

export async function encryptDeviceAttachmentBlob(
  session: LedgerCryptoSession,
  plaintextSha256: string,
  blob: Blob,
): Promise<Blob> {
  if (!/^[a-f0-9]{64}$/.test(plaintextSha256)) throw new Error('附件 SHA-256 无效');
  const context = await localAttachmentContext(session);
  const chunkCount = Math.max(1, Math.ceil(blob.size / ATTACHMENT_CHUNK_BYTES));
  const chunks: AttachmentChunkHeader[] = [];
  const ciphertexts: Uint8Array[] = [];
  for (let index = 0; index < chunkCount; index += 1) {
    const start = index * ATTACHMENT_CHUNK_BYTES;
    const plaintext = new Uint8Array(await blob.slice(start, Math.min(blob.size, start + ATTACHMENT_CHUNK_BYTES)).arrayBuffer());
    const encrypted = await encryptAttachmentChunk(context, plaintextSha256, plaintext, index, chunkCount, blob.size);
    chunks.push({
      index,
      iv: encrypted.iv,
      ciphertextSha256: encrypted.ciphertextSha256,
      ciphertextBytes: encrypted.ciphertext.byteLength,
    });
    ciphertexts.push(encrypted.ciphertext);
  }
  const header: EncryptedAttachmentHeader = {
    format: 'zichan-device-attachment',
    version: 1,
    storageId: session.ledgerId,
    keyringId: session.keyringId,
    plaintextSha256,
    sizeBytes: blob.size,
    mimeType: blob.type || 'application/octet-stream',
    chunks,
  };
  const headerBytes = new TextEncoder().encode(JSON.stringify(header));
  const parts: BlobPart[] = [
    blobPart(ATTACHMENT_MAGIC),
    blobPart(u32(headerBytes.byteLength)),
    blobPart(headerBytes),
  ];
  for (const ciphertext of ciphertexts) parts.push(blobPart(ciphertext));
  return new Blob(parts, { type: 'application/x-zichan-encrypted-attachment' });
}

export async function decryptDeviceAttachmentBlob(
  session: LedgerCryptoSession,
  expectedSha256: string,
  encryptedBlob: Blob,
  mimeType = 'application/octet-stream',
): Promise<Blob> {
  const bytes = new Uint8Array(await encryptedBlob.arrayBuffer());
  if (bytes.length < ATTACHMENT_MAGIC.length + 4
    || !ATTACHMENT_MAGIC.every((byte, index) => bytes[index] === byte)) {
    throw new Error('发现未加密的旧版附件，请重置开发数据后重新导入');
  }
  const headerLength = readU32(bytes, ATTACHMENT_MAGIC.length);
  const headerStart = ATTACHMENT_MAGIC.length + 4;
  const headerEnd = headerStart + headerLength;
  if (headerEnd > bytes.length) throw new Error('加密附件头已截断');
  const header = JSON.parse(new TextDecoder().decode(bytes.subarray(headerStart, headerEnd))) as Partial<EncryptedAttachmentHeader>;
  if (header.format !== 'zichan-device-attachment' || header.version !== 1
    || header.storageId !== session.ledgerId || header.keyringId !== session.keyringId
    || header.plaintextSha256 !== expectedSha256 || !Number.isSafeInteger(header.sizeBytes)
    || !Array.isArray(header.chunks) || header.chunks.length < 1) {
    throw new Error('加密附件头无效或不属于当前设备密钥');
  }
  const sizeBytes = Number(header.sizeBytes);
  const context = await localAttachmentContext(session);
  const plaintextParts: Uint8Array[] = [];
  let offset = headerEnd;
  for (const [position, chunk] of header.chunks.entries()) {
    if (chunk.index !== position || !Number.isSafeInteger(chunk.ciphertextBytes) || chunk.ciphertextBytes < 16) {
      throw new Error('加密附件分块索引无效');
    }
    const end = offset + chunk.ciphertextBytes;
    if (end > bytes.length) throw new Error('加密附件分块已截断');
    plaintextParts.push(await decryptAttachmentChunk(
      context,
      expectedSha256,
      {
        index: chunk.index,
        iv: chunk.iv,
        ciphertextSha256: chunk.ciphertextSha256,
        ciphertext: bytes.slice(offset, end),
      },
      header.chunks.length,
      sizeBytes,
    ));
    offset = end;
  }
  if (offset !== bytes.length) throw new Error('加密附件尾部存在多余数据');
  const plaintext = new Blob(plaintextParts.map(blobPart), { type: mimeType || header.mimeType });
  if (plaintext.size !== sizeBytes) throw new Error('加密附件解密后的大小不一致');
  return plaintext;
}
