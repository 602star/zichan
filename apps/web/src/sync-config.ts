import { accountLocalStorage, accountSessionStorage } from './account-storage.js';
import { prefixedId } from '@zichan/core';
import { assertSecureSyncUrl, isLocalNetworkSyncUrl } from '@zichan/db';

export type SyncProtocol = 'http' | 'https';
export type SyncConnectionStatus = 'unchecked' | 'online' | 'offline' | 'identity_changed'
  | 'login_required' | 'replica_retired';
/** Role of the signed-in account on a server. A read-only operator sees nothing writable. */
export type SyncConnectionRole = 'owner' | 'admin' | 'viewer' | 'member';
export type SyncAddressPreset = 'current' | 'local' | 'lan' | 'public';

/** Server identity and public endpoints that may be shared with another device. */
export interface SharedSyncServer {
  id: string;
  alias: string;
  serverId?: string;
  serverPublicKey?: string;
  /** Ed25519 signing identity used by node-to-node ledger replication. */
  nodePublicKey?: string;
  sharedUrls: string[];
}

/** Device-local account, endpoints, replica identity and operational state. */
export interface DeviceSyncConnection {
  initialProtectionMode?: 'managed' | 'private';
  accountId?: string;
  serverRef: string;
  activeUrl: string;
  deviceUrls: string[];
  username: string;
  enabled: boolean;
  role?: SyncConnectionRole;
  ledgerId?: string;
  replicaId?: string;
  streamEpoch?: string;
  status: SyncConnectionStatus;
  lastLatencyMs?: number;
  lastTestAt?: string;
  lastSyncAt?: string;
  lastError?: string;
  /** Unresolved error from the most recent data or attachment synchronization. */
  lastSyncError?: string;
  /** Identity expectation imported from a non-secret connection link, verified before credentials are sent. */
  expectedServerPublicKeyFingerprint?: string;
}

/** Resolved view used by clients; storage remains split into shared and device state. */
export interface SyncConnection extends DeviceSyncConnection {
  id: string;
  alias: string;
  baseUrl: string;
  alternateUrls: string[];
  sharedUrls: string[];
  serverId?: string;
  serverPublicKey?: string;
  nodePublicKey?: string;
}

export interface SyncUrlParts {
  protocol: SyncProtocol;
  host: string;
  port: string;
  path: string;
}

export interface ServerCredential {
  sessionTransport?: 'cookie' | 'token';
  password: string;
  inviteCode: string;
  accessToken?: string;
  refreshToken?: string;
  accessExpiresAt?: string;
  sessionId?: string;
}

export interface AutoSyncConfig {
  enabled: boolean;
  minutes: number;
}

interface SyncConnectionDocument {
  version: 1;
  servers: SharedSyncServer[];
  connections: DeviceSyncConnection[];
}

export const SYNC_CONNECTIONS_KEY = 'zichan.sync.connections.v1';
export const SESSION_CREDENTIALS_KEY = 'zichan.sync.connectionCredentials.v1';
export const AUTO_SYNC_KEY = 'zichan.sync.auto.v1';
export const SYNC_CONFIG_CHANGED_EVENT = 'zichan:sync-config-changed';

function newId(): string {
  return prefixedId('server');
}

export function normalizeSyncPath(path: string): string {
  const trimmed = path.trim();
  if (!trimmed || trimmed === '/') return '';
  return (trimmed.startsWith('/') ? trimmed : `/${trimmed}`).replace(/\/+$/, '');
}

export function normalizeSyncBaseUrl(input: string): string {
  const raw = input.trim();
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error('同步服务器地址无效');
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new Error('同步服务器只支持 HTTP 或 HTTPS');
  if (url.username || url.password) throw new Error('同步服务器地址不能包含用户名或密码');
  if (url.search || url.hash) throw new Error('同步服务器地址不能包含查询参数或片段');
  assertSecureSyncUrl(url.toString());
  url.pathname = normalizeSyncPath(url.pathname);
  return url.toString().replace(/\/$/, '');
}

