import { newId } from '@zichan/core';

export const CLOUD_DEVICES_KEY = 'zichan-cloud-devices';
export const CLOUD_DEVICE_ID_KEY = 'zichan-device-id-v2';

/** One persistent installation id per browser profile or installed application. */
export function getDeviceId(): string {
  let id = localStorage.getItem(CLOUD_DEVICE_ID_KEY);
  if (!id) {
    id = `dev-${newId()}`;
    localStorage.setItem(CLOUD_DEVICE_ID_KEY, id);
  }
  return id;
}

export interface DeviceInfo {
  deviceId: string;
  name: string;
  lastSyncAt: string; // ISO — last push/pull round
  applied: number; // changes applied in that last sync
}

export function listDevices(): DeviceInfo[] {
  try {
    const list = JSON.parse(localStorage.getItem(CLOUD_DEVICES_KEY) ?? '[]') as DeviceInfo[];
    return list.map((d) => ({ ...d, applied: d.applied ?? 0 }));
  } catch {
    return [];
  }
}

/** Record that a device just synced (shared device registry, updated in place). */
export function registerSync(deviceId: string, name: string, applied: number): void {
  const list = listDevices().filter((d) => d.deviceId !== deviceId);
  list.push({ deviceId, name, lastSyncAt: new Date().toISOString(), applied });
  localStorage.setItem(CLOUD_DEVICES_KEY, JSON.stringify(list));
}

/** Remove the installation id and cached peer registry tied to the deleted ledger. */
export function clearCloudIdentity(): void {
  globalThis.localStorage?.removeItem(CLOUD_DEVICE_ID_KEY);
  globalThis.localStorage?.removeItem(CLOUD_DEVICES_KEY);
}
