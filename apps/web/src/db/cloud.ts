import { newId } from '@zichan/core';

const DEVICES_KEY = 'zichan-cloud-devices';
const DEVICE_ID_KEY = 'zichan-device-id-v2';

/** One persistent installation id per browser profile or installed application. */
export function getDeviceId(): string {
  let id = localStorage.getItem(DEVICE_ID_KEY);
  if (!id) {
    id = `dev-${newId()}`;
    localStorage.setItem(DEVICE_ID_KEY, id);
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
    const list = JSON.parse(localStorage.getItem(DEVICES_KEY) ?? '[]') as DeviceInfo[];
    return list.map((d) => ({ ...d, applied: d.applied ?? 0 }));
  } catch {
    return [];
  }
}

/** Record that a device just synced (shared device registry, updated in place). */
export function registerSync(deviceId: string, name: string, applied: number): void {
  const list = listDevices().filter((d) => d.deviceId !== deviceId);
  list.push({ deviceId, name, lastSyncAt: new Date().toISOString(), applied });
  localStorage.setItem(DEVICES_KEY, JSON.stringify(list));
}
