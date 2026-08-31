import { isTauriRuntime } from './tauri.js';

export type FirstUseMode = 'local' | 'server';

export const FIRST_USE_MODE_KEY = 'zichan.firstUse.mode.v1';

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
}

export function loadFirstUseMode(): FirstUseMode | null {
  try {
    const value = globalThis.localStorage?.getItem(FIRST_USE_MODE_KEY);
    return value === 'local' || value === 'server' ? value : null;
  } catch {
    return null;
  }
}

export function saveFirstUseMode(mode: FirstUseMode): void {
  globalThis.localStorage?.setItem(FIRST_USE_MODE_KEY, mode);
}

export function clearFirstUseMode(): void {
  globalThis.localStorage?.removeItem(FIRST_USE_MODE_KEY);
}

export function browserLocalCapability(): BrowserLocalCapability {
  if (isTauriRuntime()) return { supported: true, missing: [] };
  const missing: string[] = [];
  if (typeof globalThis.indexedDB?.open !== 'function') missing.push('IndexedDB');
  if (!globalThis.crypto?.subtle) missing.push('WebCrypto');
  if (typeof globalThis.WebAssembly?.compile !== 'function') missing.push('WebAssembly');
  if (typeof globalThis.navigator?.locks?.request !== 'function') missing.push('Web Locks');
  const storage = globalThis.navigator?.storage;
  if (typeof storage?.persist !== 'function' || typeof storage.persisted !== 'function') missing.push('持久存储授权');
  return { supported: missing.length === 0, missing };
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
  if (input.persisted) return 'writable';
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
    const already = await storage.persisted();
    if (already) return { supported: true, persisted: true };
    if (!request) return { supported: true, persisted: false, reason: '浏览器尚未授予持久存储权限' };
    const granted = await storage.persist();
    if (!granted) return { supported: true, persisted: false, reason: '浏览器拒绝了持久存储授权' };
    const persisted = await storage.persisted();
    return persisted
      ? { supported: true, persisted: true }
      : { supported: true, persisted: false, reason: '浏览器没有确认持久存储授权，不能创建纯本地账本' };
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
