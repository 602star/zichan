import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { requireExplicitDataDir } from '../../sync-server/src/runtime-config.js';

const here = dirname(fileURLToPath(import.meta.url));
const dataDir = requireExplicitDataDir(process.env.DATA_DIR, resolve(here, '..', 'data', 'server'));

process.env.PORT ||= '8787';
process.env.HOST ||= '0.0.0.0';
process.env.DATA_DIR = dataDir;
process.env.WEB_DIST = join(here, 'web');
process.env.ENABLE_WEB ||= '1';
process.env.ENABLE_SYNC ||= '1';
process.env.REGISTRATION_MODE ||= 'invite';
process.env.ALLOW_INSECURE_HTTP ||= '1';
process.env.CONTROL_STDIN ||= '1';

await import('../../sync-server/src/main.ts');
