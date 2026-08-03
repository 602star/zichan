type InvokeFn = <T>(command: string, args?: Record<string, unknown>) => Promise<T>;

interface TauriGlobal {
  core?: { invoke?: InvokeFn };
  invoke?: InvokeFn;
}

interface TauriInternals {
  invoke?: InvokeFn;
}

declare global {
  interface Window {
    __TAURI__?: TauriGlobal;
    __TAURI_INTERNALS__?: TauriInternals;
  }
}

export function tauriInvoke<T>(command: string, args?: Record<string, unknown>): Promise<T> | null {
  if (typeof window === 'undefined') return null;
  const invoke = window.__TAURI__?.core?.invoke ?? window.__TAURI__?.invoke ?? window.__TAURI_INTERNALS__?.invoke;
  return invoke ? invoke<T>(command, args) : null;
}

export function isTauriRuntime(): boolean {
  if (typeof window === 'undefined') return false;
  return !!(window.__TAURI__?.core?.invoke ?? window.__TAURI__?.invoke ?? window.__TAURI_INTERNALS__?.invoke);
}
