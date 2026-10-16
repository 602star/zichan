import { isTauriRuntime, tauriInvoke } from './tauri.js';

export interface DesktopStorageStatus {
  mode: 'portable' | 'installed';
  formatVersion: 1;
  rootDirectory: string;
  dataDirectory: string;
  filesystem: 'NTFS' | 'exFAT';
  webviewRuntime: 'fixed' | 'system-evergreen' | 'system-evergreen-fallback';
  serverBind: '0.0.0.0';
}

export async function readDesktopStorageStatus(): Promise<DesktopStorageStatus | null> {
  if (!isTauriRuntime()) return null;
  const request = tauriInvoke<DesktopStorageStatus | { mode: 'platform' }>('desktop_storage_status');
  if (!request) throw new Error('桌面存储状态命令不可用');
  const status = await request;
  return status.mode === 'portable' || status.mode === 'installed' ? status : null;
}
