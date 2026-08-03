import { createSyncServer, type RegistrationMode } from './server.js';
import { resolve } from 'node:path';
import { rmSync, writeFileSync } from 'node:fs';

const port = Number(process.env.PORT ?? 8787);
const host = process.env.HOST?.trim();
const dataDir = resolve(process.env.DATA_DIR?.trim() || 'server-data');
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
const registrationMode: RegistrationMode = modeEnv === 'invite' || modeEnv === 'closed' || modeEnv === 'open' ? modeEnv : 'open';
const webDir = process.env.WEB_DIST;
const enableWeb = boolEnv('ENABLE_WEB', Boolean(webDir));
const enableSync = boolEnv('ENABLE_SYNC', true);
const adminToken = process.env.ADMIN_TOKEN?.trim() || undefined;
const basePath = process.env.BASE_PATH?.trim() || undefined;
const service = createSyncServer({
  dataDir,
  commitQuotaBytes: positiveNumber('COMMIT_QUOTA_BYTES'),
  attachmentQuotaBytes: positiveNumber('ATTACHMENT_QUOTA_BYTES'),
  attachmentMaxFileBytes: positiveNumber('ATTACHMENT_MAX_FILE_BYTES'),
  attachmentTrashRetentionMs: positiveNumber('ATTACHMENT_TRASH_RETENTION_MS'),
  secret: process.env.SYNC_SECRET,
  serverId: process.env.SERVER_ID,
  adminToken,
  registrationMode,
  enableSync,
  enableWeb,
  webDir,
  basePath,
  allowedOrigins: listEnv('CORS_ALLOWED_ORIGINS'),
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
  console.log(`admin=${adminToken ? 'on' : 'off'}${webDir ? ` webDir=${webDir}` : ''}`);
  console.log(`transport=${boolEnv('ALLOW_INSECURE_HTTP', false) ? 'explicit HTTP allowed' : 'HTTPS required outside loopback'} trustedProxies=${listEnv('TRUSTED_PROXIES')?.join(',') || 'none'}`);
  console.log('E2E sync stores encrypted commits and attachment chunks only; the server cannot read ledger contents.');
});

let stopping = false;
const shutdown = async (signal: string) => {
  if (stopping) return;
  stopping = true;
  console.log(`Received ${signal}; closing SQLite and HTTP server...`);
  try {
    await service.close();
  } finally {
    rmSync(pidFile, { force: true });
  }
};
process.once('SIGINT', () => void shutdown('SIGINT').then(() => process.exit(0)));
process.once('SIGTERM', () => void shutdown('SIGTERM').then(() => process.exit(0)));
process.once('exit', () => rmSync(pidFile, { force: true }));