export function parseSyncBaseUrl(input: string): SyncUrlParts {
  const url = new URL(normalizeSyncBaseUrl(input));
  return {
    protocol: url.protocol.slice(0, -1) as SyncProtocol,
    host: url.hostname,
    port: url.port,
    path: normalizeSyncPath(decodeURI(url.pathname)),
  };
}

function bracketIpv6Host(host: string): string {
  const value = host.trim();
  if (value.includes(':') && !value.startsWith('[')) return `[${value}]`;
  return value;
}

export function buildSyncUrlFromParts(parts: SyncUrlParts): string {
  const host = bracketIpv6Host(parts.host);
  if (!host) throw new Error('请填写服务器主机或域名');
  if (parts.port && (!/^\d{1,5}$/.test(parts.port) || Number(parts.port) > 65_535 || Number(parts.port) < 1)) {
    throw new Error('同步服务器端口无效');
  }
  return normalizeSyncBaseUrl(`${parts.protocol}://${host}${parts.port ? `:${parts.port}` : ''}${normalizeSyncPath(parts.path)}`);
}

function currentSiteUrl(): string | undefined {
  try {
    const base = globalThis.document?.baseURI || globalThis.location?.href;
    if (!base) return undefined;
    const url = new URL('.', base);
    // The bundled server exposes the SPA below /app while its API lives at the
    // enclosing runtime base path (for example /zichan/app -> /zichan/api).
    if (url.pathname.endsWith('/app/')) url.pathname = url.pathname.slice(0, -4);
    return normalizeSyncBaseUrl(url.toString());
  } catch {
    return undefined;
  }
}

export function syncAddressPresetUrl(
  preset: SyncAddressPreset,
  options: { host?: string; path?: string } = {},
): string {
  if (preset === 'current') return currentSiteUrl() ?? 'http://localhost:8787';
  if (preset === 'local') return 'http://localhost:8787';
  if (preset === 'lan') return buildSyncUrlFromParts({
    protocol: 'http',
    host: options.host?.trim() || '192.168.1.100',
    port: '8787',
    path: '',
  });
  return buildSyncUrlFromParts({
    protocol: 'https',
    host: options.host?.trim() || 'ledger.example.com',
    port: '',
    path: options.path ?? '/zichan',
  });
}

export function isDeviceLocalSyncUrl(input: string): boolean {
  return isLocalNetworkSyncUrl(normalizeSyncBaseUrl(input));
}

function uniqueUrls(values: string[]): string[] {
  const result: string[] = [];
  for (const value of values) {
    try {
      const normalized = normalizeSyncBaseUrl(value);
      if (!result.includes(normalized)) result.push(normalized);
    } catch {
      // Invalid stored rows are discarded instead of being used for requests.
    }
  }
  return result;
}

/**
 * Merge endpoint scope without replacing an explicit public/device choice with
 * the URL's default scope. The established connection wins only when both
 * connections classify the exact same endpoint differently.
 */
export function mergeSyncUrlScopes(
  primary: Pick<SyncConnection, 'sharedUrls' | 'deviceUrls'>,
  incoming: Pick<SyncConnection, 'sharedUrls' | 'deviceUrls'>,
  urls: string[],
): Pick<SyncConnection, 'sharedUrls' | 'deviceUrls'> {
  const candidates = uniqueUrls(urls);
  const primaryShared = new Set(uniqueUrls(primary.sharedUrls));
  const primaryDevice = new Set(uniqueUrls(primary.deviceUrls));
  const incomingShared = new Set(uniqueUrls(incoming.sharedUrls));
  const incomingDevice = new Set(uniqueUrls(incoming.deviceUrls));
  const sharedUrls: string[] = [];
  const deviceUrls: string[] = [];
  for (const url of candidates) {
    const shared = primaryShared.has(url)
      || (!primaryDevice.has(url) && incomingShared.has(url))
      || (!primaryDevice.has(url) && !incomingDevice.has(url) && !isDeviceLocalSyncUrl(url));
    (shared ? sharedUrls : deviceUrls).push(url);
  }
  return { sharedUrls, deviceUrls };
}

