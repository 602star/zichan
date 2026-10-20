import { existsSync, mkdirSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const syncServerEntry = resolve(here, '../../sync-server/dist/server.mjs');
const defaultWebDist = resolve(here, '../../web/dist');
const dataRoot = process.env.DATA_DIR?.trim()
  ? resolve(process.env.DATA_DIR.trim())
  : resolve(here, '../../../.runtime/sync-server');

process.env.PORT ||= '8787';
process.env.HOST ||= '0.0.0.0';
process.env.DATA_DIR ||= dataRoot;
process.env.WEB_DIST ||= defaultWebDist;
process.env.ENABLE_WEB ||= '1';
process.env.ENABLE_SYNC ||= '1';
process.env.REGISTRATION_MODE ||= 'invite';
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
console.log(`Registration default: ${process.env.REGISTRATION_MODE}; existing database policy is retained.`);
console.log('Admin console: see the server startup log for the generated security path.');
console.log(process.env.ALLOW_INSECURE_HTTP === '1'
  ? 'Plain HTTP is allowed for LAN clients (ALLOW_INSECURE_HTTP=1). Use it only on trusted private networks.'
  : 'Remote browser and admin access require trusted HTTPS. Bind and transport overrides must be explicit.');

mkdirSync(dataRoot, { recursive: true });

await import(pathToFileURL(syncServerEntry).href);
