import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { randomBytes } from 'node:crypto';

const appDataRoot = process.env.DATA_DIR
  ? resolve(process.env.DATA_DIR)
  : process.env.APPDATA
      ? join(process.env.APPDATA, 'ZichanLedger', 'server')
      : process.env.XDG_DATA_HOME
        ? join(process.env.XDG_DATA_HOME, 'zichan-ledger', 'server')
        : join(process.env.HOME ?? process.cwd(), '.zichan-ledger', 'server');

mkdirSync(appDataRoot, { recursive: true });
const adminTokenFile = join(appDataRoot, 'admin-token.txt');
if (!process.env.ADMIN_TOKEN) {
  if (!existsSync(adminTokenFile)) writeFileSync(adminTokenFile, randomBytes(24).toString('base64url'));
  process.env.ADMIN_TOKEN = readFileSync(adminTokenFile, 'utf8').trim();
}

process.env.PORT ||= '8787';
process.env.HOST ||= '0.0.0.0';
process.env.DATA_DIR ||= appDataRoot;
process.env.WEB_DIST ||= join(process.cwd(), 'web');
process.env.ENABLE_WEB ||= '1';
process.env.ENABLE_SYNC ||= '1';
process.env.REGISTRATION_MODE ||= 'invite';
process.env.ALLOW_INSECURE_HTTP ||= '1';

await import('../../sync-server/src/main.ts');