function aliasForUrl(baseUrl: string): string {
  const url = new URL(baseUrl);
  if (url.hostname === 'localhost' || url.hostname === '127.0.0.1' || url.hostname === '[::1]') return '本机服务器';
  if (url.protocol === 'http:') return '局域网服务器';
  return '公网服务器';
}

export function newSyncConnection(baseUrl = syncAddressPresetUrl('current')): SyncConnection {
  const normalized = normalizeSyncBaseUrl(baseUrl);
  const id = newId();
  const local = isDeviceLocalSyncUrl(normalized);
  return {
    id,
    serverRef: id,
    alias: aliasForUrl(normalized),
    baseUrl: normalized,
    activeUrl: normalized,
    alternateUrls: [],
    sharedUrls: local ? [] : [normalized],
    deviceUrls: local ? [normalized] : [],
    username: '',
    enabled: false,
    status: 'unchecked',
  };
}

function parseStatus(value: unknown): SyncConnectionStatus {
  return value === 'online' || value === 'offline' || value === 'identity_changed'
    || value === 'login_required' || value === 'replica_retired'
    ? value
    : 'unchecked';
}

function parseRole(value: unknown): SyncConnectionRole | undefined {
  return value === 'owner' || value === 'admin' || value === 'viewer' || value === 'member' ? value : undefined;
}

function resolveDocument(document: SyncConnectionDocument): SyncConnection[] {
  const servers = new Map(document.servers.map((server) => [server.id, server]));
  const resolved: SyncConnection[] = [];
  for (const row of document.connections) {
    const server = servers.get(row.serverRef);
    if (!server) continue;
    const sharedUrls = uniqueUrls(Array.isArray(server.sharedUrls) ? server.sharedUrls : []);
    const deviceUrls = uniqueUrls(Array.isArray(row.deviceUrls) ? row.deviceUrls : []);
    const candidates = uniqueUrls([row.activeUrl, ...deviceUrls, ...sharedUrls]);
    const baseUrl = candidates[0];
    if (!baseUrl) continue;
    resolved.push({
      id: server.id,
      serverRef: server.id,
      alias: typeof server.alias === 'string' && server.alias.trim() ? server.alias : aliasForUrl(baseUrl),
      baseUrl,
      activeUrl: baseUrl,
      alternateUrls: candidates.slice(1),
      sharedUrls,
      deviceUrls,
      username: typeof row.username === 'string' ? row.username : '',
      accountId: typeof row.accountId === 'string' ? row.accountId : undefined,
      initialProtectionMode: row.initialProtectionMode === 'private' ? 'private' : undefined,
      enabled: row.enabled === true,
      role: parseRole(row.role),
      serverId: typeof server.serverId === 'string' && server.serverId ? server.serverId : undefined,
      serverPublicKey: typeof server.serverPublicKey === 'string' && server.serverPublicKey ? server.serverPublicKey : undefined,
      nodePublicKey: typeof server.nodePublicKey === 'string' && server.nodePublicKey ? server.nodePublicKey : undefined,
      ledgerId: typeof row.ledgerId === 'string' ? row.ledgerId : undefined,
      replicaId: typeof row.replicaId === 'string' ? row.replicaId : undefined,
      streamEpoch: typeof row.streamEpoch === 'string' ? row.streamEpoch : undefined,
      status: parseStatus(row.status),
      lastLatencyMs: typeof row.lastLatencyMs === 'number' ? row.lastLatencyMs : undefined,
      lastTestAt: typeof row.lastTestAt === 'string' ? row.lastTestAt : undefined,
      lastSyncAt: typeof row.lastSyncAt === 'string' ? row.lastSyncAt : undefined,
      lastError: typeof row.lastError === 'string' ? row.lastError : undefined,
      lastSyncError: typeof row.lastSyncError === 'string' ? row.lastSyncError : undefined,
      expectedServerPublicKeyFingerprint: typeof row.expectedServerPublicKeyFingerprint === 'string'
        ? row.expectedServerPublicKeyFingerprint
        : undefined,
    });
  }
  return resolved;
}

