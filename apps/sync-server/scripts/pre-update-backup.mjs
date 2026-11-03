import { spawn } from 'node:child_process';
import { stat } from 'node:fs/promises';
import { isAbsolute, join } from 'node:path';

async function runMaintenance(entry, command, dataDir, options) {
  await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [entry, command, '--data-dir', dataDir, ...options], {
      env: process.env, stdio: 'inherit',
    });
    child.once('error', reject);
    child.once('exit', (code) => code === 0 ? resolve() : reject(new Error(`维护命令 ${command} 失败（${String(code)}）`)));
  });
}

export async function verifiedPreUpdateBackup({ runtime, update, backupRoot, dataDir, maintenance = runMaintenance }) {
  if (!backupRoot || !isAbsolute(backupRoot)) throw new Error('生产自更新要求绝对路径 ADMIN_BACKUP_DIRECTORY');
  if (!(await stat(backupRoot)).isDirectory()) throw new Error('生产备份目录不是文件夹');
  if (!/^[a-f0-9-]{36}$/.test(update.taskId)) throw new Error('更新任务 ID 无效');
  const backup = join(backupRoot, `pre-${update.operation === 'rollback' ? 'rollback' : 'update'}-${update.taskId}`);
  const entry = join(runtime, update.from, 'dist', 'maintenance.mjs');
  let exists = false;
  try { exists = (await stat(backup)).isDirectory(); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  if (!exists) await maintenance(entry, 'backup', dataDir, ['--output', backup]);
  await maintenance(entry, 'verify-backup', dataDir, ['--backup', backup, '--record-id', `pre-update-${update.taskId}`]);
  return backup;
}
