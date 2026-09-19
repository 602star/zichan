/**
 * What this build reports about itself on sync requests.
 *
 * The point is narrow: when a device cannot sync, the console should be able to say
 * "this device is running a build from before the current protocol" instead of only
 * showing a self-chosen device name. So the values here are deliberately coarse — the
 * client family, the build version, and the protocol generation — and nothing in the
 * server branches on them.
 *
 * `version` comes from the web package version, injected at build time. A dev server or
 * a test run has no injected value and reports `dev`, which is accurate: it is not a
 * released build, and pretending otherwise would make the diagnostics lie.
 */
import { isTauriRuntime } from './tauri.js';
import { SYNC_PROTOCOL_VERSION, type ClientIdentity } from '@zichan/core';

declare const __ZICHAN_APP_VERSION__: string | undefined;

export function clientVersion(): string {
  try {
    return typeof __ZICHAN_APP_VERSION__ === 'string' && __ZICHAN_APP_VERSION__ ? __ZICHAN_APP_VERSION__ : 'dev';
  } catch {
    // `__ZICHAN_APP_VERSION__` is not defined outside a Vite build; referencing an
    // undeclared binding throws rather than returning undefined.
    return 'dev';
  }
}

export function clientIdentity(): ClientIdentity {
  return {
    kind: isTauriRuntime() ? 'desktop' : 'web',
    version: clientVersion(),
    protocol: SYNC_PROTOCOL_VERSION,
  };
}
