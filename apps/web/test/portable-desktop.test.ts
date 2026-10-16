import { afterEach, describe, expect, it } from 'vitest';
import { readDesktopStorageStatus } from '../src/portable-desktop.js';

const originalWindow = Object.getOwnPropertyDescriptor(globalThis, 'window');

afterEach(() => {
  if (originalWindow) Object.defineProperty(globalThis, 'window', originalWindow);
  else Reflect.deleteProperty(globalThis, 'window');
});

describe('portable desktop storage status', () => {
  it('does not invoke a desktop command in the browser', async () => {
    Reflect.deleteProperty(globalThis, 'window');
    await expect(readDesktopStorageStatus()).resolves.toBeNull();
  });

  it('reads the portable root and runtime selected by native startup', async () => {
    const status = {
      mode: 'portable' as const,
      formatVersion: 1 as const,
      rootDirectory: 'D:\\资产 生命周期',
      dataDirectory: 'D:\\资产 生命周期\\data',
      filesystem: 'NTFS' as const,
      webviewRuntime: 'fixed' as const,
      serverBind: '0.0.0.0' as const,
    };
    const calls: string[] = [];
    Object.defineProperty(globalThis, 'window', {
      configurable: true,
      value: {
        __TAURI_INTERNALS__: {
          invoke: async (command: string) => {
            calls.push(command);
            return status;
          },
        },
      },
    });

    await expect(readDesktopStorageStatus()).resolves.toEqual(status);
    expect(calls).toEqual(['desktop_storage_status']);
  });

  it('does not label mobile platform storage as Windows portable storage', async () => {
    Object.defineProperty(globalThis, 'window', {
      configurable: true,
      value: {
        __TAURI_INTERNALS__: {
          invoke: async () => ({ mode: 'platform' }),
        },
      },
    });
    await expect(readDesktopStorageStatus()).resolves.toBeNull();
  });

  it('exposes installed mode and its separate user data directory', async () => {
    const status = {
      mode: 'installed' as const,
      formatVersion: 1 as const,
      rootDirectory: 'C:\\Users\\Alice\\AppData\\Local\\com.zichan.ledger',
      dataDirectory: 'C:\\Users\\Alice\\AppData\\Local\\com.zichan.ledger',
      filesystem: 'NTFS' as const,
      webviewRuntime: 'system-evergreen' as const,
      serverBind: '0.0.0.0' as const,
    };
    Object.defineProperty(globalThis, 'window', {
      configurable: true,
      value: { __TAURI_INTERNALS__: { invoke: async () => status } },
    });
    await expect(readDesktopStorageStatus()).resolves.toEqual(status);
  });
});
