/** End-to-end encryption primitives shared by sync, attachments and backups. */

import { aesGcmDecrypt, aesGcmEncrypt, hmacSha256, randomBytes, sha256Bytes as digestSha256 } from './crypto-provider.js';
import { sha256 } from '@noble/hashes/sha2.js';

declare const TextEncoder: { new (): { encode(s: string): Uint8Array } };
declare const TextDecoder: { new (): { decode(b: ArrayBuffer | Uint8Array): string } };
declare const btoa: (s: string) => string;
declare const atob: (s: string) => string;

const te = new TextEncoder();
const td = new TextDecoder();
const ARGON_MEMORY_KIB = 32 * 1024;
const ARGON_ITERATIONS = 3;
const ARGON_PARALLELISM = 1;

/** Per-payload envelope. The key is selected from an unlocked ledger keyring. */
export interface Encrypted {
  v: 3;
  keyId: string;
  iv: string;
  ct: string;
}

/** Password-wrapped keyring. Safe to persist locally or on an untrusted relay. */
export interface LedgerKeyEnvelope {
  v: 1;
  kdf: 'argon2id';
  ledgerId: string;
  keyringId: string;
  generation: number;
  salt: string;
  memoryKiB: number;
  iterations: number;
  parallelism: number;
  iv: string;
  ct: string;
}

export interface LedgerCryptoSession {
  readonly retiredAttachmentSecrets?: readonly Uint8Array[];
  readonly retiredBackupSecrets?: readonly Uint8Array[];
  readonly v: 1;
  readonly ledgerId: string;
  readonly keyringId: string;
  readonly generation: number;
  readonly activeKeyId: string;
  readonly dataKeys: ReadonlyMap<string, Uint8Array>;
  readonly attachmentSecret: Uint8Array;
  readonly backupSecret: Uint8Array;
}

interface SerializedKeyring {
  retiredAttachmentSecrets?: string[];
  retiredBackupSecrets?: string[];
  v: 1;
  ledgerId: string;
  keyringId: string;
  generation: number;
  activeKeyId: string;
  dataKeys: { id: string; key: string; createdAt: string; retiredAt?: string }[];
  attachmentSecret: string;
  backupSecret: string;
}

export type AttachmentCryptoRoutingContext = {
  serverId: string;
  ledgerId: string;
  username: string;
} | {
  /** Portable across replicas of one ledger. */
  v: 2;
  ledgerId: string;
};

export interface AttachmentCryptoContext {
  routing: AttachmentCryptoRoutingContext;
  /** Raw HMAC key bytes; the AEAD backend is selected per call. */
  idKey: Uint8Array;
}

export interface EncryptedAttachmentChunk {
  index: number;
  iv: string;
  ciphertext: Uint8Array;
  ciphertextSha256: string;
}

export interface EncryptedBinary {
  v: 1;
  iv: string;
  ct: string;
}

export interface EncryptedBackupChunk {
  v: 1;
  iv: Uint8Array;
  ciphertext: Uint8Array;
}

function b64(bytes: Uint8Array): string {
  let value = '';
  for (const byte of bytes) value += String.fromCharCode(byte);
  return btoa(value);
}

function unb64(value: string): Uint8Array {
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return bytes;
}

function hex(bytes: Uint8Array): string {
  return [...bytes].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

function randomId(prefix: string): string {
  return `${prefix}-${hex(randomBytes(16))}`;
}

function canonicalValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalValue);
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
      const item = (value as Record<string, unknown>)[key];
      if (item !== undefined) out[key] = canonicalValue(item);
    }
    return out;
  }
  return value;
}

export function canonicalJson(value: unknown): string {
  return JSON.stringify(canonicalValue(value));
}

export async function sha256Json(value: unknown): Promise<string> {
  return hex(await digestSha256(te.encode(canonicalJson(value))));
}

export async function sha256Bytes(value: Uint8Array): Promise<string> {
  return hex(await digestSha256(value));
}

