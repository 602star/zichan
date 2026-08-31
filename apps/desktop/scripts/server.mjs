import { existsSync, mkdirSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const syncServerEntry = resolve(here, '../../sync-server/dist/server.mjs');
const defaultWebDist = resolve(here, '../../web/dist');
const dataRoot = process.env.DATA_DIR?.trim()
  ? resolve(process.env.DATA_DIR.trim())
  : resolve(here, '../../../.runtime/sync-server');

mkdirSync(dataRoot, { recursive: true });

process.env.PORT ||= '8787';
process.env.HOST ||= '0.0.0.0';
process.env.DATA_DIR ||= dataRoot;
process.env.WEB_DIST ||= defaultWebDist;
process.env.ENABLE_WEB ||= '1';
process.env.ENABLE_SYNC ||= '1';
process.env.REGISTRATION_MODE ||= 'open';
process.env.ALLOW_INSECURE_HTTP ||= '1';
process.env.CONTROL_STDIN ||= '1';

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

console.log(`Data directory: ${process.env.DATA_DIR}`);
console.log(`Bind: ${process.env.HOST}:${process.env.PORT}`);
console.log(`Base path: ${process.env.BASE_PATH || '/'}`);
console.log('LAN HTTP: enabled for the desktop-hosted server; use HTTPS before exposing it publicly.');

await import(pathToFileURL(syncServerEntry).href);