export function loadSyncConnections(): SyncConnection[] {
  try {
    const raw = accountLocalStorage?.getItem(SYNC_CONNECTIONS_KEY);
    if (!raw) return [newSyncConnection()];
    const parsed = JSON.parse(raw) as Partial<SyncConnectionDocument>;
    if (parsed.version !== 1 || !Array.isArray(parsed.servers) || !Array.isArray(parsed.connections)) {
      return [newSyncConnection()];
    }
    const rows = resolveDocument(parsed as SyncConnectionDocument);
    return rows.length ? rows : [newSyncConnection()];
  } catch {
    return [newSyncConnection()];
  }
}

export function hasSavedSyncConnection(): boolean {
  try {
    const raw = accountLocalStorage?.getItem(SYNC_CONNECTIONS_KEY);
    if (!raw) return false;
    const parsed = JSON.parse(raw) as Partial<SyncConnectionDocument>;
    if (parsed.version !== 1 || !Array.isArray(parsed.servers) || !Array.isArray(parsed.connections)) return false;
    return resolveDocument(parsed as SyncConnectionDocument).some((connection) => Boolean(
      connection.serverId
      && connection.serverPublicKey
      && connection.username.trim(),
    ));
  } catch {
    return false;
  }
}

function toDocument(connections: SyncConnection[]): SyncConnectionDocument {
  const servers: SharedSyncServer[] = [];
  const rows: DeviceSyncConnection[] = [];
  for (const connection of connections) {
    const id = connection.serverRef || connection.id;
    if (!id || servers.some((row) => row.id === id)) continue;
    const baseUrl = normalizeSyncBaseUrl(connection.baseUrl);
    const local = isDeviceLocalSyncUrl(baseUrl);
    const configuredSharedUrls = uniqueUrls(connection.sharedUrls ?? []);
    const configuredDeviceUrls = uniqueUrls(connection.deviceUrls ?? []);
    const baseAssigned = configuredSharedUrls.includes(baseUrl) || configuredDeviceUrls.includes(baseUrl);
    const sharedUrls = uniqueUrls([
      ...configuredSharedUrls,
      ...(!baseAssigned && !local ? [baseUrl] : []),
    ]);
    const deviceUrls = uniqueUrls([
      ...configuredDeviceUrls,
      ...(!baseAssigned && local ? [baseUrl] : []),
    ]);
    servers.push({
      id,
      alias: connection.alias.trim() || aliasForUrl(baseUrl),
      serverId: connection.serverId,
      serverPublicKey: connection.serverPublicKey,
      nodePublicKey: connection.nodePublicKey,
      sharedUrls,
    });
    rows.push({
      serverRef: id,
      activeUrl: baseUrl,
      deviceUrls,
      username: connection.username.trim(),
      accountId: connection.accountId,
      initialProtectionMode: connection.initialProtectionMode,
      enabled: connection.enabled,
      role: connection.role,
      ledgerId: connection.ledgerId,
      replicaId: connection.replicaId,
      streamEpoch: connection.streamEpoch,
      status: connection.status,
      lastLatencyMs: connection.lastLatencyMs,
      lastTestAt: connection.lastTestAt,
      lastSyncAt: connection.lastSyncAt,
      lastError: connection.lastError,
      lastSyncError: connection.lastSyncError,
      expectedServerPublicKeyFingerprint: connection.expectedServerPublicKeyFingerprint,
    });
  }
  return { version: 1, servers, connections: rows };
}

