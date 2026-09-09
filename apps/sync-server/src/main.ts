import { createSyncServer, type RegistrationMode } from './server.js';
import { rmSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { developmentDataDir } from './runtime-config.js';
import { watchShutdownInput } from './shutdown-input.js';

const port = Number(process.env.PORT ?? 8787);
const host = process.env.HOST?.trim() || '0.0.0.0';
const configuredDataDir = process.env.DATA_DIR?.trim();
const dataDir = configuredDataDir ? resolve(configuredDataDir) : developmentDataDir(import.meta.url);
const positiveNumber = (name: string): number | undefined => {
  const value = Number(process.env[name]);
  return Number.isSafeInteger(value) && value > 0 ? value : undefined;
};
const boolEnv = (name: string, fallback: boolean) => {
  const v = process.env[name];
  if (v === undefined || v === '') return fallback;
  return v !== '0' && v.toLowerCase() !== 'false' && v.toLowerCase() !== 'off';
};
const listEnv = (name: string): string[] | undefined => {
  const values = process.env[name]?.split(',').map((value) => value.trim()).filter(Boolean);
  return values?.length ? values : undefined;
};
const modeEnv = process.env.REGISTRATION_MODE;
const registrationMode: RegistrationMode = modeEnv === 'invite' || modeEnv === 'closed' || modeEnv === 'open' ? modeEnv : 'invite';
const webDir = process.env.WEB_DIST;
const enableWeb = boolEnv('ENABLE_WEB', Boolean(webDir));
const enableSync = boolEnv('ENABLE_SYNC', true);
const basePath = process.env.BASE_PATH?.trim() || undefined;
const service = createSyncServer({
  dataDir,
  commitQuotaBytes: positiveNumber('COMMIT_QUOTA_BYTES'),
  attachmentQuotaBytes: positiveNumber('ATTACHMENT_QUOTA_BYTES'),
  attachmentMaxFileBytes: positiveNumber('ATTACHMENT_MAX_FILE_BYTES'),
  attachmentTrashRetentionMs: positiveNumber('ATTACHMENT_TRASH_RETENTION_MS'),
  secret: process.env.SYNC_SECRET,
  serverId: process.env.SERVER_ID,
  registrationMode,
  enableSync,
  enableWeb,
  webDir,
  basePath,
  trustedProxies: listEnv('TRUSTED_PROXIES'),
  allowInsecureHttp: boolEnv('ALLOW_INSECURE_HTTP', false),
});
const { server, serverId } = service;
await service.ready;
const pidFile = resolve(dataDir, 'server.pid');
writeFileSync(pidFile, JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString(), dataDir }), 'utf8');

server.listen(port, host, () => {
  const bind = host ? `${host}:${port}` : `localhost:${port}`;
  console.log(`zichan server -> http://${bind}  (data directory: ${dataDir})`);
  console.log(`serverId=${serverId} sync=${enableSync ? 'on' : 'off'} web=${enableWeb && webDir ? 'on' : 'off'} registration=${registrationMode} basePath=${basePath || '/'}`);
  console.log(`account-admin=owner-session${webDir ? ` webDir=${webDir}` : ''}`);
  console.log(`First use: open ${basePath || ''}/admin/ and set your administrator username and password.`);
  console.log(`transport=${boolEnv('ALLOW_INSECURE_HTTP', false) ? 'explicit HTTP allowed' : 'HTTPS required outside loopback'} trustedProxies=${listEnv('TRUSTED_PROXIES')?.join(',') || 'none'}`);
  console.log('E2E sync stores encrypted commits and attachment chunks only; the server cannot read ledger contents.');
});

let shutdownPromise: Promise<void> | undefined;
const shutdown = async (signal: string) => {
  shutdownPromise ??= (async () => {
    console.log(`Received ${signal}; closing SQLite and HTTP server...`);
    try {
      await service.close();
    } finally {
      rmSync(pidFile, { force: true });
    }
  })();
  return shutdownPromise;
};
const terminate = (reason: string) => {
  void shutdown(reason).then(
    () => process.exit(0),
    (error) => {
      console.error(error instanceof Error ? error.message : String(error));
      process.exit(1);
    },
  );
};
process.once('SIGINT', () => terminate('SIGINT'));
process.once('SIGTERM', () => terminate('SIGTERM'));
if (boolEnv('CONTROL_STDIN', false)) watchShutdownInput(process.stdin, terminate);
process.once('exit', () => rmSync(pidFile, { force: true }));
