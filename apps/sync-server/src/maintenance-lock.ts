import { mkdirSync, readFileSync, rmdirSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

/** Shared with the host updater through the bind-mounted data directory.
 * A crash leaves the lock in place and requires an operator to reconcile it.
 */
export function acquireMaintenanceLock(dataDir: string, owner: string): (() => void) | undefined {
  const directory = join(dataDir, 'maintenance.lock');
  try { mkdirSync(directory, { mode: 0o700 }); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') return undefined;
    throw error;
  }
  try {
    writeFileSync(join(directory, 'owner'), owner, { encoding: 'utf8', flag: 'wx', mode: 0o600 });
  } catch (error) {
    rmdirSync(directory);
    throw error;
  }
  return () => {
    if (readFileSync(join(directory, 'owner'), 'utf8') !== owner) throw new Error('维护锁所有者已更改');
    unlinkSync(join(directory, 'owner'));
    rmdirSync(directory);
  };
}
