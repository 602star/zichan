import { resolve } from 'node:path';
import { createServerBackup, restoreServerBackup, verifyServerBackup } from './backup.js';
import { developmentDataDir } from './runtime-config.js';

function option(name: string, fallback?: string): string {
  const index = process.argv.indexOf(`--${name}`);
  const value = index >= 0 ? process.argv[index + 1] : undefined;
  if (value && !value.startsWith('--')) return value;
  if (fallback) return fallback;
  throw new Error(`缺少 --${name}`);
}

async function main(): Promise<void> {
  const command = process.argv[2];
  const dataDir = resolve(option('data-dir', process.env.DATA_DIR?.trim() || developmentDataDir(import.meta.url)));
  if (command === 'backup') {
    const output = resolve(option('output'));
    const manifest = await createServerBackup(dataDir, output);
    console.log(JSON.stringify({ ok: true, command, output, createdAt: manifest.createdAt, files: manifest.files.length }, null, 2));
    return;
  }
  if (command === 'verify-backup') {
    const backup = resolve(option('backup'));
    const result = await verifyServerBackup(backup);
    console.log(JSON.stringify(result, null, 2));
    if (!result.ok) process.exitCode = 2;
    return;
  }
  if (command === 'restore') {
    const backup = resolve(option('backup'));
    const result = await restoreServerBackup(backup, dataDir);
    console.log(JSON.stringify({ ok: true, command, dataDir, ...result }, null, 2));
    return;
  }
  throw new Error('用法：maintenance <backup|verify-backup|restore> [--data-dir PATH] [--output PATH|--backup PATH]');
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