export function saveSyncConnections(connections: SyncConnection[]): void {
  const serialized = JSON.stringify(toDocument(connections));
  if (accountLocalStorage?.getItem(SYNC_CONNECTIONS_KEY) === serialized) return;
  accountLocalStorage?.setItem(SYNC_CONNECTIONS_KEY, serialized);
  globalThis.dispatchEvent?.(new CustomEvent(SYNC_CONFIG_CHANGED_EVENT, { detail: { kind: 'connections' } }));
}

export function patchSavedSyncConnection(id: string, patch: Partial<SyncConnection>): void {
  saveSyncConnections(loadSyncConnections().map((connection) => connection.id === id ? { ...connection, ...patch } : connection));
}

export function buildSyncBaseUrl(connection: Pick<SyncConnection, 'baseUrl'>): string {
  return normalizeSyncBaseUrl(connection.baseUrl);
}

export function isUnauthorizedSyncError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /\b40[13]\b|unauthori[sz]ed|认证失败|鉴权失败/i.test(message);
}

export function loadSessionCredentials(): Record<string, ServerCredential> {
  try {
    const parsed = JSON.parse(accountSessionStorage?.getItem(SESSION_CREDENTIALS_KEY) ?? '{}') as Record<string, Partial<ServerCredential>>;
    return Object.fromEntries(Object.entries(parsed).map(([id, value]) => [id, {
      password: '',
      inviteCode: '',
      sessionTransport: value.sessionTransport === 'cookie' ? 'cookie' : 'token',
      accessToken: value.sessionTransport !== 'cookie' && typeof value.accessToken === 'string' ? value.accessToken : undefined,
      refreshToken: value.sessionTransport !== 'cookie' && typeof value.refreshToken === 'string' ? value.refreshToken : undefined,
      accessExpiresAt: typeof value.accessExpiresAt === 'string' ? value.accessExpiresAt : undefined,
      sessionId: typeof value.sessionId === 'string' ? value.sessionId : undefined,
    }]));
  } catch {
    return {};
  }
}

export function saveSessionCredentials(credentials: Record<string, ServerCredential>): void {
  const safe = Object.fromEntries(Object.entries(credentials).map(([id, value]) => [id, {
    sessionTransport: value.sessionTransport ?? 'token',
    ...(value.sessionTransport !== 'cookie' ? { accessToken: value.accessToken, refreshToken: value.refreshToken } : {}),
    accessExpiresAt: value.accessExpiresAt,
    sessionId: value.sessionId,
  }]));
  accountSessionStorage?.setItem(SESSION_CREDENTIALS_KEY, JSON.stringify(safe));
}

export function loadAutoSync(): AutoSyncConfig {
  try {
    const parsed = JSON.parse(accountLocalStorage?.getItem(AUTO_SYNC_KEY) ?? '{}') as { enabled?: unknown; minutes?: unknown };
    return { enabled: parsed.enabled === true, minutes: [1, 5, 15, 30, 60].includes(Number(parsed.minutes)) ? Number(parsed.minutes) : 5 };
  } catch {
    return { enabled: false, minutes: 5 };
  }
}

export function saveAutoSync(config: AutoSyncConfig): void {
  const serialized = JSON.stringify(config);
  if (accountLocalStorage?.getItem(AUTO_SYNC_KEY) === serialized) return;
  accountLocalStorage?.setItem(AUTO_SYNC_KEY, serialized);
  globalThis.dispatchEvent?.(new CustomEvent(SYNC_CONFIG_CHANGED_EVENT, { detail: { kind: 'auto' } }));
}

/** Clear all ledger-bound synchronization settings and ephemeral sessions. */
export function clearSyncConfiguration(): void {
  accountLocalStorage?.removeItem(SYNC_CONNECTIONS_KEY);
  accountLocalStorage?.removeItem(AUTO_SYNC_KEY);
  accountSessionStorage?.removeItem(SESSION_CREDENTIALS_KEY);
  globalThis.dispatchEvent?.(new CustomEvent(SYNC_CONFIG_CHANGED_EVENT, { detail: { kind: 'reset' } }));
}
