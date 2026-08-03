export type SyncProtocol = 'http' | 'https';
export type SyncTestStatus = 'idle' | 'online' | 'unauthorized' | 'offline';

export interface SyncServerProfile {
  id: string;
  alias: string;
  protocol: SyncProtocol;
  host: string;
  port: string;
  basePath: string;
  username: string;
  enabled: boolean;
  serverId?: string;
  replicaId?: string;
  streamEpoch?: string;
  ledgerId?: string;
  lastStatus?: SyncTestStatus;
  lastLatencyMs?: number;
  lastTestAt?: string;
  lastSyncAt?: string;
  lastError?: string;
}

export interface ServerCredential {
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

export const SYNC_PROFILES_KEY = 'zichan.sync.serverProfiles.v3';
export const SESSION_CREDENTIALS_KEY = 'zichan.sync.sessionCredentials.v3';
export const AUTO_SYNC_KEY = 'zichan.sync.auto.v1';
export const SYNC_CONFIG_CHANGED_EVENT = 'zichan:sync-config-changed';

function newId(): string {
  return globalThis.crypto?.randomUUID?.() ?? `server-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

export function normalizeBasePath(path: string): string {
  const trimmed = path.trim();
  if (!trimmed || trimmed === '/') return '';
  return (trimmed.startsWith('/') ? trimmed : `/${trimmed}`).replace(/\/+$/, '');
}

export function newSyncProfile(): SyncServerProfile {
  return {
    id: newId(),
    alias: '本机服务器',
    protocol: 'http',
    host: 'localhost',
    port: '8787',
    basePath: '',
    username: '',
    enabled: false,
    lastStatus: 'idle',
  };
}

export function buildSyncBaseUrl(profile: SyncServerProfile): string {
  const host = profile.host.trim();
  const port = profile.port.trim();
  const path = normalizeBasePath(profile.basePath);
  return `${profile.protocol}://${host}${port ? `:${port}` : ''}${path}`;
}

export function isUnauthorizedSyncError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /\b40[13]\b|unauthori[sz]ed|认证失败|鉴权失败/i.test(message);
}

export function loadSyncProfiles(): SyncServerProfile[] {
  try {
    const raw = globalThis.localStorage?.getItem(SYNC_PROFILES_KEY);
    if (!raw) return [newSyncProfile()];
    const rows = JSON.parse(raw) as Partial<SyncServerProfile>[];
    const profiles = rows.map((row): SyncServerProfile => ({
      id: typeof row.id === 'string' ? row.id : newId(),
      alias: typeof row.alias === 'string' && row.alias.trim() ? row.alias : '同步服务器',
      protocol: row.protocol === 'https' ? 'https' : 'http',
      host: typeof row.host === 'string' && row.host.trim() ? row.host : 'localhost',
      port: typeof row.port === 'string' ? row.port : '',
      basePath: typeof row.basePath === 'string' ? normalizeBasePath(row.basePath) : '',
      username: typeof row.username === 'string' ? row.username : '',
      enabled: row.enabled === true,
      serverId: typeof row.serverId === 'string' ? row.serverId : undefined,
      replicaId: typeof row.replicaId === 'string' ? row.replicaId : undefined,
      streamEpoch: typeof row.streamEpoch === 'string' ? row.streamEpoch : undefined,
      ledgerId: typeof row.ledgerId === 'string' ? row.ledgerId : undefined,
      lastStatus: row.lastStatus === 'online' || row.lastStatus === 'unauthorized' || row.lastStatus === 'offline' ? row.lastStatus : 'idle',
      lastLatencyMs: typeof row.lastLatencyMs === 'number' ? row.lastLatencyMs : undefined,
      lastTestAt: typeof row.lastTestAt === 'string' ? row.lastTestAt : undefined,
      lastSyncAt: typeof row.lastSyncAt === 'string' ? row.lastSyncAt : undefined,
      lastError: typeof row.lastError === 'string' ? row.lastError : undefined,
    }));
    return profiles.length ? profiles : [newSyncProfile()];
  } catch {
    return [newSyncProfile()];
  }
}

export function saveSyncProfiles(profiles: SyncServerProfile[]): void {
  const rows = profiles.map(({ id, alias, protocol, host, port, basePath, username, enabled, serverId, replicaId, streamEpoch, ledgerId, lastStatus, lastLatencyMs, lastTestAt, lastSyncAt, lastError }) => ({
    id, alias, protocol, host, port, basePath: normalizeBasePath(basePath), username, enabled,
    serverId, replicaId, streamEpoch, ledgerId, lastStatus, lastLatencyMs, lastTestAt, lastSyncAt, lastError,
  }));
  const serialized = JSON.stringify(rows);
  if (globalThis.localStorage?.getItem(SYNC_PROFILES_KEY) === serialized) return;
  globalThis.localStorage?.setItem(SYNC_PROFILES_KEY, serialized);
  globalThis.dispatchEvent?.(new CustomEvent(SYNC_CONFIG_CHANGED_EVENT, { detail: { kind: 'profiles' } }));
}

export function patchSavedSyncProfile(id: string, patch: Partial<SyncServerProfile>): void {
  saveSyncProfiles(loadSyncProfiles().map((profile) => profile.id === id ? { ...profile, ...patch } : profile));
}

export function loadSessionCredentials(): Record<string, ServerCredential> {
  try {
    const parsed = JSON.parse(globalThis.sessionStorage?.getItem(SESSION_CREDENTIALS_KEY) ?? '{}') as Record<string, Partial<ServerCredential>>;
    return Object.fromEntries(Object.entries(parsed).map(([id, value]) => [id, {
      password: typeof value.password === 'string' ? value.password : '',
      inviteCode: typeof value.inviteCode === 'string' ? value.inviteCode : '',
      accessToken: typeof value.accessToken === 'string' ? value.accessToken : undefined,
      refreshToken: typeof value.refreshToken === 'string' ? value.refreshToken : undefined,
      accessExpiresAt: typeof value.accessExpiresAt === 'string' ? value.accessExpiresAt : undefined,
      sessionId: typeof value.sessionId === 'string' ? value.sessionId : undefined,
    }]));
  } catch {
    return {};
  }
}

export function saveSessionCredentials(credentials: Record<string, ServerCredential>): void {
  globalThis.sessionStorage?.setItem(SESSION_CREDENTIALS_KEY, JSON.stringify(credentials));
}

export function loadAutoSync(): AutoSyncConfig {
  try {
    const parsed = JSON.parse(globalThis.localStorage?.getItem(AUTO_SYNC_KEY) ?? '{}') as { enabled?: unknown; minutes?: unknown };
    return { enabled: parsed.enabled === true, minutes: [1, 5, 15, 30, 60].includes(Number(parsed.minutes)) ? Number(parsed.minutes) : 5 };
  } catch {
    return { enabled: false, minutes: 5 };
  }
}

export function saveAutoSync(config: AutoSyncConfig): void {
  const serialized = JSON.stringify(config);
  if (globalThis.localStorage?.getItem(AUTO_SYNC_KEY) === serialized) return;
  globalThis.localStorage?.setItem(AUTO_SYNC_KEY, serialized);
  globalThis.dispatchEvent?.(new CustomEvent(SYNC_CONFIG_CHANGED_EVENT, { detail: { kind: 'auto' } }));
}
