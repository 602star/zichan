/**
 * Node entry — the node:sqlite driver plus an `openLedger` convenience. Kept out
 * of the main index so the browser bundle never pulls in `node:sqlite`.
 */
import type { Logger } from '@zichan/logger';
import { NodeSqliteDriver } from './drivers/node-sqlite.js';
import { createLedgerStore, type SqlLedgerStore } from './repository.js';

export { NodeSqliteDriver } from './drivers/node-sqlite.js';

export interface OpenLedgerOptions {
  /** SQLite file path; defaults to an in-memory database. */
  filename?: string;
  logger?: Logger;
  deviceId?: string;
}

/** Open and verify a ledger store backed by node:sqlite. */
export async function openLedger(opts: OpenLedgerOptions = {}): Promise<SqlLedgerStore> {
  const driver = new NodeSqliteDriver(opts.filename);
  return createLedgerStore(driver, { logger: opts.logger, deviceId: opts.deviceId });
}
