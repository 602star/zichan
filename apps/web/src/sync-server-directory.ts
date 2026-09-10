import type { SqlLedgerStore } from '@zichan/db';
import {
  newSyncConnection,
  normalizeSyncBaseUrl,
  type SharedSyncServer,
  type SyncConnection,
} from './sync-config.js';

interface SharedSyncDirectoryDocument {
  version: 1;
  servers: SharedSyncServer[];
}

type SettingsStore = Pick<SqlLedgerStore, 'settings'>;

function uniqueSharedUrls(values: string[]): string[] {
  const result: string[] = [];
  for (const value of values) {
    try {
      const normalized = normalizeSyncBaseUrl(value);
      if (!result.includes(normalized)) result.push(normalized);
    } catch {
      // Corrupt or private shared endpoints are excluded from the synced directory.
    }
  }
  return result;
}

function normalizeServer(value: Partial<SharedSyncServer>): SharedSyncServer | undefined {
  const id = typeof value.id === 'string' ? value.id.trim() : '';
  const alias = typeof value.alias === 'string' ? value.alias.trim() : '';
  const serverId = typeof value.serverId === 'string' ? value.serverId.trim() : '';
  const serverPublicKey = typeof value.serverPublicKey === 'string' ? value.serverPublicKey.trim() : '';
  const sharedUrls = uniqueSharedUrls(Array.isArray(value.sharedUrls) ? value.sharedUrls : []);
  if (!id || !alias || !serverId || !serverPublicKey || sharedUrls.length === 0) return undefined;
  return { id, alias, serverId, serverPublicKey, sharedUrls };
}

export function sharedDirectoryFromConnections(connections: SyncConnection[]): SharedSyncServer[] {
  const servers: SharedSyncServer[] = [];
  for (const connection of connections) {
    const normalized = normalizeServer({
      id: connection.serverRef || connection.id,
      alias: connection.alias,
      serverId: connection.serverId,
      serverPublicKey: connection.serverPublicKey,
      sharedUrls: connection.sharedUrls,
    });
    if (!normalized) continue;
    const existing = servers.find((server) => server.serverId === normalized.serverId);
    if (existing) {
      if (existing.serverPublicKey !== normalized.serverPublicKey) continue;
      existing.sharedUrls = uniqueSharedUrls([...existing.sharedUrls, ...normalized.sharedUrls]);
    } else {
      servers.push(normalized);
    }
  }
  return servers.sort((left, right) => left.id.localeCompare(right.id));
}

export async function loadSharedSyncDirectory(store: SettingsStore): Promise<SharedSyncServer[]> {
  const setting = (await store.settings.list({ limit: 1 }))[0];
  return parseSharedSyncDirectory(setting?.syncServersJson);
}

export function parseSharedSyncDirectory(raw?: string | null): SharedSyncServer[] {
  if (raw === undefined || raw === null || raw === '') return [];
  try {
    const parsed = JSON.parse(raw) as Partial<SharedSyncDirectoryDocument>;
    if (parsed?.version !== 1 || !Array.isArray(parsed.servers)) throw new Error('版本或结构不支持');
    const ids = new Set<string>();
    const serverIds = new Set<string>();
    return parsed.servers.map((value) => {
      if (!value || !Array.isArray(value.sharedUrls) || value.sharedUrls.some((url) => typeof url !== 'string')) throw new Error('地址结构无效');
      // Do not silently discard a damaged entry or endpoint and later overwrite the original.
      for (const url of value.sharedUrls) normalizeSyncBaseUrl(url);
      const server = normalizeServer(value);
      if (!server?.serverId || ids.has(server.id) || serverIds.has(server.serverId)) throw new Error('服务器条目无效或重复');
      ids.add(server.id);
      serverIds.add(server.serverId);
      return server;
    });
  } catch {
    throw new Error('共享服务器目录损坏或版本不支持；原始目录已保留，请恢复有效目录后重试');
  }
}

export async function saveSharedSyncDirectory(store: SettingsStore, connections: SyncConnection[]): Promise<boolean> {
  const setting = (await store.settings.list({ limit: 1 }))[0];
  if (!setting) return false;
  parseSharedSyncDirectory(setting.syncServersJson);
  const document: SharedSyncDirectoryDocument = { version: 1, servers: sharedDirectoryFromConnections(connections) };
  const serialized = JSON.stringify(document);
  if (setting.syncServersJson === serialized) return false;
  await store.settings.put({ ...setting, syncServersJson: serialized });
  return true;
}

export function mergeSharedSyncDirectory(
  connections: SyncConnection[],
  sharedServers: SharedSyncServer[],
): SyncConnection[] {
  const rows = [...connections];
  for (const server of sharedServers) {
    const normalized = normalizeServer(server);
    if (!normalized) continue;
    const existingIndex = rows.findIndex((connection) => connection.serverId === normalized.serverId
      || connection.serverRef === normalized.id);
    if (existingIndex >= 0) {
      const existing = rows[existingIndex]!;
      if (existing.serverPublicKey && existing.serverPublicKey !== normalized.serverPublicKey) {
        rows[existingIndex] = {
          ...existing,
          status: 'identity_changed',
          lastError: '账本共享目录中的服务器公钥与本机信任记录不一致',
        };
        continue;
      }
      const candidates = [...new Set([...existing.sharedUrls, ...normalized.sharedUrls])];
      rows[existingIndex] = {
        ...existing,
        alias: normalized.alias,
        serverId: normalized.serverId,
        serverPublicKey: normalized.serverPublicKey,
        sharedUrls: candidates,
        alternateUrls: [...new Set([...existing.alternateUrls, ...candidates.filter((url) => url !== existing.baseUrl)])],
      };
      continue;
    }
    const firstUrl = normalized.sharedUrls[0]!;
    rows.push({
      ...newSyncConnection(firstUrl),
      id: normalized.id,
      serverRef: normalized.id,
      alias: normalized.alias,
      serverId: normalized.serverId,
      serverPublicKey: normalized.serverPublicKey,
      sharedUrls: normalized.sharedUrls,
      alternateUrls: normalized.sharedUrls.slice(1),
      enabled: false,
      status: 'login_required',
      lastError: '此服务器来自账本共享目录；请在当前设备单独登录',
    });
  }
  return rows;
}