/** Digest a sorted set of opaque V2 blob IDs without buffering the whole catalog. */
export function attachmentPromiseDigest(blobIds: Iterable<string>): string {
  const hash = sha256.create();
  let previous = '';
  for (const blobId of blobIds) {
    if (!/^[a-f0-9]{64}$/.test(blobId) || blobId <= previous) {
      throw new Error('附件承诺目录必须包含严格递增的新版对象 ID');
    }
    hash.update(te.encode(`${blobId}\n`));
    previous = blobId;
  }
  return hex(hash.digest());
}

async function wrappingKey(passphrase: string, envelope: Pick<LedgerKeyEnvelope, 'salt' | 'memoryKiB' | 'iterations' | 'parallelism'>): Promise<Uint8Array> {
  if (passphrase.length < 8) throw new Error('账本加密密码至少需要 8 个字符');
  const { argon2id } = await import('hash-wasm');
  const derived = await argon2id({
    password: passphrase,
    salt: unb64(envelope.salt),
    memorySize: envelope.memoryKiB,
    iterations: envelope.iterations,
    parallelism: envelope.parallelism,
    hashLength: 32,
    outputType: 'binary',
  });
  return derived;
}

function envelopeAad(envelope: Omit<LedgerKeyEnvelope, 'iv' | 'ct'>): Uint8Array {
  return te.encode(canonicalJson(envelope));
}

function assertLedgerKeyEnvelope(envelope: LedgerKeyEnvelope): void {
  if (envelope.v !== 1 || envelope.kdf !== 'argon2id') throw new Error('不支持的账本密钥包版本');
  if (!/^[A-Za-z0-9_-]{16,128}$/.test(envelope.ledgerId)
    || !/^[A-Za-z0-9_-]{16,128}$/.test(envelope.keyringId)
    || !Number.isSafeInteger(envelope.generation) || envelope.generation < 1) {
    throw new Error('账本密钥包身份无效');
  }
  if (!Number.isSafeInteger(envelope.memoryKiB) || envelope.memoryKiB < 8 * 1024 || envelope.memoryKiB > 64 * 1024
    || !Number.isSafeInteger(envelope.iterations) || envelope.iterations < 1 || envelope.iterations > 6
    || !Number.isSafeInteger(envelope.parallelism) || envelope.parallelism < 1 || envelope.parallelism > 4) {
    throw new Error('账本密钥包的 Argon2id 参数超出安全范围');
  }
  let salt: Uint8Array;
  let iv: Uint8Array;
  let ciphertext: Uint8Array;
  try {
    salt = unb64(envelope.salt);
    iv = unb64(envelope.iv);
    ciphertext = unb64(envelope.ct);
  } catch {
    throw new Error('账本密钥包编码无效');
  }
  if (salt.length < 16 || salt.length > 64 || iv.length !== 12 || ciphertext.length < 17 || ciphertext.length > 1024 * 1024) {
    throw new Error('账本密钥包长度无效');
  }
}

function serializeSession(session: LedgerCryptoSession): SerializedKeyring {
  const now = new Date().toISOString();
  return {
    ...(session.retiredAttachmentSecrets?.length ? { retiredAttachmentSecrets: session.retiredAttachmentSecrets.map(b64) } : {}),
    ...(session.retiredBackupSecrets?.length ? { retiredBackupSecrets: session.retiredBackupSecrets.map(b64) } : {}),
    v: 1,
    ledgerId: session.ledgerId,
    keyringId: session.keyringId,
    generation: session.generation,
    activeKeyId: session.activeKeyId,
    dataKeys: [...session.dataKeys].map(([id, key]) => ({ id, key: b64(key), createdAt: now, ...(id === session.activeKeyId ? {} : { retiredAt: now }) })),
    attachmentSecret: b64(session.attachmentSecret),
    backupSecret: b64(session.backupSecret),
  };
}

