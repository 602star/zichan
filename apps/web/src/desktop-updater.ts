import { isTauriRuntime, tauriInvoke } from './tauri.js';

export type DesktopUpdateChannel = 'stable' | 'preview' | 'rollback';
export type DesktopUpdatePhase =
  | 'idle'
  | 'checking'
  | 'available'
  | 'current'
  | 'installing'
  | 'awaiting_health'
  | 'healthy'
  | 'failed';

export interface DesktopUpdateStatus {
  supported: boolean;
  configured: boolean;
  currentVersion: string;
  channel: DesktopUpdateChannel;
  phase: DesktopUpdatePhase;
  availableVersion?: string;
  previousVersion?: string;
  notes?: string;
  publishedAt?: string;
  lastCheckedAt?: string;
  rollbackConfigured: boolean;
  message: string;
  error?: string;
}

async function invokeUpdate(command: string, args?: Record<string, unknown>): Promise<DesktopUpdateStatus | null> {
  if (!isTauriRuntime()) return null;
  const pending = tauriInvoke<DesktopUpdateStatus>(command, args);
  return pending ? pending : null;
}

export function desktopUpdateStatus(): Promise<DesktopUpdateStatus | null> {
  return invokeUpdate('desktop_update_status');
}

export function checkDesktopUpdate(channel: DesktopUpdateChannel): Promise<DesktopUpdateStatus | null> {
  return invokeUpdate('desktop_check_for_update', { channel });
}

export function installDesktopUpdate(channel: DesktopUpdateChannel): Promise<DesktopUpdateStatus | null> {
  return invokeUpdate('desktop_install_update', { channel });
}

export function confirmDesktopUpdateHealthy(): Promise<DesktopUpdateStatus | null> {
  return invokeUpdate('desktop_confirm_update_healthy');
}
