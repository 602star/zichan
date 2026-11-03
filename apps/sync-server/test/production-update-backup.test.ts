import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { createTestSyncServer } from './support/server-fixture.js';
import { createServerBackup, verifyServerBackup } from '../src/backup.js';
import { verifiedPreUpdateBackup } from '../scripts/pre-update-backup.mjs';

describe('production self-update backup gate', () => {
  it('keeps a complete server backup and rejects a damaged record on retry', async () => {
    const root = mkdtempSync(join(tmpdir(), 'zichan-production-update-'));
    const dataDir = join(root, 'state');
    const backupRoot = join(root, 'backups');
    const server = createTestSyncServer({ dataDir });
    try {
      await server.ready;
      await server.close();
      mkdirSync(backupRoot);
      const update = { taskId: '22222222-2222-4222-8222-222222222222',
        from: 'releases/v0.3.4', operation: 'update' };
      const commands: string[] = [];
      const maintenance = async (_entry: string, command: string, state: string, options: string[]) => {
        commands.push(command);
        if (command === 'backup') await createServerBackup(state, options[1]!);
        else if (!(await verifyServerBackup(options[1]!)).ok) throw new Error('备份校验失败');
      };
      const args = { runtime: join(root, 'runtime'), update, backupRoot, dataDir, maintenance };
      const backup = await verifiedPreUpdateBackup(args);
      expect(commands).toEqual(['backup', 'verify-backup']);
      expect(existsSync(join(backup, 'server.sqlite'))).toBe(true);
      expect(readFileSync(join(backup, 'server-id'), 'utf8').trim()).toBe(server.serverId);
      expect((await verifyServerBackup(backup)).ok).toBe(true);
      writeFileSync(join(backup, 'server.secret'), 'damaged');
      await expect(verifiedPreUpdateBackup(args)).rejects.toThrow('备份校验失败');
      expect(commands.at(-1)).toBe('verify-backup');
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
});
