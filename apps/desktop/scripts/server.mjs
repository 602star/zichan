import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { randomBytes } from 'node:crypto';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const syncServerEntry = resolve(here, '../../sync-server/dist/server.mjs');
const defaultWebDist = resolve(here, '../../web/dist');
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
process.env.WEB_DIST ||= defaultWebDist;
process.env.ENABLE_WEB ||= '1';
process.env.ENABLE_SYNC ||= '1';
process.env.REGISTRATION_MODE ||= 'invite';
process.env.ALLOW_INSECURE_HTTP ||= '1';

if (!existsSync(syncServerEntry)) {
  console.error(`Missing sync-server build: ${syncServerEntry}`);
  console.error('Run: npm run build --workspace @zichan/sync-server');
  process.exit(1);
}

if (process.env.ENABLE_WEB !== '0' && process.env.ENABLE_WEB?.toLowerCase() !== 'false' && !existsSync(join(process.env.WEB_DIST, 'index.html'))) {
  console.error(`Missing web build: ${process.env.WEB_DIST}`);
  console.error('Run: npm run build --workspace @zichan/web');
  process.exit(1);
}

console.log(`Admin token file: ${adminTokenFile}`);
console.log(`Data directory: ${process.env.DATA_DIR}`);
console.log(`Bind: ${process.env.HOST}:${process.env.PORT}`);
console.log(`Base path: ${process.env.BASE_PATH || '/'}`);
console.log('LAN HTTP: enabled for the desktop-hosted server; use HTTPS before exposing it publicly.');

await import(pathToFileURL(syncServerEntry).href);
