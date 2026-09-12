import { accountLocalStorage } from './account-storage.js';
import { isTauriRuntime } from './tauri.js';

export type FirstUseMode = 'local' | 'server';

export const FIRST_USE_MODE_KEY = 'zichan.firstUse.mode.v1';
const BEST_EFFORT_KEY = 'zichan.storage.bestEffortConsent.v1';

export function loadBestEffortConsent(): boolean {
  try { return accountLocalStorage?.getItem(BEST_EFFORT_KEY) === 'accepted'; } catch { return false; }
}

export function acceptBestEffortStorage(): void {
  accountLocalStorage.setItem(BEST_EFFORT_KEY, 'accepted');
}

export interface BrowserLocalCapability {
  supported: boolean;
  missing: string[];
}

export interface BrowserPersistenceResult {
  supported: boolean;
  persisted: boolean;
  reason?: string;
}

export type BrowserStorageDisposition = 'pending' | 'writable' | 'blocked' | 'recovery';

export interface BrowserStorageDispositionInput {
  mode: FirstUseMode | null;
  persistenceChecked: boolean;
  persisted: boolean;
  hasExistingLocalData: boolean;
  desktop?: boolean;
  bestEffortAccepted?: boolean;
  localSupported?: boolean;
}

export function loadFirstUseMode(): FirstUseMode | null {
  try {
    const value = accountLocalStorage?.getItem(FIRST_USE_MODE_KEY);
    return value === 'local' || value === 'server' ? value : null;
  } catch {
    return null;
  }
}

export function saveFirstUseMode(mode: FirstUseMode): void {
  accountLocalStorage?.setItem(FIRST_USE_MODE_KEY, mode);
}

export function clearFirstUseMode(): void {
  accountLocalStorage?.removeItem(FIRST_USE_MODE_KEY);
  accountLocalStorage?.removeItem(BEST_EFFORT_KEY);
}

export function browserLocalCapability(): BrowserLocalCapability {
  if (isTauriRuntime()) return { supported: true, missing: [] };
  const missing: string[] = [];
  if (typeof globalThis.indexedDB?.open !== 'function') missing.push('IndexedDB');
  // WebAssembly powers the Argon2id key derivation, which has no fallback.
  if (typeof globalThis.WebAssembly?.compile !== 'function') missing.push('WebAssembly');
  // WebCrypto and Web Locks stay optional: AES-GCM, SHA-256 and HMAC fall back to
  // the bundled library, and the ledger lease falls back to IndexedDB. A plain-HTTP
  // LAN origin without secure-context APIs therefore stays fully usable.
  return { supported: missing.length === 0, missing };
}

/**
 * Argon2id runs through WebAssembly and has no JavaScript fallback, so it is the
 * one primitive that can genuinely prevent unlocking a ledger.
 */
export function cryptoContextProblem(): string | undefined {
  if (isTauriRuntime()) return undefined;
  const wasm = globalThis.WebAssembly;
  if (typeof wasm?.instantiate === 'function' || typeof wasm?.compile === 'function') return undefined;
  return '当前浏览器不支持 WebAssembly，无法执行 Argon2id 密钥派生，因而无法解锁账本。请升级浏览器或使用桌面版。';
}

/**
 * Decide whether opening the local database is allowed. Server mode deliberately
 * remains writable even when the browser only offers an evictable local cache.
 */
export function browserStorageDisposition(input: BrowserStorageDispositionInput): BrowserStorageDisposition {
  if (input.desktop) return input.mode ? 'writable' : 'pending';
  if (!input.mode) return 'pending';
  if (input.mode === 'server') return 'writable';
  if (!input.persistenceChecked) return 'pending';
  if (input.localSupported === false) return 'blocked';
  if (input.persisted || input.bestEffortAccepted) return 'writable';
  return input.hasExistingLocalData ? 'recovery' : 'blocked';
}

export async function browserPersistenceStatus(request = false): Promise<BrowserPersistenceResult> {
  if (isTauriRuntime()) return { supported: true, persisted: true };
  const capability = browserLocalCapability();
  if (!capability.supported) {
    return {
      supported: false,
      persisted: false,
      reason: `当前浏览器缺少：${capability.missing.join('、')}`,
    };
  }
  try {
    const storage = globalThis.navigator.storage;
    if (typeof storage?.persist !== 'function' || typeof storage.persisted !== 'function') {
      return { supported: true, persisted: false, reason: '浏览器未提供持久存储保护接口；仍可选择普通本地存储' };
    }
    const already = await storage.persisted();
    if (already) return { supported: true, persisted: true };
    if (!request) return { supported: true, persisted: false, reason: '浏览器尚未授予持久存储权限' };
    const granted = await storage.persist();
    if (!granted) return { supported: true, persisted: false, reason: '浏览器未授予防自动清理保护（不代表你拒绝了授权）' };
    const persisted = await storage.persisted();
    return persisted
      ? { supported: true, persisted: true }
      : { supported: true, persisted: false, reason: '浏览器没有确认持久存储保护；可确认风险后使用普通本地存储' };
  } catch (error) {
    return {
      supported: true,
      persisted: false,
      reason: `检查持久存储失败：${error instanceof Error ? error.message : String(error)}`,
    };
  }
}

/** Local mode requests persistence; server mode only observes cache durability. */
export function prepareBrowserStorageForMode(mode: FirstUseMode): Promise<BrowserPersistenceResult> {
  return browserPersistenceStatus(mode === 'local');
}