function deserializeSession(payload: SerializedKeyring): LedgerCryptoSession {
  if (payload.v !== 1 || !payload.ledgerId || !payload.keyringId || !payload.activeKeyId || !payload.dataKeys.length) throw new Error('账本密钥包内容无效');
  const dataKeys = new Map(payload.dataKeys.map((row) => [row.id, unb64(row.key)]));
  if (!dataKeys.has(payload.activeKeyId)) throw new Error('账本密钥包缺少活动密钥');
  return {
    ...(payload.retiredAttachmentSecrets ? { retiredAttachmentSecrets: payload.retiredAttachmentSecrets.map(unb64) } : {}),
    ...(payload.retiredBackupSecrets ? { retiredBackupSecrets: payload.retiredBackupSecrets.map(unb64) } : {}),
    v: 1,
    ledgerId: payload.ledgerId,
    keyringId: payload.keyringId,
    generation: payload.generation,
    activeKeyId: payload.activeKeyId,
    dataKeys,
    attachmentSecret: unb64(payload.attachmentSecret),
    backupSecret: unb64(payload.backupSecret),
  };
}

export function createLedgerCryptoSession(ledgerId: string): LedgerCryptoSession {
  if (!/^[A-Za-z0-9_-]{16,128}$/.test(ledgerId)) throw new Error('账本 ID 无效');
  const activeKeyId = randomId('key');
  return {
    v: 1,
    ledgerId,
    keyringId: randomId('keyring'),
    generation: 1,
    activeKeyId,
    dataKeys: new Map([[activeKeyId, randomBytes(32)]]),
    attachmentSecret: randomBytes(32),
    backupSecret: randomBytes(32),
  };
}

export async function wrapLedgerCryptoSession(session: LedgerCryptoSession, passphrase: string): Promise<LedgerKeyEnvelope> {
  const header = {
    v: 1 as const,
    kdf: 'argon2id' as const,
    ledgerId: session.ledgerId,
    keyringId: session.keyringId,
    generation: session.generation,
    salt: b64(randomBytes(16)),
    memoryKiB: ARGON_MEMORY_KIB,
    iterations: ARGON_ITERATIONS,
    parallelism: ARGON_PARALLELISM,
  };
  const iv = randomBytes(12);
  const ciphertext = await aesGcmEncrypt(
    await wrappingKey(passphrase, header),
    iv,
    te.encode(canonicalJson(serializeSession(session))),
    envelopeAad(header),
  );
  return { ...header, iv: b64(iv), ct: b64(ciphertext) };
}

export async function createLedgerKeyEnvelope(ledgerId: string, passphrase: string): Promise<{ envelope: LedgerKeyEnvelope; session: LedgerCryptoSession }> {
  const session = createLedgerCryptoSession(ledgerId);
  return { session, envelope: await wrapLedgerCryptoSession(session, passphrase) };
}

export async function unlockLedgerKeyEnvelope(passphrase: string, envelope: LedgerKeyEnvelope): Promise<LedgerCryptoSession> {
  assertLedgerKeyEnvelope(envelope);
  const { iv, ct, ...header } = envelope;
  const plaintext = await aesGcmDecrypt(
    await wrappingKey(passphrase, envelope),
    unb64(iv),
    unb64(ct),
    envelopeAad(header),
  );
  const session = deserializeSession(JSON.parse(td.decode(plaintext)) as SerializedKeyring);
  if (session.ledgerId !== envelope.ledgerId || session.keyringId !== envelope.keyringId || session.generation !== envelope.generation) {
    throw new Error('账本密钥包元数据校验失败');
  }
  return session;
}

export async function changeLedgerPassphrase(session: LedgerCryptoSession, newPassphrase: string): Promise<{ envelope: LedgerKeyEnvelope; session: LedgerCryptoSession }> {
  const next: LedgerCryptoSession = {
    ...session,
    generation: session.generation + 1,
    dataKeys: new Map(session.dataKeys),
  };
  return { session: next, envelope: await wrapLedgerCryptoSession(next, newPassphrase) };
}

export async function rotateLedgerDataKey(session: LedgerCryptoSession, passphrase: string): Promise<{ envelope: LedgerKeyEnvelope; session: LedgerCryptoSession }> {
  const activeKeyId = randomId('key');
  const next: LedgerCryptoSession = {
    ...session,
    generation: session.generation + 1,
    activeKeyId,
    dataKeys: new Map([...session.dataKeys, [activeKeyId, randomBytes(32)]]),
  };
  return { session: next, envelope: await wrapLedgerCryptoSession(next, passphrase) };
}

