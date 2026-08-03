import { isTauriRuntime, tauriInvoke } from './tauri.js';

const DEVICE_PREFS_KEY = 'zichan.device.preferences.v1';
let lastBiometricAuthAt = 0;

export interface DevicePreferences {
  biometricLock: boolean;
  syncNotifications: boolean;
}

export interface BiometricStatus {
  isAvailable: boolean;
  biometryType: number;
  error?: string;
  errorCode?: string;
}

export interface DevicePosition {
  latitude: number;
  longitude: number;
  accuracy: number;
  timestamp: number;
}

export interface BarcodeScanResult {
  content: string;
  format: string;
}

export type MobileTauriPlatform = 'android' | 'ios' | null;

export function mobileTauriPlatform(): MobileTauriPlatform {
  if (!isTauriRuntime()) return null;
  if (/Android/i.test(navigator.userAgent)) return 'android';
  if (/iPhone|iPad|iPod/i.test(navigator.userAgent)) return 'ios';
  return null;
}

export function isMobileTauriRuntime(): boolean {
  return mobileTauriPlatform() !== null;
}

export function barcodeScannerAvailable(): boolean {
  return isMobileTauriRuntime();
}

function invokeRequired<T>(command: string, args?: Record<string, unknown>): Promise<T> {
  const request = tauriInvoke<T>(command, args);
  if (!request) return Promise.reject(new Error('当前设备不支持该原生能力'));
  return request;
}

export function readDevicePreferences(): DevicePreferences {
  try {
    const parsed = JSON.parse(localStorage.getItem(DEVICE_PREFS_KEY) ?? '{}') as Partial<DevicePreferences>;
    return { biometricLock: parsed.biometricLock === true, syncNotifications: parsed.syncNotifications === true };
  } catch {
    return { biometricLock: false, syncNotifications: false };
  }
}

export function writeDevicePreferences(patch: Partial<DevicePreferences>): DevicePreferences {
  const next = { ...readDevicePreferences(), ...patch };
  localStorage.setItem(DEVICE_PREFS_KEY, JSON.stringify(next));
  globalThis.dispatchEvent?.(new CustomEvent('zichan:device-preferences-changed'));
  return next;
}

export async function biometricStatus(): Promise<BiometricStatus> {
  if (!isTauriRuntime()) return { isAvailable: false, biometryType: 0, error: '浏览器不提供原生生物识别应用锁' };
  try {
    return await invokeRequired<BiometricStatus>('plugin:biometric|status');
  } catch (error) {
    return { isAvailable: false, biometryType: 0, error: error instanceof Error ? error.message : String(error) };
  }
}

export async function authenticateBiometric(reason = '解锁资产生命周期账本'): Promise<void> {
  await invokeRequired('plugin:biometric|authenticate', {
    reason,
    allowDeviceCredential: true,
    title: '解锁账本',
    subtitle: '验证后继续查看本机资产数据',
    confirmationRequired: true,
  });
  lastBiometricAuthAt = Date.now();
}

export function recentlyAuthenticatedBiometric(maxAgeMs = 10_000): boolean {
  return Date.now() - lastBiometricAuthAt <= maxAgeMs;
}

export async function scanBarcode(): Promise<BarcodeScanResult> {
  if (!barcodeScannerAvailable()) throw new Error('扫码功能需要 Android 或 iOS 原生应用');
  await invokeRequired('plugin:barcode-scanner|request_permissions');
  const formats = ['EAN_13', 'EAN_8', 'UPC_E', 'CODE_128', 'CODE_39', 'QR_CODE', 'DATA_MATRIX', 'PDF_417'];
  // The official iOS plugin cannot decode UPC_A as an option. iOS cameras
  // commonly expose UPC-A values through EAN-13 with a leading zero instead.
  if (mobileTauriPlatform() === 'android') formats.splice(2, 0, 'UPC_A');
  return invokeRequired<BarcodeScanResult>('plugin:barcode-scanner|scan', {
    cameraDirection: 'back',
    formats,
  });
}

export async function currentDevicePosition(): Promise<DevicePosition> {
  if (isTauriRuntime()) {
    try {
      await invokeRequired('plugin:geolocation|request_permissions', { permissions: ['location'] });
      const position = await invokeRequired<{ timestamp: number; coords: { latitude: number; longitude: number; accuracy: number } }>(
        'plugin:geolocation|get_current_position',
        { options: { enableHighAccuracy: true, timeout: 12_000, maximumAge: 60_000 } },
      );
      return { ...position.coords, timestamp: position.timestamp };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (isMobileTauriRuntime() || !('geolocation' in navigator)) throw new Error(message);
    }
  }
  if (!navigator.geolocation) throw new Error('当前设备不支持定位');
  return new Promise((resolve, reject) => navigator.geolocation.getCurrentPosition(
    (position) => resolve({
      latitude: position.coords.latitude,
      longitude: position.coords.longitude,
      accuracy: position.coords.accuracy,
      timestamp: position.timestamp,
    }),
    (error) => reject(new Error(error.message || '定位失败')),
    { enableHighAccuracy: true, timeout: 12_000, maximumAge: 60_000 },
  ));
}

export async function requestNotificationPermission(): Promise<NotificationPermission> {
  if (!('Notification' in window)) return 'denied';
  if (Notification.permission !== 'default') return Notification.permission;
  return Notification.requestPermission();
}

export async function sendDeviceNotification(title: string, body: string): Promise<boolean> {
  try {
    if (!('Notification' in window)) return false;
    const permission = await requestNotificationPermission();
    if (permission !== 'granted') return false;
    new Notification(title, { body });
    return true;
  } catch {
    return false;
  }
}

export async function shareJsonFile(contents: string, fileName: string, title = '资产生命周期账本备份'): Promise<boolean> {
  if (isMobileTauriRuntime()) {
    const result = await invokeRequired<{ shared: boolean }>('plugin:system-share|share', {
      payload: { contents, fileName, mimeType: 'application/json', title },
    });
    return result.shared;
  }
  const file = new File([contents], fileName, { type: 'application/json' });
  const shareData: ShareData = { title, files: [file] };
  if (!navigator.share || (navigator.canShare && !navigator.canShare(shareData))) return false;
  await navigator.share(shareData);
  return true;
}

export async function shareBlobFile(
  blob: Blob,
  fileName: string,
  mimeType: string,
  title = '资产生命周期账本备份',
): Promise<boolean> {
  const file = new File([blob], fileName, { type: mimeType });
  const shareData: ShareData = { title, files: [file] };
  if (!navigator.share || (navigator.canShare && !navigator.canShare(shareData))) return false;
  await navigator.share(shareData);
  return true;
}
