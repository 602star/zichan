import { accountLocalStorage } from './account-storage.js';
import { AUTO_SYNC_KEY, SYNC_CONNECTIONS_KEY, loadSyncConnections, saveAutoSync, saveSyncConnections, type SyncConnection } from './sync-config.js';

const PRIMARY_CONNECTION_KEY = 'zichan.web-account.primary-connection.v1';

export function isPrimaryWebConnection(connection: Pick<SyncConnection, 'id'>): boolean {
  return accountLocalStorage.getItem(PRIMARY_CONNECTION_KEY) === connection.id;
}

/** Call only after activating the authenticated account's storage namespace. */
export function restoreWebSyncConnections(incoming: SyncConnection): SyncConnection {
  const saved = accountLocalStorage.getItem(SYNC_CONNECTIONS_KEY) ? loadSyncConnections() : [];
  const previous = saved.find((row) => row.serverId === incoming.serverId && row.accountId === incoming.accountId);
  const primary = {
    ...previous, ...incoming,
    id: previous?.id ?? incoming.id,
    serverRef: previous?.serverRef ?? incoming.serverRef,
    alias: previous?.alias ?? incoming.alias,
    alternateUrls: previous?.alternateUrls ?? incoming.alternateUrls,
    sharedUrls: previous?.sharedUrls ?? incoming.sharedUrls,
    deviceUrls: previous?.deviceUrls ?? incoming.deviceUrls,
    enabled: true,
  };
  // Preserve extra servers; never recreate their IDs or borrow another account's credentials.
  saveSyncConnections([primary, ...saved.filter((row) => row.id !== primary.id && row.serverId !== incoming.serverId)]);
  accountLocalStorage.setItem(PRIMARY_CONNECTION_KEY, primary.id);
  if (!accountLocalStorage.getItem(AUTO_SYNC_KEY)) saveAutoSync({ enabled: true, minutes: 5 });
  return primary;
}