/** Revoke a custodian's future access while retaining read access to past data. */
export async function rotateLedgerProtection(session: LedgerCryptoSession, passphrase: string): Promise<{ envelope: LedgerKeyEnvelope; session: LedgerCryptoSession }> {
  const fresh = createLedgerCryptoSession(session.ledgerId);
  const next: LedgerCryptoSession = {
    ...session, generation: session.generation + 1,
    activeKeyId: fresh.activeKeyId, dataKeys: new Map([...session.dataKeys, ...fresh.dataKeys]),
    attachmentSecret: fresh.attachmentSecret, backupSecret: fresh.backupSecret,
    retiredAttachmentSecrets: [...(session.retiredAttachmentSecrets ?? []), session.attachmentSecret],
    retiredBackupSecrets: [...(session.retiredBackupSecrets ?? []), session.backupSecret],
  };
  return { session: next, envelope: await wrapLedgerCryptoSession(next, passphrase) };
}

/** Encrypt JSON with the current data key and authenticate public routing metadata. */
export async function encryptJson(session: LedgerCryptoSession, data: unknown, context: unknown): Promise<Encrypted> {
  const raw = session.dataKeys.get(session.activeKeyId);
  if (!raw) throw new Error('活动账本密钥不可用');
  const iv = randomBytes(12);
  const ct = await aesGcmEncrypt(raw, iv, te.encode(canonicalJson(data)), te.encode(canonicalJson(context)));
  return { v: 3, keyId: session.activeKeyId, iv: b64(iv), ct: b64(ct) };
}

export async function decryptJson<T = unknown>(session: LedgerCryptoSession, encrypted: Encrypted, context: unknown): Promise<T> {
  if (encrypted.v !== 3) throw new Error('不支持的加密内容版本');
  const raw = session.dataKeys.get(encrypted.keyId);
  if (!raw) throw new Error(`账本密钥包缺少数据密钥 ${encrypted.keyId}`);
  const plaintext = await aesGcmDecrypt(raw, unb64(encrypted.iv), unb64(encrypted.ct), te.encode(canonicalJson(context)));
  return JSON.parse(td.decode(plaintext)) as T;
}

export function normalizeSyncUsername(username: string): string {
  return username.trim().normalize('NFKC').toLowerCase();
}

export async function deriveAttachmentCryptoContext(
  session: LedgerCryptoSession,
  routing: AttachmentCryptoRoutingContext,
): Promise<AttachmentCryptoContext> {
  if (routing.ledgerId !== session.ledgerId) throw new Error('附件所属账本与已解锁密钥不一致');
  const scoped = await hmacSha256(session.attachmentSecret, te.encode(canonicalJson('serverId' in routing
    ? { v: 2, ...routing } : { v: 3, ledgerId: routing.ledgerId })));
  return { routing: { ...routing }, idKey: scoped };
}

async function attachmentHmac(context: AttachmentCryptoContext, value: string): Promise<Uint8Array> {
  return hmacSha256(context.idKey, te.encode(value));
}

export async function attachmentRemoteBlobId(context: AttachmentCryptoContext, plaintextSha256: string): Promise<string> {
  if (!/^[a-f0-9]{64}$/.test(plaintextSha256)) throw new Error('attachment content hash is invalid');
  return hex(await attachmentHmac(context, `zichan-blob-id-v2::${plaintextSha256}`));
}

function attachmentContentKey(context: AttachmentCryptoContext, plaintextSha256: string): Promise<Uint8Array> {
  return attachmentHmac(context, `zichan-blob-key-v2::${plaintextSha256}`);
}

async function attachmentChunkIv(context: AttachmentCryptoContext, plaintextSha256: string, index: number): Promise<Uint8Array> {
  return (await attachmentHmac(context, `zichan-blob-iv-v2::${plaintextSha256}::${index}`)).slice(0, 12);
}

function attachmentChunkAad(
  context: AttachmentCryptoContext,
  plaintextSha256: string,
  index: number,
  chunkCount: number,
  totalSizeBytes: number,
): Uint8Array {
  return te.encode(canonicalJson('serverId' in context.routing
    ? { v: 2, ...context.routing, plaintextSha256, index, chunkCount, totalSizeBytes }
    : { v: 3, ledgerId: context.routing.ledgerId, plaintextSha256, index, chunkCount, totalSizeBytes }));
}

