import { normalizeSyncBaseUrl } from './sync-config.js';

export interface SyncConnectionLinkPayload {
  version: 1;
  alias: string;
  url: string;
  serverId: string;
  serverPublicKeyFingerprint: string;
}

const HASH_PREFIX = 'zichan-sync=';

function encodeBase64Url(value: string): string {
  const bytes = new TextEncoder().encode(value);
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function decodeBase64Url(value: string): string {
  const padded = value.replace(/-/g, '+').replace(/_/g, '/').padEnd(Math.ceil(value.length / 4) * 4, '=');
  const binary = atob(padded);
  return new TextDecoder().decode(Uint8Array.from(binary, (character) => character.charCodeAt(0)));
}

export async function fingerprintServerPublicKey(serverPublicKey: string): Promise<string> {
  const bytes = new TextEncoder().encode(serverPublicKey);
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return [...new Uint8Array(digest)].map((value) => value.toString(16).padStart(2, '0')).join('');
}

export function createSyncConnectionLink(
  payload: SyncConnectionLinkPayload,
  applicationUrl = globalThis.location?.href ?? 'https://localhost/',
): string {
  const url = new URL(applicationUrl);
  url.search = '';
  url.hash = `${HASH_PREFIX}${encodeBase64Url(JSON.stringify({
    ...payload,
    alias: payload.alias.trim(),
    url: normalizeSyncBaseUrl(payload.url),
  }))}`;
  return url.toString();
}

export function parseSyncConnectionLink(input: string): SyncConnectionLinkPayload {
  let hash: string;
  try {
    hash = new URL(input.trim()).hash.slice(1);
  } catch {
    hash = input.trim().replace(/^#/, '');
  }
  if (!hash.startsWith(HASH_PREFIX)) throw new Error('连接链接格式无效');
  let parsed: Partial<SyncConnectionLinkPayload>;
  try {
    parsed = JSON.parse(decodeBase64Url(hash.slice(HASH_PREFIX.length))) as Partial<SyncConnectionLinkPayload>;
  } catch {
    throw new Error('连接链接内容损坏');
  }
  if (parsed.version !== 1 || !parsed.alias?.trim() || !parsed.serverId?.trim()
    || !/^[a-f0-9]{64}$/i.test(parsed.serverPublicKeyFingerprint ?? '')) {
    throw new Error('连接链接缺少服务器身份信息');
  }
  return {
    version: 1,
    alias: parsed.alias.trim(),
    url: normalizeSyncBaseUrl(parsed.url ?? ''),
    serverId: parsed.serverId.trim(),
    serverPublicKeyFingerprint: parsed.serverPublicKeyFingerprint!.toLowerCase(),
  };
}

export function connectionLinkFromLocation(): SyncConnectionLinkPayload | undefined {
  try {
    if (!globalThis.location?.hash.includes(HASH_PREFIX)) return undefined;
    return parseSyncConnectionLink(globalThis.location.href);
  } catch {
    return undefined;
  }
}

export function clearConnectionLinkHash(): void {
  if (!globalThis.history?.replaceState || !globalThis.location) return;
  const url = new URL(globalThis.location.href);
  if (!url.hash.startsWith(`#${HASH_PREFIX}`)) return;
  url.hash = '';
  globalThis.history.replaceState(globalThis.history.state, '', url.toString());
}
