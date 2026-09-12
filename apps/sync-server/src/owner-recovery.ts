import { createHash, randomBytes } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync, unlinkSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { assertServerStopped } from './backup.js';
import { SyncServerStore } from './store.js';

/** Only exposed through local maintenance. Never returns the reset code to logs. */
export async function issueOwnerRecovery(dataDirValue: string, outputValue: string): Promise<{ username: string; expiresAt: string }> {
  const dataDir = resolve(dataDirValue);
  const output = resolve(outputValue);
  assertServerStopped(dataDir);
  if (!existsSync(join(dataDir, 'server.sqlite'))) throw new Error('服务器数据库不存在');
  const serverId = readFileSync(join(dataDir, 'server-id'), 'utf8').trim();
  if (!serverId) throw new Error('服务器身份缺失');
  const code = randomBytes(32).toString('base64url');
  const expiresAt = new Date(Date.now() + 15 * 60_000).toISOString();
  // Exclusive creation prevents replacing an existing secret or arbitrary file.
  writeFileSync(output, JSON.stringify({ code, expiresAt }, null, 2), { flag: 'wx', mode: 0o600 });
  const store = new SyncServerStore(join(dataDir, 'server.sqlite'), 'closed', serverId);
  try {
    const username = await store.issueAccountRecovery(createHash('sha256').update(code).digest('hex'), expiresAt);
    return { username, expiresAt };
  } catch (error) {
    unlinkSync(output);
    throw error;
  } finally { await store.close(); }
}