export async function encryptAttachmentChunk(
  context: AttachmentCryptoContext,
  plaintextSha256: string,
  plaintext: Uint8Array,
  index: number,
  chunkCount: number,
  totalSizeBytes: number,
): Promise<EncryptedAttachmentChunk> {
  if (!Number.isSafeInteger(index) || index < 0 || !Number.isSafeInteger(chunkCount) || chunkCount < 1 || index >= chunkCount) {
    throw new Error('attachment chunk index is invalid');
  }
  const iv = await attachmentChunkIv(context, plaintextSha256, index);
  const ciphertext = await aesGcmEncrypt(
    await attachmentContentKey(context, plaintextSha256),
    iv,
    plaintext,
    attachmentChunkAad(context, plaintextSha256, index, chunkCount, totalSizeBytes),
  );
  return { index, iv: b64(iv), ciphertext, ciphertextSha256: await sha256Bytes(ciphertext) };
}

export async function decryptAttachmentChunk(
  context: AttachmentCryptoContext,
  plaintextSha256: string,
  encrypted: Pick<EncryptedAttachmentChunk, 'index' | 'iv' | 'ciphertext' | 'ciphertextSha256'>,
  chunkCount: number,
  totalSizeBytes: number,
): Promise<Uint8Array> {
  if (await sha256Bytes(encrypted.ciphertext) !== encrypted.ciphertextSha256) throw new Error('encrypted attachment chunk checksum mismatch');
  return aesGcmDecrypt(
    await attachmentContentKey(context, plaintextSha256),
    unb64(encrypted.iv),
    encrypted.ciphertext,
    attachmentChunkAad(context, plaintextSha256, encrypted.index, chunkCount, totalSizeBytes),
  );
}

export async function encryptBackupBytes(session: LedgerCryptoSession, plaintext: Uint8Array, context: unknown): Promise<EncryptedBinary> {
  const iv = randomBytes(12);
  const ciphertext = await aesGcmEncrypt(session.backupSecret, iv, plaintext, te.encode(canonicalJson(context)));
  return { v: 1, iv: b64(iv), ct: b64(ciphertext) };
}

export async function decryptBackupBytes(session: LedgerCryptoSession, encrypted: EncryptedBinary, context: unknown): Promise<Uint8Array> {
  if (encrypted.v !== 1) throw new Error('不支持的备份加密版本');
  return decryptWithBackupHistory(session, unb64(encrypted.iv), unb64(encrypted.ct), context);
}

async function decryptWithBackupHistory(session: LedgerCryptoSession, iv: Uint8Array, ciphertext: Uint8Array, context: unknown): Promise<Uint8Array> {
  for (const secret of [session.backupSecret, ...(session.retiredBackupSecrets ?? [])]) {
    try { return await aesGcmDecrypt(secret, iv, ciphertext, te.encode(canonicalJson(context))); }
    catch { /* Try a retired backup key; authentication is still mandatory. */ }
  }
  throw new Error('备份密钥不匹配或备份已损坏');
}

/** Raw binary variant used by the framed backup archive. */
export async function encryptBackupChunk(
  session: LedgerCryptoSession,
  plaintext: Uint8Array,
  context: unknown,
): Promise<EncryptedBackupChunk> {
  const iv = randomBytes(12);
  const ciphertext = await aesGcmEncrypt(session.backupSecret, iv, plaintext, te.encode(canonicalJson(context)));
  return { v: 1, iv, ciphertext };
}

export async function decryptBackupChunk(
  session: LedgerCryptoSession,
  encrypted: EncryptedBackupChunk,
  context: unknown,
): Promise<Uint8Array> {
  if (encrypted.v !== 1 || encrypted.iv.length !== 12 || encrypted.ciphertext.length < 16) {
    throw new Error('不支持或损坏的备份分块');
  }
  return decryptWithBackupHistory(session, encrypted.iv, encrypted.ciphertext, context);
}
