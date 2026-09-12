/**
 * Unified AEAD / digest primitives for the whole ledger stack.
 *
 * `crypto.subtle` is only exposed in a browser *secure context* (HTTPS, localhost).
 * A LAN deployment reached over plain HTTP therefore has `crypto.subtle ===
 * undefined`, which used to make local decryption impossible. The same AES-GCM,
 * SHA-256 and HMAC-SHA256 primitives are available from pure-JavaScript
 * implementations, so we select a backend at call time instead of failing.
 *
 * The backend is picked per call, never cached across a context change, and the
 * fallback library is imported lazily so HTTPS deployments and Node both keep the
 * native implementation without paying for the bundle.
 *
 * Wire compatibility is exact: AES-GCM with a 16-byte tag, SHA-256, and
 * HMAC-SHA256 are byte-for-byte identical in both backends, so existing ledgers,
 * attachments and backups stay readable in either direction.
 */

interface SubtleLike {
  importKey(fmt: string, key: Uint8Array, algo: unknown, ext: boolean, usages: string[]): Promise<unknown>;
  encrypt(algo: unknown, key: unknown, data: Uint8Array): Promise<ArrayBuffer>;
  decrypt(algo: unknown, key: unknown, data: Uint8Array): Promise<ArrayBuffer>;
  digest(algo: string, data: Uint8Array): Promise<ArrayBuffer>;
  sign(algo: unknown, key: unknown, data: Uint8Array): Promise<ArrayBuffer>;
}

interface CryptoLike {
  subtle?: SubtleLike;
  getRandomValues?<T extends Uint8Array>(target: T): T;
}

interface Fallback {
  gcm(key: Uint8Array, nonce: Uint8Array, aad: Uint8Array): {
    encrypt(plaintext: Uint8Array): Uint8Array;
    decrypt(ciphertext: Uint8Array): Uint8Array;
  };
  sha256(data: Uint8Array): Uint8Array;
  hmac(key: Uint8Array, data: Uint8Array): Uint8Array;
}

const webcrypto = (globalThis as unknown as { crypto?: CryptoLike }).crypto;

let fallbackFlight: Promise<Fallback> | undefined;

/** The pure-JavaScript backend, loaded only when the platform withholds `subtle`. */
function fallback(): Promise<Fallback> {
  fallbackFlight ??= Promise.all([
    import('@noble/ciphers/aes.js'),
    import('@noble/hashes/sha2.js'),
    import('@noble/hashes/hmac.js'),
  ]).then(([aes, sha2, hmacModule]) => ({
    gcm: (key: Uint8Array, nonce: Uint8Array, aad: Uint8Array) => aes.gcm(key, nonce, aad),
    sha256: (data: Uint8Array) => sha2.sha256(data),
    hmac: (key: Uint8Array, data: Uint8Array) => hmacModule.hmac(sha2.sha256, key, data),
  }));
  return fallbackFlight;
}

/** True when the platform exposes the native SubtleCrypto backend. */
export function hasNativeSubtle(): boolean {
  return typeof webcrypto?.subtle?.decrypt === 'function';
}

/**
 * `getRandomValues` is deliberately not gated on a secure context, so identifiers
 * and IVs keep working over plain HTTP. It is never silently emulated.
 */
export function randomBytes(length: number): Uint8Array {
  const target = new Uint8Array(length);
  if (typeof webcrypto?.getRandomValues !== 'function') {
    throw new Error('当前环境不支持安全随机数，无法初始化加密账本。请使用现代浏览器或桌面版。');
  }
  return webcrypto.getRandomValues(target);
}

export async function sha256Bytes(value: Uint8Array): Promise<Uint8Array> {
  if (hasNativeSubtle()) {
    return new Uint8Array(await webcrypto!.subtle!.digest('SHA-256', value));
  }
  return (await fallback()).sha256(value);
}

export async function hmacSha256(key: Uint8Array, value: Uint8Array): Promise<Uint8Array> {
  if (hasNativeSubtle()) {
    const imported = await webcrypto!.subtle!.importKey('raw', key, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
    return new Uint8Array(await webcrypto!.subtle!.sign('HMAC', imported, value));
  }
  return (await fallback()).hmac(key, value);
}

/**
 * AES-GCM is authenticated in both backends with a 16-byte tag, so a ciphertext
 * written by either side decrypts on the other. A missing AAD is normalised to an
 * empty AAD, which GCM treats identically.
 */
export async function aesGcmEncrypt(key: Uint8Array, iv: Uint8Array, plaintext: Uint8Array, aad?: Uint8Array): Promise<Uint8Array> {
  if (hasNativeSubtle()) {
    const imported = await webcrypto!.subtle!.importKey('raw', key, { name: 'AES-GCM' }, false, ['encrypt']);
    return new Uint8Array(await webcrypto!.subtle!.encrypt({ name: 'AES-GCM', iv, additionalData: aad }, imported, plaintext));
  }
  return (await fallback()).gcm(key, iv, aad ?? new Uint8Array(0)).encrypt(plaintext);
}

export async function aesGcmDecrypt(key: Uint8Array, iv: Uint8Array, ciphertext: Uint8Array, aad?: Uint8Array): Promise<Uint8Array> {
  if (hasNativeSubtle()) {
    const imported = await webcrypto!.subtle!.importKey('raw', key, { name: 'AES-GCM' }, false, ['decrypt']);
    return new Uint8Array(await webcrypto!.subtle!.decrypt({ name: 'AES-GCM', iv, additionalData: aad }, imported, ciphertext));
  }
  return (await fallback()).gcm(key, iv, aad ?? new Uint8Array(0)).decrypt(ciphertext);
}
