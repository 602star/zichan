import { createSyncServer, type RegistrationMode } from './server.js';
import { rmSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { developmentDataDir } from './runtime-config.js';
import { watchShutdownInput } from './shutdown-input.js';
import { runBackupSupervisor } from './backup-supervisor.js';
import { assertNoPendingLocalReplicaRetirement } from './replica-retirement-guard.js';

/**
 * Invalid configuration stops the boot with a named error. Silently substituting a
 * default is how a deployment ends up running a policy nobody selected.
 */
const invalid = (name: string, value: string, expected: string): string =>
  `${name} 取值无效：${value || '(空)'}；期望 ${expected}。已拒绝启动，不会静默回退默认值`;

const enumEnv = <T extends string>(name: string, allowed: readonly T[], fallback: T): T => {
  const raw = process.env[name]?.trim();
  if (raw === undefined || raw === '') return fallback;
  if (!(allowed as readonly string[]).includes(raw)) throw new Error(invalid(name, raw, allowed.join(' / ')));
  return raw as T;
};

const positiveNumber = (name: string): number | undefined => {
  const raw = process.env[name]?.trim();
  if (raw === undefined || raw === '') return undefined;
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value <= 0) throw new Error(invalid(name, raw, '正整数'));
  return value;
};

const BOOLEAN_VALUES: Record<string, boolean> = {
  '1': true, '0': false, 'true': true, 'false': false, 'on': true, 'off': false, 'yes': true, 'no': false,
};

const boolEnv = (name: string, fallback: boolean): boolean => {
  const raw = process.env[name]?.trim().toLowerCase();
  if (raw === undefined || raw === '') return fallback;
  const parsed = BOOLEAN_VALUES[raw];
  if (parsed === undefined) throw new Error(invalid(name, raw, '1/0、true/false、on/off、yes/no'));
  return parsed;
};

const portEnv = (): number => {
  const raw = process.env.PORT?.trim();
  if (raw === undefined || raw === '') return 8787;
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < 0 || value > 65_535) throw new Error(invalid('PORT', raw, '0–65535'));
  return value;
};

const port = portEnv();
const host = process.env.HOST?.trim() || '0.0.0.0';
const configuredDataDir = process.env.DATA_DIR?.trim();
const dataDir = configuredDataDir ? resolve(configuredDataDir) : developmentDataDir(import.meta.url);
assertNoPendingLocalReplicaRetirement(dataDir);
const listEnv = (name: string): string[] | undefined => {
  const values = process.env[name]?.split(',').map((value) => value.trim()).filter(Boolean);
  return values?.length ? values : undefined;
};
const registrationMode: RegistrationMode = enumEnv('REGISTRATION_MODE', ['invite', 'closed', 'open'] as const, 'invite');
const webDir = process.env.WEB_DIST;
const enableWeb = boolEnv('ENABLE_WEB', Boolean(webDir));
const enableSync = boolEnv('ENABLE_SYNC', true);
const basePath = process.env.BASE_PATH?.trim() || undefined;
if (process.env.ZICHAN_SERVER_WORKER !== '1') {
  await runBackupSupervisor(import.meta.url, dataDir, webDir, boolEnv('CONTROL_STDIN', false));
  process.exit(0);
}
const service = createSyncServer({
  custodyKeyPath: process.env.CUSTODY_KEY_PATH?.trim() || undefined,
  dataDir,
  commitQuotaBytes: positiveNumber('COMMIT_QUOTA_BYTES'),
  attachmentQuotaBytes: positiveNumber('ATTACHMENT_QUOTA_BYTES'),
  attachmentMaxFileBytes: positiveNumber('ATTACHMENT_MAX_FILE_BYTES'),
  attachmentTrashRetentionMs: positiveNumber('ATTACHMENT_TRASH_RETENTION_MS'),
  secret: process.env.SYNC_SECRET?.trim() || undefined,
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
// Recovery, deployment-record import and settings validation must succeed before serving.
await service.started;
const pidFile = resolve(dataDir, 'server.pid');
writeFileSync(pidFile, JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString(), dataDir }), 'utf8');

server.listen(port, host, () => {
  const reportPlan = () => { void service.backupPlan().then((backupPlan) => {
    if (process.connected) process.send?.({ backupPlan }, () => undefined);
  }).catch((error: unknown) => console.error('Backup plan unavailable:', error)); };
  reportPlan();
  const reportTimer = setInterval(reportPlan, 5_000); reportTimer.unref();
  const bind = host ? `${host}:${port}` : `localhost:${port}`;
  console.log(`zichan server -> http://${bind}  (data directory: ${dataDir})`);
  console.log(`serverId=${serverId} sync=${enableSync ? 'on' : 'off'} web=${enableWeb && webDir ? 'on' : 'off'} registration=${registrationMode} basePath=${basePath || '/'}`);
  console.log(`account-admin=owner-session${webDir ? ` webDir=${webDir}` : ''}`);
  console.log(`Admin console path: ${basePath || ''}${service.adminAccessPath() ? `/${service.adminAccessPath()}` : ''}/admin/`);
  console.log('First use: open the admin console address above and set your administrator username and password.');
  console.log(`transport=${boolEnv('ALLOW_INSECURE_HTTP', false) ? 'explicit HTTP allowed' : 'HTTPS required outside loopback'} trustedProxies=${listEnv('TRUSTED_PROXIES')?.join(',') || 'none'}`);
  console.log('Ledger payloads are encrypted. Authorized servers hold the keys needed to open managed ledgers.');
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
process.once('disconnect', () => terminate('supervisor disconnected'));
if (boolEnv('CONTROL_STDIN', false)) watchShutdownInput(process.stdin, terminate);
process.once('exit', () => rmSync(pidFile, { force: true }));
