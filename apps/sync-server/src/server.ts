/** Encrypted sync storage with optional account key custody and transactional SQLite WAL. */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { createHash, createHmac, randomBytes, randomInt, timingSafeEqual } from 'node:crypto';
import { existsSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { extname, join, resolve, sep } from 'node:path';
import * as opaque from '@serenity-kit/opaque';
import { normalizeSyncUsername, createLedgerKeyEnvelope, unlockLedgerKeyEnvelope, newId, PLAIN_HTTP_HOST_ALLOWLIST,
  type LedgerKeyEnvelope } from '@zichan/core';
import { loadCustodyKey, sealCustodySecret, openCustodySecret } from './key-custody.js';
import { loadNodeIdentity, verifyNodeSignature, type NodeIdentity } from './node-identity.js';
import { signNodeResponse, verifyNodeRequest, type NodeRequestProof } from './node-request-auth.js';
import { confirmPeerGrantRevocation, createNodeReplicationWorker, normalizeNodePeerUrl, probeNodePeer, signedCall,
  verifyNodeReplicaInventory } from './node-replication.js';
import { assessReplicaReadiness } from './replica-readiness.js';
import { assessForwardedReplicaGroupHealth, assessReplicaGroupHealth, assessReplicaGroupMember,
  buildReplicaGroupDirectory,
  parseNodeReplicaGroupSnapshot, parseNodeReplicaHealthReport } from './replica-group-health.js';
import { createFederatedLoginIntent, decodeFederatedLoginIntent, encodeFederatedLoginIntent,
  verifyFederatedLoginIntent } from './federated-login.js';
import { parseFederatedCredential, signFederatedCredential, verifyFederatedCredential } from './federated-credential.js';
import { createGroupReconciler } from './group-replication.js';
import { LedgerPreviewRegistry } from './ledger-preview.js';
import { EncryptedBlobStore, type BlobReplicaState } from './blob-store.js';
import { assertNoPendingLocalReplicaRetirement } from './replica-retirement-guard.js';
import { decodeBlobPack, encodeBlobPack, MAX_BLOB_PACK_CHUNK_BYTES, MAX_BLOB_PACK_OBJECTS } from './blob-pack.js';
import { createAdminRouter } from './admin.js';
import { createSystemMonitor } from './system-monitor.js';
import { createRequestOrigin } from './request-origin.js';
import { createBrowserSessionCookies } from './browser-session.js';
import {
  ADMIN_BODY_BYTES,
  AUTH_BODY_BYTES,
  MAX_BODY_BYTES,
  bearerToken,
  errorCode,
  errorStatus,
  headerValue,
  isRecord,
  syncEventCategory,
  clientIdentity,
  readBinaryBody,
  readBody,
  send,
  sendBinary,
} from './http-util.js';
import { createJobHandlers } from './job-handlers.js';
import { createJobRunner } from './jobs.js';
import { createHashOffload } from './hash-offload.js';
import { parseAlertChannels, type EmailChannel } from './alert-channels.js';
import { sendEmail } from './smtp-client.js';
import { importMaintenanceRecords } from './maintenance-records.js';
import { MAINTENANCE_KEY, createWriteTracker, isClientWrite, resolveMaintenance, type MaintenanceState } from './maintenance-mode.js';
import { createMetricsService } from './metrics.js';
import { createSettings } from './settings.js';
import { createMfaService } from './mfa.js';
import {
  ServerStoreError,
  SyncServerStore,
  FEDERATED_ONLY_RECORD,
  type JsonRecord,
  type NodeReplicationLink,
  type RegistrationMode,
  type ServerLog,
  type StoredCommit,
  type SyncSession,
} from './store.js';

export type { RegistrationMode } from './store.js';

const ACCESS_TOKEN_TTL_MS = 15 * 60 * 1000;
const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const OPAQUE_LOGIN_TTL_MS = 60 * 1000;
const OPAQUE_REGISTRATION_TTL_MS = 5 * 60 * 1000;
const REQUEST_ID_BYTES = 8;

function nowIso(): string {
  return new Date().toISOString();
}

function isLedgerKeyEnvelope(value: unknown): value is JsonRecord {
  if (!isRecord(value)) return false;
  return value.v === 1 && value.kdf === 'argon2id'
    && typeof value.ledgerId === 'string' && /^[A-Za-z0-9_-]{16,128}$/.test(value.ledgerId)
    && typeof value.keyringId === 'string' && /^[A-Za-z0-9_-]{16,160}$/.test(value.keyringId)
    && Number.isSafeInteger(value.generation) && Number(value.generation) >= 1
    && Number.isSafeInteger(value.memoryKiB) && Number(value.memoryKiB) >= 16 * 1024 && Number(value.memoryKiB) <= 256 * 1024
    && Number.isSafeInteger(value.iterations) && Number(value.iterations) >= 1 && Number(value.iterations) <= 20
    && Number.isSafeInteger(value.parallelism) && Number(value.parallelism) >= 1 && Number(value.parallelism) <= 8
    && typeof value.salt === 'string' && value.salt.length <= 256
    && typeof value.iv === 'string' && value.iv.length <= 256
    && typeof value.ct === 'string' && value.ct.length <= 256 * 1024;
}

/** The Web root must never contain the data directory: backups and keys live there. */
function assertSeparateDirectories(dataDir: string, webDir: string): void {
  const inside = (parent: string, child: string) => child !== parent && child.startsWith(parent.endsWith(sep) ? parent : `${parent}${sep}`);
  if (inside(dataDir, webDir) || inside(webDir, dataDir)) {
    throw new Error('WEB_DIST 与服务器数据目录不能互相包含：备份与认证密钥文件不能通过 Web 静态服务暴露');
  }
}

declare const __ZICHAN_SERVER_VERSION__: string | undefined;

function readServerVersion(): string {
  if (typeof __ZICHAN_SERVER_VERSION__ === 'string' && __ZICHAN_SERVER_VERSION__) return __ZICHAN_SERVER_VERSION__;
  try {
    const value = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as { version?: string };
    return typeof value.version === 'string' && value.version ? value.version : 'dev';
  } catch {
    return 'dev';
  }
}

function normalizeBasePath(raw?: string): string {
  const value = (raw ?? '').trim();
  if (!value || value === '/') return '';
  return (value.startsWith('/') ? value : `/${value}`).replace(/\/+$/, '');
}

function initialEncryptedCommits(value: unknown, ledgerId: string, allowEmpty = false): Omit<StoredCommit, 'seq' | 'cipherBytes' | 'createdAt'>[] {
  if (!Array.isArray(value) || !allowEmpty && !value.length || value.length > 100) throw new ServerStoreError('INVALID_COMMIT', 400, 'initial encrypted commits required');
  const ids = new Set<string>();
  return value.map((row) => {
    if (!isRecord(row) || typeof row.commitId !== 'string' || !/^[A-Za-z0-9_-]{16,160}$/.test(row.commitId) || row.ledgerId !== ledgerId || typeof row.contentHash !== 'string' || !/^[a-f0-9]{64}$/.test(row.contentHash) || !isRecord(row.encCommit) || row.encCommit.v !== 3 || typeof row.encCommit.keyId !== 'string' || !/^[A-Za-z0-9_-]{16,160}$/.test(row.encCommit.keyId) || typeof row.encCommit.iv !== 'string' || typeof row.encCommit.ct !== 'string' || row.encCommit.iv.length > 256 || row.encCommit.ct.length > MAX_BODY_BYTES || ids.has(row.commitId)) {
      throw new ServerStoreError('INVALID_COMMIT', 400, 'invalid initial encrypted commit');
    }
    ids.add(row.commitId);
    return { commitId: row.commitId, ledgerId, contentHash: row.contentHash, encCommit: row.encCommit };
  });
}

function stripBasePath(path: string, basePath: string): string | null {
  if (!basePath) return path;
  if (path === basePath) return '/';
  return path.startsWith(`${basePath}/`) ? path.slice(basePath.length) || '/' : null;
}

function decodePathname(path: string): string {
  try { return decodeURIComponent(path); } catch { return path; }
}

function signToken(secret: string, payload: JsonRecord): string {
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const signature = createHmac('sha256', secret).update(body).digest('base64url');
  return `${body}.${signature}`;
}

interface TokenClaims {
  displayName?: string;
  claimOwner?: boolean;
  ownerSetupOrigin?: string;
  passwordResetHash?: string;
  username?: string;
  sessionId?: string;
  replicaId?: string | null;
  purpose?: string;
  inviteCode?: string;
  exp?: number;
}

function verifyToken(secret: string, token: string): TokenClaims | null {
  const [body, signature] = token.split('.');
  if (!body || !signature) return null;
  const expected = createHmac('sha256', secret).update(body).digest('base64url');
  if (!safeEqual(signature, expected)) return null;
  try {
    const claims = JSON.parse(Buffer.from(body, 'base64url').toString()) as TokenClaims;
    return claims.exp && Date.now() > claims.exp ? null : claims;
  } catch {
    return null;
  }
}

function safeEqual(left: string, right: string): boolean {
  const a = Buffer.from(left);
  const b = Buffer.from(right);
  return a.length === b.length && timingSafeEqual(a, b);
}

function opaqueHash(secret: string, value: string): string {
  return createHmac('sha256', secret).update(value).digest('base64');
}






function applyCors(req: IncomingMessage, res: ServerResponse): void {
  const origin = headerValue(req, 'origin');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'no-referrer');
  if (!origin) return;
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,PUT,DELETE,HEAD,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type,Authorization,X-Zichan-Client');
  res.setHeader('Access-Control-Max-Age', '600');
}


const REQUIRED_IDENTITY_FILES = ['server.secret', 'server-id', 'opaque.server-setup'] as const;

function readPersistedValue(path: string, name: string): string {
  const persisted = readFileSync(path, 'utf8').trim();
  if (!persisted) throw new Error(`同步服务器身份文件 ${name} 为空，拒绝自动重建`);
  return persisted;
}

function assertServerIdentityComplete(dataDir: string | undefined): void {
  if (!dataDir || !existsSync(dataDir)) return;
  if (!statSync(dataDir).isDirectory()) throw new Error(`同步服务器数据路径不是目录：${dataDir}`);
  const entries = readdirSync(dataDir).filter((name) => name !== 'backup-executor.lock');
  if (!entries.length) return;

  const missing: string[] = REQUIRED_IDENTITY_FILES.filter((name) => !existsSync(join(dataDir, name)));
  const database = join(dataDir, 'server.sqlite');
  if (!existsSync(database)) missing.unshift('server.sqlite');
  if (missing.length) {
    throw new Error(`同步服务器数据目录不完整，缺少 ${missing.join('、')}；为保护现有身份，拒绝自动重建`);
  }
  if (!statSync(database).isFile() || statSync(database).size === 0) {
    throw new Error('同步服务器数据库为空或不是文件；为保护现有身份，拒绝自动重建');
  }
  for (const name of REQUIRED_IDENTITY_FILES) readPersistedValue(join(dataDir, name), name);
}

function loadPersistedValue(dataDir: string, name: string, provided: string | undefined, create: () => string): string {
  const path = join(dataDir, name);
  const configured = provided?.trim();
  if (existsSync(path)) {
    const persisted = readPersistedValue(path, name);
    if (configured && configured !== persisted) throw new Error(`${name} 与现有服务器数据目录不匹配`);
    return persisted;
  }
  const value = configured || create();
  if (!value.trim()) throw new Error(`${name} 不能是空值`);
  try {
    writeFileSync(path, value, { mode: 0o600, flag: 'wx' });
    return value;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    const persisted = readPersistedValue(path, name);
    if (configured && configured !== persisted) throw new Error(`${name} 与并发创建的服务器身份不匹配`);
    return persisted;
  }
}

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg', '.ico': 'image/x-icon', '.wasm': 'application/wasm', '.woff': 'font/woff', '.woff2': 'font/woff2',
};

function fileIfExists(file: string): string | undefined {
  try {
    const stats = statSync(file);
    if (stats.isFile()) return file;
    if (stats.isDirectory()) {
      const index = join(file, 'index.html');
      return statSync(index).isFile() ? index : undefined;
    }
  } catch { return undefined; }
  return undefined;
}

function safeResolve(root: string, path: string): string | null {
  let decoded: string;
  try { decoded = decodeURIComponent(path); } catch { return null; }
  const target = resolve(root, decoded.replace(/^\/+/, ''));
  const prefix = root.endsWith(sep) ? root : `${root}${sep}`;
  return target === root || target.startsWith(prefix) ? target : null;
}

/**
 * CSP for the hosted web app.
 *
 * `connect-src` gates every sync request a second time, in the browser, after
 * `assertSecureSyncUrl` has already run. Loopback HTTP is listed explicitly
 * because the LAN path legitimately syncs to a plain-HTTP address over there;
 * `https:` stays open for public deployments.
 *
 * The reviewed plain-HTTP hosts have to be spliced in from the shared list.
 * Without them the app gate admits an address and the browser then refuses the
 * fetch, which surfaces as an unexplained connection failure. A port wildcard is
 * used because the deployment picks its own port and the host is already an
 * explicit plaintext exception.
 */
const CONNECT_SRC = [
  "'self'",
  'https:',
  'http://localhost:*',
  'http://127.0.0.1:*',
  'http://[::1]:*',
  ...PLAIN_HTTP_HOST_ALLOWLIST.map((host) => `http://${host}:*`),
].join(' ');

function webAppCsp(allowInsecureHttp: boolean): string {
  return [
    "default-src 'self'",
    // A local HTTP deployment may connect to any RFC1918 address chosen in the
    // browser. CSP cannot express IP ranges; transport-policy still rejects
    // unapproved public HTTP destinations before credentials are sent.
    `connect-src ${CONNECT_SRC}${allowInsecureHttp ? ' http:' : ''}`,
    "img-src 'self' blob: data:",
    "style-src 'self' 'unsafe-inline'",
    "script-src 'self' 'wasm-unsafe-eval'",
    "font-src 'self' data:",
    "worker-src 'self' blob:",
    "object-src 'none'",
    "base-uri 'self'",
    "form-action 'self'",
    "frame-ancestors 'none'",
  ].join('; ');
}

function serveWeb(req: IncomingMessage, res: ServerResponse, path: string, webDir?: string,
  allowInsecureHttp = false): boolean {
  if (!webDir || (req.method !== 'GET' && req.method !== 'HEAD')) return false;
  if (path === '/api' || path.startsWith('/api/')) return false;
  if (path === '/app' || path.startsWith('/app/')) return false;
  const root = resolve(webDir);
  const staticPath = path === '/admin' || path === '/admin/' ? '/'
    : path.startsWith('/admin/') ? path.slice(6) : path;
  const target = safeResolve(root, staticPath);
  if (!target) { res.writeHead(403); res.end('forbidden'); return true; }
  let file = fileIfExists(target);
  if (!file && extname(target) === '') file = fileIfExists(join(root, 'index.html'));
  if (!file) { res.writeHead(404); res.end('not found'); return true; }
  res.writeHead(200, {
    'Content-Type': MIME[extname(file).toLowerCase()] ?? 'application/octet-stream',
    'Cache-Control': file.endsWith('index.html') || file.endsWith('sw.js') ? 'no-cache' : 'public, max-age=31536000, immutable',
    'Content-Security-Policy': webAppCsp(allowInsecureHttp),
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'no-referrer',
  });
  if (req.method === 'HEAD') res.end(); else res.end(readFileSync(file));
  return true;
}


export interface SyncServerOptions {
  /** Explicit deployment policy; a same-origin address is not an official-server identity. */
  custodyKeyPath?: string;
  /** Deployment-only secret. Never include it in health, logs or connection links. */
  ownerSetupToken?: string;
  dataDir?: string;
  attachmentQuotaBytes?: number;
  attachmentMaxFileBytes?: number;
  attachmentTrashRetentionMs?: number;
  commitQuotaBytes?: number;
  secret?: string;
  serverId?: string;
  opaqueServerSetup?: string;
  registrationMode?: RegistrationMode;
  enableSync?: boolean;
  webDir?: string;
  enableWeb?: boolean;
  basePath?: string;
  trustedProxies?: string[];
  /** Header overwritten by the trusted edge with an ISO 3166-1 alpha-2 country code. */
  trafficCountryHeader?: string;
  allowInsecureHttp?: boolean;
  /** Injectable delivery for integration tests; deployments use the configured SMTP channel. */
  accountEmailSender?: (to: string, subject: string, body: string) => Promise<void>;
}

export interface SyncServer {
  backupPlan: () => Promise<import('./backup-executor.js').BackupPlan>;
  adminAccessPath: () => string;
  server: Server;
  serverId: string;
  dataDir: string;
  ready: Promise<void>;
  /** Resolves once recovery, record import and sampling have started. */
  started: Promise<void>;
  /** Drain pending account mail immediately; the background worker also runs every minute. */
  flushAccountEmails: () => Promise<void>;
  /** Run one outbound node replication pass immediately. */
  flushNodeReplication: () => Promise<void>;
  flushGroupReplication: () => Promise<void>;
  close: () => Promise<void>;
}

export function createSyncServer(options: SyncServerOptions = {}): SyncServer {
  const enableSync = options.enableSync !== false;
  const enableWeb = options.enableWeb ?? Boolean(options.webDir);
  const basePath = normalizeBasePath(options.basePath);
  const trustedProxies = options.trustedProxies ?? [];
  if (options.trafficCountryHeader && !/^(?:x-[a-z0-9-]+|cf-ipcountry)$/i.test(options.trafficCountryHeader)) {
    throw new Error('TRAFFIC_COUNTRY_HEADER must be a dedicated proxy header');
  }
  const allowInsecureHttp = options.allowInsecureHttp === true;
  const origin = createRequestOrigin(trustedProxies, allowInsecureHttp);
  const browserSession = createBrowserSessionCookies(basePath, origin.browserOrigin);
  const requestedDataDir = options.dataDir ? resolve(options.dataDir) : undefined;
  if (requestedDataDir) assertNoPendingLocalReplicaRetirement(requestedDataDir);
  assertServerIdentityComplete(requestedDataDir);
  let store: SyncServerStore;
  const blobStore = new EncryptedBlobStore({
    dataDir: requestedDataDir,
    enforceFreshServerSchema: true,
    quotaBytes: options.attachmentQuotaBytes,
    maxBlobBytes: options.attachmentMaxFileBytes,
    trashRetentionMs: options.attachmentTrashRetentionMs,
    isUnlimitedAccount: async (username) => {
      const role = await store.roleForUser(username);
      return role === 'owner' || role === 'admin';
    },
  });
  const dataDir = blobStore.dataDir;
  if (enableWeb && options.webDir) assertSeparateDirectories(dataDir, resolve(options.webDir));
  const startedAt = Date.now();
  const serverVersion = readServerVersion();
  const secret = loadPersistedValue(dataDir, 'server.secret', options.secret, () => randomBytes(32).toString('hex'));
  const ownerSetupToken = loadPersistedValue(dataDir, 'owner-setup.secret', options.ownerSetupToken, () => randomBytes(32).toString('hex'));
  if (ownerSetupToken.length < 32) throw new Error('owner-setup.secret must contain at least 32 characters');
  const serverId = loadPersistedValue(dataDir, 'server-id', options.serverId, () => `srv-${randomBytes(8).toString('hex')}`);
  blobStore.setReplicationNodeId(serverId);
  // Both stores use separate SQLite connections to the same file. Initialize
  // them in sequence so catalog recovery cannot hold a write transaction while
  // the server schema connection synchronously waits for that lock.
  store = new SyncServerStore(
    join(dataDir, 'server.sqlite'),
    options.registrationMode ?? 'invite',
    serverId,
    options.commitQuotaBytes,
    blobStore.ready,
    options.attachmentQuotaBytes,
  );
  blobStore.setReplicaIdResolver(async (username, ledgerId) => {
    const replica = await store.getReplicaForLedger(username, ledgerId);
    if (!replica) {
      throw new ServerStoreError('REPLICA_UNBOUND', 409, 'bind this ledger before uploading an attachment');
    }
    return replica.replicaId;
  });
  const custodyEnabled = true;
  const defaultProtection = 'managed';
  let custodyKey: Buffer;
  let opaqueServerSetup = '';
  let opaqueServerPublicKey = '';
  let nodePublicKey = '';
  let nodeIdentity: NodeIdentity;
  const ready = Promise.all([blobStore.ready, store.ready, opaque.ready]).then(async () => {
    nodeIdentity = loadNodeIdentity(dataDir, serverId, await store.nodePublicKey());
    await store.bindNodePublicKey(nodeIdentity.publicKey);
    nodePublicKey = nodeIdentity.publicKey;
    custodyKey = loadCustodyKey(options.custodyKeyPath ?? join(dataDir, 'custody.key'), await store.hasCustodySecrets());
    opaqueServerSetup = loadPersistedValue(
      dataDir,
      'opaque.server-setup',
      options.opaqueServerSetup,
      () => opaque.server.createSetup(),
    );
    opaqueServerPublicKey = opaque.server.getPublicKey(opaqueServerSetup);
  });
  const nodeReplication = createNodeReplicationWorker(store, blobStore, () => nodeIdentity,
    async (link, mode, secretValue) => {
      const binding = await store.federatedAccount(link.username);
      const user = await store.getUser(link.username);
      if (!binding || !user) {
        throw new Error('副本账号身份已改变，拒绝导入账本保护资料');
      }
      let sealed: string | null = null;
      if (mode === 'managed') {
        if (!secretValue) throw new Error('同步账本缺少托管密钥');
        const envelope = await store.getKeyEnvelope(link.username, link.ledgerId, 'node');
        if (!envelope) throw new Error('账本密钥包尚未复制，拒绝导入托管密钥');
        await unlockLedgerKeyEnvelope(secretValue, envelope as unknown as LedgerKeyEnvelope);
        const scope = `${serverId}:${user.accountId}`;
        const current = await store.getLedgerProtection(link.username);
        if (current?.mode === 'managed' && current.sealedSecret) {
          try {
            if (openCustodySecret(custodyKey, scope, current.sealedSecret) === secretValue) {
              sealed = current.sealedSecret;
            }
          } catch { /* Replace a stale local seal only after checking the replicated envelope. */ }
        }
        sealed ??= sealCustodySecret(custodyKey, scope, secretValue);
      }
      await store.importFederatedLedgerProtection(link.username, binding.issuerNodeId,
        link.ledgerId, mode, sealed!);
    });
  const groupReconciler = createGroupReconciler(store, () => nodeIdentity, () => opaqueServerSetup,
    async (username, accountId) => {
      const protection = await store.getLedgerProtection(username);
      if (protection?.mode !== 'managed') return null;
      if (!protection.sealedSecret) throw new Error('本站托管账本没有可复制的密钥');
      return { mode: 'managed', secret: openCustodySecret(custodyKey,
        `${serverId}:${accountId}`, protection.sealedSecret) };
    });
  const nodeReplicationTimer = setInterval(() => {
    void ready.then(() => Promise.allSettled([groupReconciler.run(), nodeReplication.run()])).catch(() => undefined);
  }, 10_000);
  const ledgerPreview = new LedgerPreviewRegistry({
        store,
        serverId,
        custodyKey: () => custodyKey,
        // Attachments live in the blob store, not in the commit log: the preview can list them
        // from the backup but needs these two to actually open one.
        readManifest: async ({ username, ledgerId, blobId }) =>
          blobStore.manifest(username, ledgerId, blobId),
        readChunk: async ({ username, ledgerId, blobId, index }) =>
          blobStore.chunk(username, ledgerId, blobId, index),
      });
  const log = async (level: ServerLog['level'], action: string, message: string, meta: Omit<ServerLog, 'id' | 'at' | 'level' | 'action' | 'message'> = {}) => {
    await store.appendLog({ id: randomBytes(12).toString('hex'), at: nowIso(), level, action, message, ...meta });
  };
  // The bucket key stays the primary key; `scope`/`source` are recorded alongside it so the
  // console can show what is being throttled without parsing the key (an IPv6 source contains
  // colons, so splitting on them would attribute the bucket to the wrong address).
  const allow = (ip: string, bucket: string, limit: number, windowMs: number) =>
    store.takeRateLimit(`${ip}:${bucket}`, limit, windowMs, bucket, ip);
  blobStore.onCleanupResult = (status) => {
    void log(status.lastOk ? 'info' : 'error', 'blob_cleanup', status.lastOk
      ? 'Scheduled attachment cleanup completed'
      : 'Scheduled attachment cleanup failed', {
      detail: {
        removedObjects: status.lastRemovedObjects,
        removedUploads: status.lastRemovedUploads,
        freedBytes: status.lastFreedBytes,
        consecutiveFailures: status.consecutiveFailures,
        error: status.lastError ?? null,
      },
    }).catch(() => undefined);
  };
  const publicSession = (session: Awaited<ReturnType<typeof store.getSession>>) => session ? {
    id: session.id,
    username: session.username,
    deviceId: session.deviceId,
    deviceName: session.deviceName,
    createdAt: session.createdAt,
    updatedAt: session.updatedAt,
    expiresAt: session.expiresAt,
    lastSeenAt: session.lastSeenAt,
    lastIp: session.lastIp ?? null,
    revokedAt: session.revokedAt ?? null,
    replicaId: session.replicaId ?? null,
    active: !session.revokedAt && session.expiresAt > nowIso(),
  } : undefined;
  const issueAccessToken = (session: SyncSession) => {
    const expiresAtMs = Date.now() + ACCESS_TOKEN_TTL_MS;
    return {
      accessToken: signToken(secret, { username: session.username, sessionId: session.id,
        replicaId: session.replicaId ?? null,
        exp: expiresAtMs }),
      accessExpiresAt: new Date(expiresAtMs).toISOString(),
    };
  };
  const createRefreshToken = (sessionId: string) => `${sessionId}.${randomBytes(32).toString('base64url')}`;

  const authenticateRequest = async (req: IncomingMessage) => {
    const claims = verifyToken(secret, bearerToken(req));
    const user = claims?.username ? await store.getUser(claims.username) : undefined;
    const session = claims?.sessionId ? await store.getSession(claims.sessionId) : undefined;
    if (!user || user.disabled || !session || session.username !== user.username
      || session.revokedAt || session.expiresAt <= nowIso()
      || claims?.replicaId != null && claims.replicaId !== session.replicaId) return undefined;
    return { user, session, role: await store.roleForUser(user.username) };
  };

  const runtimeSettings = createSettings(store, process.env, {
    defaults: {
      ...(options.commitQuotaBytes === undefined ? {} : { defaultCommitQuotaBytes: options.commitQuotaBytes }),
      ...(options.attachmentQuotaBytes === undefined ? {} : { defaultBlobQuotaBytes: options.attachmentQuotaBytes }),
      ...(options.attachmentMaxFileBytes === undefined ? {} : { attachmentMaxFileBytes: options.attachmentMaxFileBytes }),
      ...(options.attachmentTrashRetentionMs === undefined ? {} : { attachmentTrashRetentionMs: options.attachmentTrashRetentionMs }),
    },
    onChange: (values) => {
      store.setDefaultQuotas(Number(values['defaultCommitQuotaBytes']), Number(values['defaultBlobQuotaBytes']));
      blobStore.setStoragePolicy(Number(values['defaultBlobQuotaBytes']), Number(values['attachmentMaxFileBytes']),
        Number(values['attachmentTrashRetentionMs']));
    },
  });
  const settings = runtimeSettings.settings;
  store.setLogRetentionProvider(() => Number(settings.effective('logRetention')));
  const accountEmailChannel = (): EmailChannel | undefined => parseAlertChannels(settings.effective('alertChannels'))
    .find((channel): channel is EmailChannel => channel.kind === 'email' && channel.enabled);
  const accountEmailAvailable = (): boolean => {
    if (options.accountEmailSender) return true;
    try { return Boolean(accountEmailChannel()); } catch { return false; }
  };
  const sendAccountMessage = async (to: string, subject: string, body: string): Promise<void> => {
    if (options.accountEmailSender) return options.accountEmailSender(to, subject, body);
    const channel = accountEmailChannel();
    if (!channel) throw new Error('服务器尚未配置邮件发送渠道');
    await sendEmail({ ...channel, requireTls: true }, { to: [to], subject, body });
  };

  /**
   * Maintenance mode is read per request rather than cached: the flag is written from the admin
   * router in this same process, and a cached "off" would keep letting writes in after an operator
   * declared a window. It is a single indexed primary-key read on the request path.
   */
  const maintenanceState = async (): Promise<MaintenanceState | undefined> => {
    const raw = await store.maintenanceState(MAINTENANCE_KEY);
    if (!raw) return undefined;
    return {
      enabled: raw['enabled'] === true,
      message: typeof raw['message'] === 'string' ? raw['message'] : '',
      until: typeof raw['until'] === 'string' ? raw['until'] : null,
      startedAt: typeof raw['startedAt'] === 'string' ? raw['startedAt'] : null,
      startedBy: typeof raw['startedBy'] === 'string' ? raw['startedBy'] : null,
    };
  };
  const maintenance = { read: maintenanceState };
  const writeTracker = createWriteTracker();

  const mfa = createMfaService({ store, serverSecret: secret });
  /** MFA is required for management console logins when the deployment asks for it. */
  const requireAdminMfa = (): boolean => String(settings.effective('requireAdminMfa')) === 'on';
  const ledgerWebAccess = async (): Promise<boolean> => {
    await runtimeSettings.load();
    return String(settings.effective('ledgerWebAccess')) === 'on';
  };

  /**
   * Issues the session once every factor is satisfied. Both login paths end here: the only
   * difference between them is how they proved the account, not what they get afterwards.
   */
  const completeLogin = async (input: {
    user: { username: string; accountId: string; opaqueRegistrationRecord: string };
    deviceId: string;
    deviceName: string;
    ip: string;
    adminContext: boolean;
    request: IncomingMessage;
    response: ServerResponse;
  }): Promise<JsonRecord> => {
    if (!input.adminContext && !await ledgerWebAccess()) {
      throw new ServerStoreError('LEDGER_WEB_ACCESS_DISABLED', 403, '管理员已关闭通过本站网页记账');
    }
    const cookieSession = browserSession.requested(input.request);
    const sessionId = `session-${randomBytes(16).toString('hex')}`;
    const refreshToken = createRefreshToken(sessionId);
    const session = await store.createSession({
      expectedRegistrationRecord: input.user.opaqueRegistrationRecord,
      id: sessionId,
      username: input.user.username,
      deviceId: input.deviceId,
      deviceName: input.deviceName,
      refreshHash: opaqueHash(secret, refreshToken),
      expiresAt: new Date(Date.now() + SESSION_TTL_MS).toISOString(),
      ip: input.ip,
      kind: input.adminContext ? 'admin' : 'ledger',
    });
    await store.noteLogin(input.user.username);
    await log('info', 'login_success', 'Sync user logged in', { ip: input.ip, username: input.user.username, detail: { sessionId: session.id, deviceId: session.deviceId } });
    const replica = await store.getReplica(input.user.username);
    if (cookieSession) browserSession.write(input.request, input.response, refreshToken);
    return {
      ...issueAccessToken(session),
      accountId: input.user.accountId,
      ...(cookieSession ? { sessionTransport: 'cookie' } : { refreshToken }),
      session: publicSession(session) as unknown as JsonRecord,
      role: await store.roleForUser(input.user.username),
      ...(replica ? { ledgerId: replica.ledgerId, replicaId: replica.replicaId,
        streamEpoch: replica.streamEpoch } : {}),
    };
  };

  /** Shared device identity validation; both login steps accept the same shape. */
  const deviceIdentityOf = (body: JsonRecord): { deviceId: string; deviceName: string } | undefined => {
    const { deviceId, deviceName } = body;
    if (typeof deviceId !== 'string' || !/^[A-Za-z0-9_.:-]{8,128}$/.test(deviceId)
      || typeof deviceName !== 'string' || !deviceName.trim() || deviceName.length > 120) return undefined;
    return { deviceId, deviceName: deviceName.trim() };
  };
  const hashOffload = createHashOffload();
  const jobHandlers = createJobHandlers({ store, blobStore, dataDir, settings, log, hashOffload });
  const jobs = createJobRunner({ store, log, handlers: jobHandlers });
  const systemMonitor = createSystemMonitor();
  const metrics = createMetricsService({
    store,
    blobStore,
    settings,
    log,
    onCapacityActive: async (warning, episode) => {
      const category = warning.scope === 'commit' ? '加密记录' : '附件';
      const percent = Math.round(warning.usedBytes / warning.quotaBytes * 100);
      await store.enqueueQuotaEmail(
        warning.username,
        `quota:${warning.username}:${warning.scope}:${episode}`,
        `资产账本${category}容量提醒`,
        `您的${category}存储用量已达到配额的 ${percent}%。请登录“我的账号”查看用量与剩余空间。\n\n此邮件不包含账本记录或附件内容。`,
      );
    },
    // Alerts only need the newest records to answer "latest attempt / latest success / latest
    // verified"; the paginated view is the console's, not the sampler's. The success/verified
    // answers come from `latestBackupSummary` below, which is queried over the whole table.
    listBackupRecords: async () => {
      const { lastAttempt } = await store.latestBackupSummary();
      return lastAttempt ? [lastAttempt] : [];
    },
    startedAt,
    systemMonitor,
  });
  const admin = createAdminRouter({
    store,
    blobStore,
    settings: runtimeSettings,
    metrics,
    systemMonitor,
    jobs,
    mfa,
    log,
    maintenance,
    writeTracker,
    syncGroup: {
      create: async (mainUrl) => store.createServerSyncGroup(normalizeNodePeerUrl(mainUrl), nodeIdentity.publicKey),
      join: async (mainUrl, localUrl, token) => {
        const peerUrl = normalizeNodePeerUrl(mainUrl);
        const advertisedUrl = normalizeNodePeerUrl(localUrl);
        const healthResponse = await fetch(`${peerUrl}/api/health`, {
          redirect: 'error', signal: AbortSignal.timeout(10_000),
        });
        const health = await healthResponse.json() as JsonRecord;
        if (!healthResponse.ok || typeof health.serverId !== 'string'
          || typeof health.nodePublicKey !== 'string' || health.serverId === serverId) {
          throw new ServerStoreError('INVALID_GROUP_MAIN', 409, '主节点身份无效');
        }
        const response = await fetch(`${peerUrl}/api/v4/group/join`, {
          method: 'POST', redirect: 'error', signal: AbortSignal.timeout(15_000),
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ token, nodeId: serverId, publicKey: nodeIdentity.publicKey,
            nodeUrl: advertisedUrl,
            signature: nodeIdentity.sign(Buffer.from(JSON.stringify([
              token, serverId, nodeIdentity.publicKey, advertisedUrl]))) }),
        });
        const result = await response.json() as JsonRecord;
        if (!response.ok || !isRecord(result.group) || !isRecord(result.member)
          || typeof result.signature !== 'string') {
          throw new ServerStoreError('GROUP_JOIN_FAILED', 409, String(result.error ?? '主节点未接受加入'));
        }
        const group = result.group;
        const member = result.member;
        const payload = Buffer.from(JSON.stringify([group, member]));
        if (group.role !== 'main' || group.mainNodeId !== health.serverId
          || group.mainPublicKey !== health.nodePublicKey || group.mainUrl !== peerUrl
          || member.nodeId !== serverId || member.publicKey !== nodeIdentity.publicKey
          || member.nodeUrl !== advertisedUrl
          || !verifyNodeSignature(health.nodePublicKey, payload, result.signature)) {
          throw new ServerStoreError('GROUP_JOIN_FAILED', 409, '主节点签名或加入身份不匹配');
        }
        await store.joinServerSyncGroup(group as unknown as import('./store.js').ServerSyncGroup,
          advertisedUrl, nodeIdentity.publicKey);
        return store.serverSyncGroup();
      },
    },
    dataDir,
    databaseFile: store.databaseFile,
    serverId,
    version: serverVersion,
    enableSync,
    enableWeb,
    trafficCountryConfigured: Boolean(options.trafficCountryHeader),
    basePath,
    defaultProtection,
    custodyEnabled,
    ledgerPreview,
    allowInsecureHttp,
    accessTokenMinutes: ACCESS_TOKEN_TTL_MS / 60_000,
    sessionDays: SESSION_TTL_MS / 86_400_000,
  });
  // Recovery, deployment-record import and sampling all start after the stores are ready.
  // The queue is also re-kicked on a slow timer: a task that stayed `queued` because the
  // worker stopped after a failed write must not wait for someone to open the console.
  let accountEmailFlight: Promise<void> | undefined;
  const processAccountEmails = (): void => {
    if (accountEmailFlight) return;
    accountEmailFlight = (async () => {
      for (const item of await store.dueAccountEmails()) {
        if (!item.enabled || !item.email) {
          await store.finishAccountEmail(item.id, 'skipped', item.attempts);
          continue;
        }
        try {
          await sendAccountMessage(item.email, item.subject, item.body);
          await store.finishAccountEmail(item.id, 'sent', item.attempts);
        } catch (error) {
          await store.finishAccountEmail(item.id, 'failed', item.attempts);
          await log('warn', 'account_email_delivery_failed', 'Account email delivery failed', { username: item.username, detail: { reason: error instanceof Error ? error.message : String(error) } });
        }
      }
    })().catch((error) => log('warn', 'account_email_worker_failed', 'Account email worker failed', { detail: { reason: error instanceof Error ? error.message : String(error) } }))
      .then(() => undefined).finally(() => { accountEmailFlight = undefined; });
  };
  const accountEmailTimer = setInterval(processAccountEmails, 60_000);
  accountEmailTimer.unref?.();
  const queueWatchdog = setInterval(() => jobs.kick(), 60_000);
  queueWatchdog.unref?.();
  const started = ready.then(async () => {
    // An unparseable environment override must stop the boot, not be replaced by a default.
    await runtimeSettings.load();
    try {
      const recovery = await jobs.recover();
      await importMaintenanceRecords(store, dataDir);
      metrics.start();
      processAccountEmails();
      if (recovery.interrupted.length) {
        console.log(`jobs: ${recovery.interrupted.length} interrupted task(s) recorded as interrupted, ${recovery.resumed.length} resumed from a checkpoint`);
      }
      const queued = (await store.countJobsByStatus())['queued'] ?? 0;
      if (queued) console.log(`jobs: ${queued} queued task(s) scheduled at startup`);
    } catch (error) {
      await log('warn', 'startup_tasks_failed', 'Startup recovery tasks failed', {
        detail: { error: error instanceof Error ? error.message : String(error) },
      }).catch(() => undefined);
    }
  });
  // Handled here so a caller that never observes `started` cannot crash the process,
  // while `service.started` still rejects for the launcher.
  void started.catch(() => undefined);
  const server = createServer(async (req, res) => {
    applyCors(req, res);
    if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }
    const url = new URL(req.url ?? '/', 'http://localhost');
    const path = decodePathname(url.pathname);
    const routedPath = stripBasePath(path, basePath);
    const ip = origin.clientIp(req);
    // One id per request binds the response, the log line and any diagnostic record.
    const requestId = `req-${randomBytes(REQUEST_ID_BYTES).toString('hex')}`;
    const requestStartedAt = Date.now();
    // Set once the request is accepted as a client write, so the outer `finally` can release the
    // count even when the handler throws. A leaked count would make the console claim a write is
    // still in flight forever, which is exactly the signal an operator uses to decide it is safe
    // to stop the process.
    let countedWrite = false;
    // Self-reported, informational only: an unreadable value is treated as "not reported".
    const client = clientIdentity(req);
    res.setHeader('X-Request-Id', requestId);
    res.once('finish', () => {
      if (!routedPath || !routedPath.startsWith('/api')) return;
      metrics.observeRequest({
        durationMs: Date.now() - requestStartedAt,
        status: res.statusCode,
        kind: routedPath.startsWith('/api/admin') ? 'admin'
          : routedPath.startsWith('/api/v3/blobs') ? 'blob'
          : routedPath.startsWith('/api/auth') ? 'auth'
          : routedPath.startsWith('/api/v3/commits') ? 'sync' : 'other',
        ...(routedPath.startsWith('/api/v3/commits') ? { operation: req.method === 'POST' ? 'push' as const : 'pull' as const } : {}),
      });
    });
    try {
      await ready;
      if (routedPath === '/api/health' && req.method === 'GET') {
        // Identity, protocol and policy only. Aggregates belong to /api/admin/overview,
        // which reads a cached snapshot instead of scanning tables on every handshake.
        const claimed = await store.ownerUsername() !== undefined;
        const capabilities = [
          'account-roles-v1',
          'account-identity-v1',
          'owner-setup-v1',
          'admin-session-v1',
          'device-sessions-v1',
          'same-origin-session-v1',
          'server-management-v1',
          'password-reset-v1',
          ...(accountEmailAvailable() ? ['password-reset-email-v1'] : []),
          'encrypted-blobs-v1',
          'portable-blobs-v2',
          'node-replication-v1',
          'encrypted-commits-v3',
          'ledger-key-envelope-v1',
          'ledger-protection-v1',
          'managed-key-custody-v1',
          'ledger-replacement-v1',
          'multi-origin-web-v1',
          'opaque-pake-v1',
          'sqlite-wal-v3',
          'admin-console-v2',
          'admin-jobs-v1',
          'admin-metrics-v1',
          'admin-resources-v1',
          'sync-diagnostics-v1',
        ];
        return send(res, 200, {
          ok: true,
          serverId,
          version: serverVersion,
          serverPublicKey: opaqueServerPublicKey,
          nodePublicKey,
          claimed,
          protocols: [3],
          capabilities,
          syncEnabled: enableSync,
          webEnabled: enableWeb && Boolean(options.webDir),
          registrationMode: await store.registrationMode(),
          ledgerWebAccess: await ledgerWebAccess(),
          attachmentMaxFileBytes: Number(settings.effective('attachmentMaxFileBytes')),
          accountProtection: defaultProtection,
          basePath,
          security: {
            httpsRequired: !allowInsecureHttp,
            adminHttpsRequired: !allowInsecureHttp,
            accessTokenMinutes: ACCESS_TOKEN_TTL_MS / 60_000,
            sessionDays: SESSION_TTL_MS / 86_400_000,
          },
        });
      }
      if (routedPath === '/api/ready' && req.method === 'GET') {
        // Read-only and constant-time: the container healthcheck runs this every 30s.
        // The whole-database check moved to the maintenance job `database.integrity-check`.
        const probe = await store.probe();
        return send(res, probe.ok ? 200 : 503, { ok: probe.ok, serverId, mode: 'light', database: probe });
      }
      if (basePath && (path === '/api' || path.startsWith('/api/'))) return send(res, 404, { error: 'not found' });
      if (routedPath === '/app' || routedPath === '/app/') {
        if (enableWeb && options.webDir && (req.method === 'GET' || req.method === 'HEAD')) {
          res.writeHead(302, { Location: `${encodeURI(basePath)}/${url.search}`, 'Cache-Control': 'no-store' });
          res.end();
          return;
        }
        return send(res, 404, { error: 'not found' });
      }
      // Without a configured segment, /admin is the permanent management entry.
      // With one, /admin only discovers it before the first owner is created.
      const requestedAdminPage = !routedPath?.startsWith('/api/')
        && /(?:^|\/)admin(?:\/|$)/.test(routedPath ?? path);
      let webPath = routedPath;
      if (requestedAdminPage) {
        await runtimeSettings.load();
        const accessPath = String(settings.effective('adminAccessPath'));
        const adminPrefix = accessPath ? `/${accessPath}/admin` : '/admin';
        if (accessPath && (routedPath === '/admin' || routedPath === '/admin/')
          && (req.method === 'GET' || req.method === 'HEAD')
          && enableWeb && options.webDir
          && await store.ownerUsername() === undefined) {
          res.writeHead(302, {
            Location: `${basePath}${adminPrefix}/`,
            'Cache-Control': 'no-store',
          });
          res.end();
          return;
        }
        if (!routedPath || routedPath !== adminPrefix && !routedPath.startsWith(`${adminPrefix}/`)) {
          return send(res, 404, { error: 'not found' });
        }
        webPath = routedPath.slice(adminPrefix.length) ? `/admin${routedPath.slice(adminPrefix.length)}` : '/admin';
      }
      if (webPath && serveWeb(req, res, webPath, enableWeb ? options.webDir : undefined, allowInsecureHttp)) return;
      if (!routedPath && serveWeb(req, res, path, enableWeb ? options.webDir : undefined, allowInsecureHttp)) return;
      if (!routedPath) return send(res, 404, { error: 'not found' });
      const apiPath = routedPath;
      if (apiPath !== '/api' && !apiPath.startsWith('/api/')) return send(res, 404, { error: 'not found' });
      if (!enableSync && (apiPath === '/api' || apiPath.startsWith('/api/'))) return send(res, 503, { error: 'sync api disabled' });
      // Maintenance refuses client writes only. Admin routes must stay open or the mode could
      // never be cleared, and auth must stay open so people can still sign in while it is on.
      if (isClientWrite(req.method ?? 'GET', apiPath)) {
        const view = resolveMaintenance(await maintenance.read());
        if (view.active) {
          res.setHeader('Retry-After', view.until ? String(Math.max(1, Math.ceil((Date.parse(view.until) - Date.now()) / 1000))) : '600');
          await log('warn', 'maintenance_write_refused', 'Client write refused during the maintenance window', {
            ip, status: 503, detail: { method: req.method, path: apiPath, requestId },
          });
          return send(res, 503, { code: 'MAINTENANCE', error: view.message, ...(view.until ? { until: view.until } : {}), requestId });
        }
        writeTracker.begin();
        countedWrite = true;
      }
      const isAdmin = apiPath === '/api/admin' || apiPath.startsWith('/api/admin/');
      if (isAdmin && !origin.secureTransport(req, allowInsecureHttp)) {
        return send(res, 426, { code: 'HTTPS_REQUIRED', error: 'HTTPS is required for remote administration' });
      }
      if (!origin.secureTransport(req, allowInsecureHttp)) return send(res, 426, { code: 'HTTPS_REQUIRED', error: 'HTTPS is required for remote synchronization' });
      const isAuth = apiPath.startsWith('/api/auth/');
      // The signed-in UI reads its account identity during page restores and
      // replica checks. Keep login attempts tight without locking out normal
      // authenticated browsing after twenty such reads in a minute.
      const isAccountRead = apiPath === '/api/auth/me' && req.method === 'GET';
      const isBlob = apiPath.startsWith('/api/v3/blobs')
        || apiPath.startsWith('/api/v4/ledger/attachment-promise');
      const isNode = apiPath.startsWith('/api/v4/replication/')
        || apiPath.startsWith('/api/v4/group/') || apiPath === '/api/v4/identity/exchange';
      const rate = await allow(
        ip,
        isAuth ? `auth:${apiPath}` : isAdmin ? 'admin' : isBlob ? 'blob' : isNode ? 'node' : 'api',
        // Several trusted replicas can share one NAT address during initial copy.
        // Keep an IP ceiling for unauthenticated traffic; verified grants get a separate quota below.
        // A single signed-in ledger page reads several independent replica,
        // member and sync endpoints; the former 120/min shared API bucket
        // throttled normal three-node use. Auth, admin and node buckets remain
        // separate and keep their tighter or protocol-specific ceilings.
        isAccountRead ? 120 : isAuth ? 20 : isBlob ? 600 : isNode ? 12_000 : isAdmin ? 120 : 600,
        60_000,
      );
      if (!rate.allowed) {
        res.setHeader('Retry-After', String(rate.retryAfterSeconds));
        await log('warn', 'rate_limited', 'API request rate limited', { ip, status: 429 });
        return send(res, 429, { error: 'rate limited, slow down' });
      }

      if (apiPath === '/api/traffic/view' && req.method === 'POST') {
        const browserOrigin = origin.browserOrigin(req);
        if (!browserOrigin || req.headers.origin !== browserOrigin) return send(res, 403, { error: 'same-origin browser required' });
        const body = await readBody(req, 512);
        const visitorId = body.visitorId;
        const page = body.page;
        if (typeof visitorId !== 'string' || !/^[a-f0-9-]{36}$/.test(visitorId)
          || typeof page !== 'string' || !/^\/(?:app|admin)(?:\/[a-z0-9-]{1,48})?$/.test(page)) {
          return send(res, 400, { error: 'invalid traffic view' });
        }
        const countryHeader = options.trafficCountryHeader?.toLowerCase();
        const rawCountry = countryHeader && origin.trustedPeer(req) ? req.headers[countryHeader] : undefined;
        const country = typeof rawCountry === 'string' && /^[A-Z]{2}$/.test(rawCountry) && !['XX', 'ZZ'].includes(rawCountry) ? rawCountry : null;
        const visitorHash = createHmac('sha256', secret).update(visitorId).digest('hex');
        await store.recordPageView(visitorHash, page, country);
        return send(res, 202, { accepted: true });
      }

      if (apiPath === '/api/v4/group/join' && req.method === 'POST') {
        const body = await readBody(req, 4096);
        if (typeof body.token !== 'string' || typeof body.nodeId !== 'string'
          || typeof body.publicKey !== 'string' || typeof body.nodeUrl !== 'string'
          || typeof body.signature !== 'string') {
          return send(res, 400, { code: 'INVALID_GROUP_JOIN', error: '同步组加入参数无效' });
        }
        const nodeUrl = normalizeNodePeerUrl(body.nodeUrl);
        if (!verifyNodeSignature(body.publicKey, Buffer.from(JSON.stringify([
          body.token, body.nodeId, body.publicKey, nodeUrl])), body.signature)) {
          return send(res, 403, { code: 'INVALID_GROUP_JOIN', error: '节点签名身份无效' });
        }
        const accepted = await store.acceptServerSyncGroupMember(body.token,
          { nodeId: body.nodeId, publicKey: body.publicKey, nodeUrl });
        const signature = nodeIdentity.sign(Buffer.from(JSON.stringify([accepted.group, accepted.member])));
        return send(res, 201, { ...accepted, signature });
      }
      if ((apiPath === '/api/v4/group/catalog' && req.method === 'GET')
        || (apiPath === '/api/v4/group/accounts' && req.method === 'GET')
        || (apiPath === '/api/v4/group/announce' && req.method === 'POST')
        || (apiPath === '/api/v4/group/account' && req.method === 'POST')
        || (apiPath === '/api/v4/group/account/check' && req.method === 'POST')) {
        const group = await store.serverSyncGroup();
        if (!group || group.role !== 'main') return send(res, 409,
          { code: 'GROUP_MAIN_REQUIRED', error: '本站不是同步组主节点' });
        const bytes = req.method === 'POST' ? await readBinaryBody(req, 64 * 1024) : new Uint8Array();
        let proof: NodeRequestProof | undefined;
        const rawProof = req.headers['x-zichan-node-proof'];
        if (typeof rawProof === 'string' && rawProof.length <= 2048) {
          try { proof = JSON.parse(rawProof) as NodeRequestProof; } catch { /* Reject below. */ }
        }
        const member = proof && (await store.serverSyncGroupMembers())
          .find((item) => item.nodeId === proof.nodeId);
        if (!proof || !member || member.nodeId === serverId || proof.grantId !== group.groupId
          || !verifyNodeRequest(proof, member.publicKey, req.method ?? 'GET',
            `${apiPath}${url.search}`, bytes)
          || !await store.consumeServerSyncGroupNonce(group.groupId, member.nodeId, proof.nonce)) {
          return send(res, 403, { code: 'GROUP_NODE_REJECTED', error: '同步组节点身份无效' });
        }
        const groupRate = await allow(`group:${member.nodeId}`, 'group-node', 6_000, 60_000);
        if (!groupRate.allowed) return send(res, 429,
          { code: 'GROUP_NODE_RATE_LIMIT', error: '节点目录请求过于频繁' });
        const signedGroupJson = (value: unknown, status = 200) => {
          res.setHeader('X-Zichan-Node-Response', signNodeResponse(nodeIdentity,
            proof.nonce, Buffer.from(JSON.stringify(value))));
          return send(res, status, value);
        };
        if (apiPath === '/api/v4/group/catalog') {
          const policy = await store.localRegistrationPolicy();
          const catalog = await store.groupLedgerCatalog(url.searchParams.get('after') ?? '',
            Number(url.searchParams.get('limit') ?? 50), member.nodeId, member.publicKey);
          return signedGroupJson({ groupId: group.groupId, serverId,
            members: await store.serverSyncGroupMembers(), registrationPolicy: policy, ...catalog });
        }
        if (apiPath === '/api/v4/group/accounts') {
          const after = url.searchParams.get('after') ?? '';
          const limit = Number(url.searchParams.get('limit') ?? 50);
          if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100 || after.length > 300) {
            return send(res, 400, { code: 'INVALID_GROUP_PAGE', error: '账号目录分页参数无效' });
          }
          const rows = await store.groupAccountRows(after, limit + 1);
          const selected = rows.slice(0, limit);
          const accounts = [];
          for (const row of selected) {
            if (row.issuerNodeId === serverId) {
              const bundle = { v: 1 as const, ledgerId: group.groupId,
                issuerNodeId: serverId, subjectAccountId: row.subjectAccountId,
                username: row.user.username, displayName: row.user.displayName,
                registrationRecord: row.user.opaqueRegistrationRecord,
                serverSetup: await store.opaqueSetupForUser(row.user.username) ?? opaqueServerSetup,
                disabled: row.user.disabled,
                revision: row.user.revision };
              accounts.push({ bundle, issuerSignature: signFederatedCredential(nodeIdentity, bundle) });
            } else {
              const relayed = await store.relayedCredential(group.groupId,
                row.issuerNodeId, row.subjectAccountId);
              if (relayed) accounts.push({ bundle: relayed.bundle, issuerSignature: relayed.signature });
            }
          }
          return signedGroupJson({ groupId: group.groupId, serverId,
            members: await store.serverSyncGroupMembers(),
            registrationPolicy: await store.localRegistrationPolicy(), accounts,
            next: selected.at(-1)?.key ?? after, hasMore: rows.length > limit });
        }
        if (apiPath === '/api/v4/group/account/check') {
          let body: unknown;
          try { body = JSON.parse(Buffer.from(bytes).toString('utf8')); } catch { /* Reject below. */ }
          if (!isRecord(body) || typeof body.username !== 'string'
            || !/^[\p{L}\p{N}_.-]{2,64}$/u.test(body.username)
            || body.inviteCode !== undefined && typeof body.inviteCode !== 'string') {
            return send(res, 400, { code: 'INVALID_GROUP_ACCOUNT', error: '账号注册信息无效' });
          }
          await store.assertGroupUsernameAvailable(body.username, body.inviteCode);
          return signedGroupJson({ groupId: group.groupId, serverId,
            registrationPolicy: await store.localRegistrationPolicy(), available: true });
        }
        if (apiPath === '/api/v4/group/account') {
          let body: unknown;
          try { body = JSON.parse(Buffer.from(bytes).toString('utf8')); } catch { /* Reject below. */ }
          if (!isRecord(body) || typeof body.issuerSignature !== 'string'
            || body.inviteCode !== undefined && typeof body.inviteCode !== 'string'
            || body.preExistingAt !== undefined && typeof body.preExistingAt !== 'string') {
            return send(res, 400, { code: 'INVALID_GROUP_ACCOUNT', error: '账号凭据无效' });
          }
          let bundle;
          try { bundle = parseFederatedCredential(body.bundle); }
          catch { return send(res, 400, { code: 'INVALID_GROUP_ACCOUNT', error: '账号凭据格式无效' }); }
          if (bundle.ledgerId !== group.groupId || bundle.issuerNodeId !== member.nodeId) {
            return send(res, 403, { code: 'INVALID_GROUP_ACCOUNT', error: '账号签发节点不匹配' });
          }
          const username = await store.acceptGroupAccount(bundle, body.issuerSignature,
            member.publicKey, body.inviteCode, body.preExistingAt);
          return signedGroupJson({ groupId: group.groupId, serverId,
            issuerNodeId: bundle.issuerNodeId, subjectAccountId: bundle.subjectAccountId,
            username: bundle.username, localUsername: username });
        }
        let body: unknown;
        try { body = JSON.parse(Buffer.from(bytes).toString('utf8')); }
        catch { return send(res, 400, { code: 'INVALID_GROUP_ANNOUNCEMENT', error: '账本登记格式无效' }); }
        if (!isRecord(body) || typeof body.ledgerId !== 'string'
          || typeof body.replicaId !== 'string' || typeof body.streamEpoch !== 'string'
          || typeof body.grantId !== 'string' || !/^[A-Za-z0-9_-]{16,128}$/.test(body.ledgerId)
          || !/^[A-Za-z0-9_-]{8,160}$/.test(body.replicaId)
          || !/^[A-Za-z0-9_-]{8,160}$/.test(body.streamEpoch)
          || !/^[A-Za-z0-9_-]{16,160}$/.test(body.grantId)
          || !isLedgerKeyEnvelope(body.envelope) || body.envelope.ledgerId !== body.ledgerId
          || !isRecord(body.protection)
          || body.protection.mode !== 'managed'
          || (typeof body.protection.secret !== 'string'
            || !body.protection.secret)
          || typeof body.issuerSignature !== 'string') {
          return send(res, 400, { code: 'INVALID_GROUP_ANNOUNCEMENT', error: '账本登记参数无效' });
        }
        let bundle;
        try { bundle = parseFederatedCredential(body.bundle); }
        catch { return send(res, 400, { code: 'INVALID_GROUP_CREDENTIAL', error: '账号凭据无效' }); }
        if (bundle.ledgerId !== body.ledgerId || bundle.issuerNodeId !== member.nodeId
          || !verifyFederatedCredential(bundle, body.issuerSignature, member.publicKey)) {
          return send(res, 403, { code: 'INVALID_GROUP_CREDENTIAL', error: '账本账号签发身份无效' });
        }
        const existing = (await store.listReplicaSlots()).find((item) => item.ledgerId === body.ledgerId);
        if (!existing) {
          await store.provisionFederatedReplica({ issuerNodeId: member.nodeId,
            subjectAccountId: bundle.subjectAccountId, ledgerId: body.ledgerId,
            envelope: body.envelope, peerUrl: member.nodeUrl, peerNodeId: member.nodeId,
            peerPublicKey: member.publicKey, peerReplicaId: body.replicaId,
            peerStreamEpoch: body.streamEpoch, grantId: body.grantId });
        } else {
          const bound = await store.federatedAccount(existing.username);
          const link = (await store.listNodeReplicationLinks(existing.username)).find((item) =>
            item.ledgerId === body.ledgerId && item.peerNodeId === member.nodeId);
          if (bound?.issuerNodeId !== member.nodeId
            || bound.subjectAccountId !== bundle.subjectAccountId || !link
            || link.peerReplicaId !== body.replicaId || link.peerStreamEpoch !== body.streamEpoch) {
            return send(res, 409, { code: 'GROUP_LEDGER_COLLISION', error: '账本 ID 已由另一副本占用' });
          }
          if (link.grantId !== body.grantId) await store.renewNodeReplicationLink(
            existing.username, link.linkId, body.grantId, member.nodeId,
            member.publicKey, body.replicaId, body.streamEpoch);
        }
        const owner = (await store.listReplicaSlots()).find((item) => item.ledgerId === body.ledgerId)!;
        const replica = await store.getReplica(owner.username);
        if (!replica) throw new Error('同步组账本副本丢失');
        let sealedProtection: string | null = null;
        if (body.protection.mode === 'managed') {
          await unlockLedgerKeyEnvelope(body.protection.secret as string,
            body.envelope as unknown as LedgerKeyEnvelope);
          sealedProtection = sealCustodySecret(custodyKey,
            `${serverId}:${bundle.subjectAccountId}`, body.protection.secret as string);
        }
        await store.importFederatedLedgerProtection(owner.username, member.nodeId,
          body.ledgerId, 'managed', sealedProtection!);
        await store.importFederatedPasswordCredential({ localUsername: owner.username,
          sourceUsername: bundle.username, displayName: bundle.displayName,
          issuerNodeId: member.nodeId, subjectAccountId: bundle.subjectAccountId,
          registrationRecord: bundle.registrationRecord, serverSetup: bundle.serverSetup,
          disabled: bundle.disabled, sourceRevision: bundle.revision });
        await store.saveRelayedCredential(bundle, body.issuerSignature, member.publicKey);
        const grant = await store.ensureGroupNodeReplicationGrant(group.groupId, owner.username,
          member.nodeId, member.publicKey, replica.replicaId);
        return signedGroupJson({ groupId: group.groupId, serverId,
          ledgerId: body.ledgerId, replicaId: replica.replicaId,
          streamEpoch: replica.streamEpoch, grantId: grant.grantId });
      }
      const nodeBlobChunk = /^\/api\/v4\/replication\/blobs\/([a-f0-9]{64})\/chunks\/(\d+)$/.exec(apiPath);
      const nodeUploadChunk = /^\/api\/v4\/replication\/blobs\/uploads\/([a-f0-9]{32})\/chunks\/(\d+)$/.exec(apiPath);
      const nodeUploadComplete = /^\/api\/v4\/replication\/blobs\/uploads\/([a-f0-9]{32})\/complete$/.exec(apiPath);
      const nodePromisePage = /^\/api\/v4\/replication\/attachment-promise\/uploads\/([a-f0-9]{32})\/pages$/.exec(apiPath);
      const nodePromiseComplete = /^\/api\/v4\/replication\/attachment-promise\/uploads\/([a-f0-9]{32})\/complete$/.exec(apiPath);
      const nodeRoute = (apiPath === '/api/v4/replication/commits' && (req.method === 'GET' || req.method === 'POST'))
        || (apiPath === '/api/v4/identity/exchange' && req.method === 'POST')
        || (apiPath === '/api/v4/replication/key-envelope' && (req.method === 'GET' || req.method === 'POST'))
        || (apiPath === '/api/v4/replication/account-identity' && req.method === 'GET')
        || (apiPath === '/api/v4/replication/account-credential' && req.method === 'GET')
        || (apiPath === '/api/v4/replication/account-directory' && req.method === 'GET')
        || (apiPath === '/api/v4/replication/account-protection' && req.method === 'GET')
        || (apiPath === '/api/v4/replication/inventory' && req.method === 'GET')
        || (apiPath === '/api/v4/replication/health-report' && req.method === 'POST')
        || (apiPath === '/api/v4/replication/group-state' && req.method === 'GET')
        || (apiPath === '/api/v4/replication/group-policy' && req.method === 'GET')
        || (apiPath === '/api/v4/replication/member-status' && req.method === 'GET')
        || (apiPath === '/api/v4/replication/revoke' && req.method === 'POST')
        || (apiPath === '/api/v4/replication/attachment-promise' && req.method === 'GET')
        || (apiPath === '/api/v4/replication/attachment-promise/uploads' && req.method === 'POST')
        || (nodePromisePage && req.method === 'POST') || (nodePromiseComplete && req.method === 'POST')
        || (apiPath === '/api/v4/replication/blobs' && req.method === 'GET')
        || (apiPath === '/api/v4/replication/blobs/states' && (req.method === 'GET' || req.method === 'POST'))
        || (apiPath === '/api/v4/replication/blobs/status' && req.method === 'POST')
        || (apiPath === '/api/v4/replication/blobs/pack' && req.method === 'POST')
        || (apiPath === '/api/v4/replication/blobs/pack/read' && req.method === 'GET')
        || (apiPath === '/api/v4/replication/blobs/uploads' && req.method === 'POST')
        || (nodeBlobChunk && req.method === 'GET') || (nodeUploadChunk && req.method === 'PUT')
        || (nodeUploadComplete && req.method === 'POST');
      if (nodeRoute) {
        const requestBytes = req.method === 'POST' || req.method === 'PUT' ? await readBinaryBody(req, MAX_BODY_BYTES) : new Uint8Array();
        const rawProof = req.headers['x-zichan-node-proof'];
        let proof: NodeRequestProof | undefined;
        if (typeof rawProof === 'string' && rawProof.length <= 2048) {
          try { proof = JSON.parse(rawProof) as NodeRequestProof; } catch { /* Refuse malformed proof below. */ }
        }
        if (!proof || typeof proof.grantId !== 'string' || typeof proof.nodeId !== 'string'
          || typeof proof.signature !== 'string' || typeof proof.nonce !== 'string'
          || typeof proof.issuedAt !== 'string' || typeof proof.bodySha256 !== 'string') {
          return send(res, 401, { code: 'NODE_AUTH_REQUIRED', error: 'node authorization required' });
        }
        const signedJson = (result: unknown, status = 200) => {
          res.setHeader('X-Zichan-Node-Response', signNodeResponse(nodeIdentity, proof.nonce, Buffer.from(JSON.stringify(result))));
          return send(res, status, result);
        };
        const revocationRequest = apiPath === '/api/v4/replication/revoke' && req.method === 'POST';
        const memberStatusRequest = apiPath === '/api/v4/replication/member-status' && req.method === 'GET';
        const historicalRequest = revocationRequest || memberStatusRequest;
        const grant = await store.getNodeReplicationGrant(proof.grantId, historicalRequest);
        const replica = grant ? await store.getReplicaForLedger(grant.username, grant.ledgerId) : undefined;
        if (!grant || !replica || grant.ledgerId !== replica.ledgerId || grant.peerNodeId !== proof.nodeId
          || !historicalRequest && (grant.revokedAt || grant.expiresAt <= nowIso())
          || !verifyNodeRequest(proof, grant.peerPublicKey, req.method ?? 'GET', `${apiPath}${url.search}`, requestBytes)
          || !await (historicalRequest
            ? store.consumeNodeRevocationNonce(grant.grantId, proof.nonce, proof.nodeId)
            : store.consumeNodeReplicationNonce(grant.grantId, proof.nonce, proof.nodeId))) {
          if (!grant && !historicalRequest) {
            const oldGrant = await store.getNodeReplicationGrant(proof.grantId, true);
            const oldReplica = oldGrant ? await store.getReplicaForLedger(oldGrant.username, oldGrant.ledgerId) : undefined;
            const member = oldReplica && (await store.listReplicaGroupMembers(oldReplica.replicaId))
              .find((item) => item.nodeId === proof.nodeId && item.publicKey === oldGrant?.peerPublicKey);
            if (oldGrant && oldReplica && member?.retiredAt && oldGrant.peerNodeId === proof.nodeId
              && verifyNodeRequest(proof, oldGrant.peerPublicKey, req.method ?? 'GET', `${apiPath}${url.search}`, requestBytes)
              && await store.consumeNodeRevocationNonce(oldGrant.grantId, proof.nonce, proof.nodeId)) {
              return signedJson({ code: 'REPLICA_MEMBER_RETIRED', serverId,
                replicaId: oldReplica.replicaId, streamEpoch: oldReplica.streamEpoch,
                ledgerId: oldGrant.ledgerId, grantId: oldGrant.grantId,
                retiredNodeId: proof.nodeId, retiredAt: member.retiredAt }, 410);
            }
          }
          return send(res, 403, { code: 'NODE_AUTH_REJECTED', error: 'node authorization rejected' });
        }
        const grantRate = await allow(`grant:${grant.grantId}`, 'node-grant', 6_000, 60_000);
        if (!grantRate.allowed) {
          res.setHeader('Retry-After', String(grantRate.retryAfterSeconds));
          await log('warn', 'node_grant_rate_limited', 'Node grant request rate limited', {
            ip, status: 429, detail: { grantId: grant.grantId, peerNodeId: proof.nodeId },
          });
          return send(res, 429, { error: 'rate limited, slow down' });
        }
        if (!revocationRequest && req.method !== 'GET'
          && await store.replicaRetirement(replica.replicaId)) {
          return signedJson({ code: 'REPLICA_RETIRED', error: '本节点已移出副本组，禁止继续写入' }, 409);
        }
        if (revocationRequest) {
          if (Buffer.from(requestBytes).toString('utf8') !== '{}') {
            return send(res, 400, { code: 'INVALID_REVOCATION', error: 'invalid revocation request' });
          }
          await store.revokeNodeReplicationGrant(grant.username, grant.grantId);
          return signedJson({ serverId, replicaId: replica.replicaId, streamEpoch: replica.streamEpoch,
            grantId: grant.grantId, revoked: true });
        }
        if (memberStatusRequest) {
          const member = (await store.listReplicaGroupMembers(replica.replicaId))
            .find((item) => item.nodeId === proof.nodeId && item.publicKey === grant.peerPublicKey);
          return signedJson({ serverId, replicaId: replica.replicaId, streamEpoch: replica.streamEpoch,
            ledgerId: grant.ledgerId, grantId: grant.grantId,
            retiredNodeId: proof.nodeId, retiredAt: member?.retiredAt ?? null });
        }
        if (apiPath === '/api/v4/identity/exchange') {
          let body: unknown;
          try { body = JSON.parse(Buffer.from(requestBytes).toString('utf8')); } catch { /* Refuse below. */ }
          if (!isRecord(body) || typeof body.code !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(body.code)
            || typeof body.state !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(body.state)) {
            return send(res, 400, { error: 'invalid identity exchange' });
          }
          const redeemed = await store.consumeFederatedLoginCode(grant.grantId, body.code, body.state);
          if (!redeemed) return send(res, 403, { error: 'identity code expired or already used' });
          if (await store.federatedAccount(redeemed.username)) {
            return send(res, 403, { code: 'ISSUER_REQUIRED', error: '本节点不能替其他身份节点签发统一登录凭据' });
          }
          return signedJson({ issuerNodeId: serverId, subjectAccountId: redeemed.subjectAccountId,
            ledgerId: grant.ledgerId, username: redeemed.username });
        }
        if (apiPath === '/api/v4/replication/account-identity') {
          const account = await store.getUser(grant.username);
          if (!account) return send(res, 403, { error: 'issuer account missing' });
          const binding = await store.federatedAccount(account.username);
          return signedJson({ serverId, replicaId: replica.replicaId, streamEpoch: replica.streamEpoch,
            ledgerId: grant.ledgerId, issuerNodeId: binding?.issuerNodeId ?? serverId,
            subjectAccountId: binding?.subjectAccountId ?? account.accountId,
            username: await store.federatedSourceUsername(account.username) ?? account.username,
            disabled: account.disabled });
        }
        if (apiPath === '/api/v4/replication/group-policy') {
          const policy = await store.localRegistrationPolicy();
          return signedJson({ serverId, replicaId: replica.replicaId, streamEpoch: replica.streamEpoch,
            ledgerId: grant.ledgerId, registrationMode: policy.mode, revision: policy.revision });
        }
        if (apiPath === '/api/v4/replication/account-directory') {
          const account = await store.getUser(grant.username);
          if (!account || await store.federatedAccount(account.username)
            && (await store.serverSyncGroup())?.role !== 'main') return send(res, 403,
            { code: 'DIRECTORY_RELAY_REQUIRED', error: '账号目录必须由主节点提供' });
          for (const source of await store.pendingHubDirectoryUsers(grant.ledgerId)) {
            const bundle = { v: 1 as const, ledgerId: grant.ledgerId,
              issuerNodeId: serverId, subjectAccountId: source.accountId,
              username: source.username, displayName: source.displayName,
              registrationRecord: source.opaqueRegistrationRecord,
              serverSetup: await store.opaqueSetupForUser(source.username) ?? opaqueServerSetup,
              disabled: source.disabled,
              revision: source.revision };
            await store.saveRelayedCredential(bundle, signFederatedCredential(nodeIdentity, bundle),
              nodeIdentity.publicKey);
            await store.markHubDirectoryUserExported(grant.ledgerId, source.accountId, bundle.revision);
          }
          const page = await store.accountDirectoryPage(grant.ledgerId,
            Number(url.searchParams.get('after') ?? 0), Number(url.searchParams.get('limit') ?? 50));
          return signedJson({ serverId, replicaId: replica.replicaId,
            streamEpoch: replica.streamEpoch, ledgerId: grant.ledgerId, ...page });
        }
        if (apiPath === '/api/v4/replication/account-credential') {
          const primary = await store.getUser(grant.username);
          const primaryBinding = primary && await store.federatedAccount(primary.username);
          if (!primary || primaryBinding && (await store.serverSyncGroup())?.role !== 'main') {
            return send(res, 403, { code: 'ISSUER_REQUIRED', error: '账号原始身份节点不可用' });
          }
          const issuerNodeId = url.searchParams.get('issuerNodeId') ?? serverId;
          const subjectAccountId = url.searchParams.get('subjectAccountId') ?? primary.accountId;
          if (!/^[A-Za-z0-9_-]{8,128}$/.test(issuerNodeId)
            || !/^[A-Za-z0-9_-]{8,160}$/.test(subjectAccountId)) {
            return send(res, 400, { error: 'invalid account identity' });
          }
          const ownsLedger = issuerNodeId === (primaryBinding?.issuerNodeId ?? serverId)
            && subjectAccountId === (primaryBinding?.subjectAccountId ?? primary.accountId);
          if (!ownsLedger) return send(res, 403, { error: 'account is not bound to this ledger' });
          if (issuerNodeId !== serverId) {
            const relayed = await store.relayedCredential(grant.ledgerId, issuerNodeId, subjectAccountId);
            const pinned = (await store.listReplicaGroupMembers(replica.replicaId))
              .find((item) => item.nodeId === issuerNodeId && !item.retiredAt);
            const groupMember = (await store.serverSyncGroup())?.role === 'main'
              ? (await store.serverSyncGroupMembers()).find((item) => item.nodeId === issuerNodeId)
              : undefined;
            const issuerKey = pinned?.publicKey ?? groupMember?.publicKey;
            if (!relayed || !issuerKey || !verifyFederatedCredential(relayed.bundle,
              relayed.signature, issuerKey)) {
              return send(res, 404, { code: 'ISSUER_CREDENTIAL_PENDING', error: '成员身份节点凭据尚未上报中继' });
            }
            return signedJson({ serverId, replicaId: replica.replicaId,
              streamEpoch: replica.streamEpoch, ledgerId: grant.ledgerId,
              bundle: relayed.bundle, issuerSignature: relayed.signature });
          }
          const source = subjectAccountId === primary.accountId
            ? primary : await store.userByAccountId(subjectAccountId);
          if (!source || await store.federatedAccount(source.username)) {
            return send(res, 403, { code: 'ISSUER_REQUIRED', error: '账号凭据不属于此身份节点' });
          }
          const bundle = { v: 1 as const, ledgerId: grant.ledgerId,
            issuerNodeId: serverId, subjectAccountId,
            username: source.username, displayName: source.displayName,
            registrationRecord: source.opaqueRegistrationRecord,
            serverSetup: await store.opaqueSetupForUser(source.username) ?? opaqueServerSetup,
            disabled: source.disabled,
            revision: source.revision };
          return signedJson({ serverId, replicaId: replica.replicaId, streamEpoch: replica.streamEpoch,
            ledgerId: grant.ledgerId, issuerNodeId: serverId, subjectAccountId,
            username: source.username, displayName: source.displayName,
            registrationRecord: source.opaqueRegistrationRecord,
            serverSetup: bundle.serverSetup, disabled: source.disabled,
            bundle, issuerSignature: signFederatedCredential(nodeIdentity, bundle) });
        }
        if (apiPath === '/api/v4/replication/account-protection') {
          const account = await store.getUser(grant.username);
          if (!account || await store.federatedAccount(account.username)
            && (await store.serverSyncGroup())?.role !== 'main') {
            return send(res, 403, { code: 'ISSUER_REQUIRED', error: '账本保护资料不属于此身份节点' });
          }
          const protection = await store.getLedgerProtection(account.username);
          const mode = protection?.mode === 'managed' ? protection.mode : null;
          const secretValue = mode === 'managed' && protection?.sealedSecret
            ? openCustodySecret(custodyKey, `${serverId}:${account.accountId}`, protection.sealedSecret)
            : null;
          return signedJson({ serverId, replicaId: replica.replicaId, streamEpoch: replica.streamEpoch,
            ledgerId: grant.ledgerId, mode, secret: secretValue });
        }
        if (apiPath === '/api/v4/replication/inventory') {
          return signedJson(await store.replicaInventory(grant.username, grant.ledgerId, replica.replicaId));
        }
        if (apiPath === '/api/v4/replication/health-report' && req.method === 'POST') {
          if (requestBytes.byteLength > 16 * 1024) {
            return send(res, 413, { code: 'HEALTH_REPORT_TOO_LARGE', error: '节点健康报告过大' });
          }
          let body: unknown;
          try { body = JSON.parse(Buffer.from(requestBytes).toString('utf8')); } catch { /* Refuse below. */ }
          const report = parseNodeReplicaHealthReport(body, proof.nodeId, grant.ledgerId,
            replica.replicaId, replica.streamEpoch);
          if (!report) return send(res, 400, { code: 'INVALID_HEALTH_REPORT', error: '节点健康报告无效' });
          const acceptedAt = await store.recordNodeReplicaHealthReport(grant.grantId, proof.nodeId, report);
          return signedJson({ serverId, replicaId: replica.replicaId, streamEpoch: replica.streamEpoch,
            ledgerId: grant.ledgerId, acceptedAt });
        }
        if (apiPath === '/api/v4/replication/group-state' && req.method === 'GET') {
          const [inventory, physical, peers, links] = await Promise.all([
            store.replicaInventory(grant.username, grant.ledgerId, replica.replicaId),
            store.replicaPhysicalStatus(grant.username, grant.ledgerId),
            store.listReplicaGroupMembers(replica.replicaId),
            store.listNodeReplicationLinks(grant.username),
          ]);
          const activeLinks = (await Promise.all(links.map(async (link) =>
            await store.passiveGroupSourceLink(link) ? undefined : link)))
            .filter((link): link is NonNullable<typeof link> => Boolean(link));
          const localReadiness = assessReplicaReadiness({ inventory, physical,
            links: activeLinks.filter((link) => link.ledgerId === grant.ledgerId && link.enabled),
            verifiedLinkIds: new Set(), snapshotStable: true });
          const health = assessReplicaGroupHealth({ local: inventory, localReadiness,
            members: await store.listNodeGroupMemberReports(grant.username, grant.ledgerId) });
          const directory = buildReplicaGroupDirectory({ nodeId: serverId,
            publicKey: nodeIdentity.publicKey, joinedAt: replica.createdAt }, peers);
          return signedJson({ serverId, replicaId: replica.replicaId,
            streamEpoch: replica.streamEpoch, ledgerId: grant.ledgerId, directory, health });
        }
        if (apiPath === '/api/v4/replication/attachment-promise' && req.method === 'GET') {
          const page = await store.attachmentPromisePage(grant.username,
            url.searchParams.get('after') ?? '', Number(url.searchParams.get('limit') ?? 2000), replica.replicaId);
          return signedJson({ serverId, replicaId: replica.replicaId, streamEpoch: replica.streamEpoch,
            ledgerId: grant.ledgerId, ...page, current: await store.attachmentPromiseIsCurrent(grant.username, replica.replicaId) });
        }
        if (apiPath === '/api/v4/replication/attachment-promise/uploads' && req.method === 'POST') {
          let body: unknown;
          try { body = JSON.parse(Buffer.from(requestBytes).toString('utf8')); } catch { /* Refuse below. */ }
          if (!isRecord(body) || !isRecord(body.catalog)) {
            return send(res, 400, { code: 'INVALID_ATTACHMENT_PROMISE', error: 'invalid attachment promise' });
          }
          const upload = await store.beginReplicatedAttachmentPromise(grant.username, proof.nodeId,
            body.catalog as unknown as { commitCount: number; commitHash: string; blobCount: number; blobHash: string },
            replica.replicaId);
          return signedJson({ serverId, replicaId: replica.replicaId, streamEpoch: replica.streamEpoch,
            ledgerId: grant.ledgerId, upload: upload ?? null });
        }
        if (nodePromisePage && req.method === 'POST') {
          let body: unknown;
          try { body = JSON.parse(Buffer.from(requestBytes).toString('utf8')); } catch { /* Refuse below. */ }
          if (!isRecord(body) || !Array.isArray(body.blobIds)) {
            return send(res, 400, { code: 'INVALID_ATTACHMENT_PROMISE_PAGE', error: 'invalid attachment promise page' });
          }
          const upload = await store.appendAttachmentPromisePage(grant.username,
            nodePromisePage[1]!, body.blobIds as string[], replica.replicaId, proof.nodeId);
          return signedJson({ serverId, replicaId: replica.replicaId, streamEpoch: replica.streamEpoch,
            ledgerId: grant.ledgerId, upload });
        }
        if (nodePromiseComplete && req.method === 'POST') {
          const catalog = await store.completeAttachmentPromise(grant.username,
            nodePromiseComplete[1]!, replica.replicaId, proof.nodeId);
          return signedJson({ serverId, replicaId: replica.replicaId, streamEpoch: replica.streamEpoch,
            ledgerId: grant.ledgerId, catalog });
        }
        if (apiPath === '/api/v4/replication/key-envelope') {
          if (req.method === 'GET') {
            return signedJson({ serverId, replicaId: replica.replicaId, streamEpoch: replica.streamEpoch,
              ledgerId: grant.ledgerId, envelope: await store.getKeyEnvelope(grant.username, grant.ledgerId, 'node', replica.replicaId) ?? null });
          }
          const body = JSON.parse(Buffer.from(requestBytes).toString('utf8')) as JsonRecord;
          if (!isRecord(body) || !isLedgerKeyEnvelope(body.envelope) || body.envelope.ledgerId !== grant.ledgerId) {
            return send(res, 400, { error: 'invalid ledger key envelope' });
          }
          await store.putKeyEnvelope(grant.username, grant.ledgerId, String(body.envelope.keyringId), Number(body.envelope.generation), body.envelope, 'node', replica.replicaId);
          return signedJson({ ok: true, serverId, replicaId: replica.replicaId, streamEpoch: replica.streamEpoch });
        }
        if (req.method === 'GET' && apiPath === '/api/v4/replication/blobs') {
          const after = url.searchParams.get('after') ?? '';
          const requested = Number(url.searchParams.get('limit') ?? 20);
          if (after && !/^[a-f0-9]{64}$/.test(after) || !Number.isSafeInteger(requested) || requested < 1 || requested > 100) {
            return send(res, 400, { code: 'INVALID_CURSOR', error: 'invalid attachment cursor' });
          }
          return signedJson({ ledgerId: grant.ledgerId, serverId, replicaId: replica.replicaId, streamEpoch: replica.streamEpoch,
            packV1: true, ...await blobStore.listPortableManifests(grant.username, grant.ledgerId, after, requested) });
        }
        if (apiPath === '/api/v4/replication/blobs/states') {
          if (req.method === 'GET') {
            const after = url.searchParams.get('after') ?? '';
            const requested = Number(url.searchParams.get('limit') ?? 20);
            if (after && !/^[a-f0-9]{64}$/.test(after) || !Number.isSafeInteger(requested) || requested < 1 || requested > 100) {
              return send(res, 400, { code: 'INVALID_CURSOR', error: 'invalid attachment state cursor' });
            }
            return signedJson({ ledgerId: grant.ledgerId, serverId, replicaId: replica.replicaId, streamEpoch: replica.streamEpoch,
              ...await blobStore.listReplicaStates(grant.username, grant.ledgerId, after, requested) });
          }
          let body: unknown;
          try { body = JSON.parse(Buffer.from(requestBytes).toString('utf8')); } catch { /* Refuse below. */ }
          if (!isRecord(body) || !Array.isArray(body.states) || body.states.length > 100) {
            return send(res, 400, { error: 'invalid attachment states' });
          }
          let changed = false;
          try {
            for (const value of body.states) {
              if (await blobStore.applyReplicaState(grant.username, grant.ledgerId, value as BlobReplicaState)) changed = true;
            }
          } finally {
            if (changed) await store.invalidateReplicaPhysicalStatus(grant.username, grant.ledgerId);
          }
          return signedJson({ ledgerId: grant.ledgerId, serverId, replicaId: replica.replicaId, streamEpoch: replica.streamEpoch,
            accepted: body.states.length });
        }
        if (req.method === 'GET' && nodeBlobChunk) {
          const manifest = await blobStore.manifest(grant.username, grant.ledgerId, nodeBlobChunk[1]!);
          if (manifest?.v !== 2) return send(res, 404, { error: 'portable blob not found' });
          const chunk = await blobStore.chunk(grant.username, grant.ledgerId, nodeBlobChunk[1]!, Number(nodeBlobChunk[2]));
          if (!chunk) return send(res, 404, { error: 'blob chunk not found' });
          res.setHeader('X-Zichan-Node-Response', signNodeResponse(nodeIdentity, proof.nonce, chunk));
          return sendBinary(res, 200, chunk);
        }
        if (apiPath === '/api/v4/replication/blobs/status' && req.method === 'POST') {
          const body = JSON.parse(Buffer.from(requestBytes).toString('utf8')) as JsonRecord;
          if (!isRecord(body) || !Array.isArray(body.blobIds) || body.blobIds.length > 100
            || body.blobIds.some((id) => typeof id !== 'string' || !/^[a-f0-9]{64}$/.test(id))) {
            return send(res, 400, { error: 'invalid blob ids' });
          }
          return signedJson({ serverId, replicaId: replica.replicaId, streamEpoch: replica.streamEpoch,
            packV1: true, objects: await blobStore.status(grant.username, grant.ledgerId, body.blobIds as string[]) });
        }
        if (apiPath === '/api/v4/replication/blobs/pack' && req.method === 'POST') {
          let entries;
          try { entries = decodeBlobPack(requestBytes); }
          catch { return send(res, 400, { code: 'INVALID_BLOB_PACK', error: 'invalid encrypted attachment pack' }); }
          let changed = false;
          try {
            for (const entry of entries) {
              const plan = await blobStore.beginUpload(grant.username, grant.ledgerId, entry.manifest);
              if (plan.status === 'available') continue;
              if (!plan.uploadId) throw new Error('encrypted attachment pack upload session missing');
              if (plan.missingChunks.includes(0)) {
                await blobStore.putChunk(grant.username, plan.uploadId, 0, entry.chunk);
              }
              await blobStore.completeUpload(grant.username, plan.uploadId, 2);
              changed = true;
            }
          } finally {
            if (changed) await store.invalidateReplicaPhysicalStatus(grant.username, grant.ledgerId);
          }
          return signedJson({ serverId, replicaId: replica.replicaId, streamEpoch: replica.streamEpoch,
            ledgerId: grant.ledgerId, accepted: entries.map((entry) => entry.manifest.blobId) });
        }
        if (apiPath === '/api/v4/replication/blobs/pack/read' && req.method === 'GET') {
          const ids = url.searchParams.get('ids');
          const blobIds = ids?.split(',') ?? [];
          if (url.searchParams.size !== 1 || !ids || !blobIds.length
            || blobIds.length > MAX_BLOB_PACK_OBJECTS
            || blobIds.some((id) => !/^[a-f0-9]{64}$/.test(id))
            || new Set(blobIds).size !== blobIds.length) {
            return send(res, 400, { code: 'INVALID_BLOB_PACK_REQUEST', error: 'invalid encrypted attachment pack request' });
          }
          const states = await blobStore.status(grant.username, grant.ledgerId, blobIds);
          const entries = [];
          for (const blobId of blobIds) {
            if (states[blobId] !== 'available') return send(res, 409, { error: 'encrypted attachment is not available' });
            const manifest = await blobStore.manifest(grant.username, grant.ledgerId, blobId);
            if (manifest?.v !== 2 || manifest.chunkCount !== 1
              || manifest.cipherBytes > MAX_BLOB_PACK_CHUNK_BYTES) {
              return send(res, 409, { error: 'encrypted attachment cannot be packed' });
            }
            const chunk = await blobStore.chunk(grant.username, grant.ledgerId, blobId, 0);
            if (!chunk) return send(res, 409, { error: 'encrypted attachment chunk is not available' });
            entries.push({ manifest, chunk });
          }
          const pack = encodeBlobPack(entries);
          res.setHeader('X-Zichan-Node-Response', signNodeResponse(nodeIdentity, proof.nonce, pack));
          return sendBinary(res, 200, pack);
        }
        if (apiPath === '/api/v4/replication/blobs/uploads' && req.method === 'POST') {
          const body = JSON.parse(Buffer.from(requestBytes).toString('utf8')) as JsonRecord;
          if (!isRecord(body) || !isRecord(body.manifest) || body.manifest.v !== 2) return send(res, 400, { error: 'portable blob manifest required' });
          return signedJson({ serverId, replicaId: replica.replicaId, streamEpoch: replica.streamEpoch,
            plan: await blobStore.beginUpload(grant.username, grant.ledgerId, body.manifest) });
        }
        if (req.method === 'PUT' && nodeUploadChunk) {
          await blobStore.putChunk(grant.username, nodeUploadChunk[1]!, Number(nodeUploadChunk[2]), requestBytes);
          return signedJson({ ok: true, serverId, replicaId: replica.replicaId, streamEpoch: replica.streamEpoch });
        }
        if (req.method === 'POST' && nodeUploadComplete) {
          const manifest = await blobStore.completeUpload(grant.username, nodeUploadComplete[1]!, 2);
          await store.invalidateReplicaPhysicalStatus(grant.username, grant.ledgerId);
          return signedJson({ ok: true, blobId: manifest.blobId, serverId, replicaId: replica.replicaId, streamEpoch: replica.streamEpoch });
        }
        if (req.method === 'GET') {
          const after = Number(url.searchParams.get('after') ?? 0);
          const requested = Number(url.searchParams.get('limit') ?? 200);
          if (!Number.isSafeInteger(after) || after < 0 || !Number.isSafeInteger(requested) || requested < 1 || requested > 200) {
            return send(res, 400, { code: 'INVALID_CURSOR', error: 'invalid replication cursor' });
          }
          const page = await store.listCommits(grant.username, after, requested, 'node', replica.replicaId);
          const selected: StoredCommit[] = [];
          let responseBytes = 0;
          for (const commit of page.commits) {
            const row = commit;
            const bytes = Buffer.byteLength(JSON.stringify(row));
            if (selected.length && responseBytes + bytes > 15 * 1024 * 1024) break;
            selected.push(row);
            responseBytes += bytes;
          }
          const result = { ledgerId: grant.ledgerId, serverId, replicaId: replica.replicaId, streamEpoch: replica.streamEpoch,
            requiredCapabilities: await store.listLedgerRequirements(grant.username, grant.ledgerId, replica.replicaId),
            commits: selected, headSeq: page.headSeq, nextSeq: selected.at(-1)?.seq ?? after,
            hasMore: (selected.at(-1)?.seq ?? after) < page.headSeq };
          return signedJson(result);
        }
        let body: JsonRecord;
        try {
          const parsed: unknown = JSON.parse(Buffer.from(requestBytes).toString('utf8'));
          if (!isRecord(parsed)) throw new Error('invalid payload');
          body = parsed;
        } catch { return send(res, 400, { code: 'INVALID_COMMIT', error: 'invalid replication batch' }); }
        const commits = initialEncryptedCommits(body.commits, grant.ledgerId, true);
        const requiredCapabilities = body.requiredCapabilities;
        if (!Array.isArray(requiredCapabilities) || requiredCapabilities.length > 32
          || requiredCapabilities.some((value) => typeof value !== 'string' || value.length > 80)) {
          return send(res, 400, { code: 'INVALID_CAPABILITY', error: 'invalid required capabilities' });
        }
        const pushed = await store.pushCommits(grant.username, commits, ['asset-cost-v2'], requiredCapabilities as string[], 'node', replica.replicaId);
        const result = { serverId, replicaId: replica.replicaId, streamEpoch: replica.streamEpoch, assigned: pushed.assigned, headSeq: pushed.replica.headSeq };
        return signedJson(result);
      }

      if (req.method === 'GET' && apiPath === '/api/auth/federation/providers') {
        const links = await store.listNodeReplicationLinks();
        const peers = links.map((link) => ({ issuerNodeId: link.peerNodeId,
          issuerUrl: link.peerUrl, linkId: link.linkId, ledgerId: link.ledgerId }));
        return send(res, 200, { providers: peers });
      }
      if (req.method === 'GET' && apiPath === '/api/auth/federation/start') {
        if (!await ledgerWebAccess()) return send(res, 403,
          { code: 'LEDGER_WEB_ACCESS_DISABLED', error: '管理员已关闭通过本站网页记账' });
        const issuerNodeId = url.searchParams.get('issuer');
        const selectedLinkId = url.searchParams.get('link');
        const browserOrigin = origin.browserOrigin(req);
        if (!browserOrigin || !issuerNodeId) return send(res, 400, { error: '统一登录来源无效' });
        const links = (await store.listNodeReplicationLinks()).filter((link) => link.peerNodeId === issuerNodeId
          && (!selectedLinkId || link.linkId === selectedLinkId));
        if (links.length !== 1) return send(res, 409, { error: '统一登录节点不存在或账号不唯一' });
        const link = links[0]!;
        const callbackUrl = `${browserOrigin}${basePath}/api/auth/federation/callback`;
        const intent = createFederatedLoginIntent(nodeIdentity, issuerNodeId, link.grantId, callbackUrl);
        await store.createFederatedLoginState(intent.state, link.linkId);
        const secure = browserOrigin.startsWith('https://') ? '; Secure' : '';
        res.setHeader('Set-Cookie', `zichan_federation_state=${intent.state}; Path=${basePath || ''}/api/auth/federation; HttpOnly; SameSite=Lax; Max-Age=300${secure}`);
        const destination = new URL(`${link.peerUrl}/api/auth/federation/authorize`);
        destination.searchParams.set('request', encodeFederatedLoginIntent(intent));
        res.writeHead(302, { Location: destination.toString(), 'Cache-Control': 'no-store' });
        res.end();
        return;
      }
      if (req.method === 'GET' && apiPath === '/api/auth/federation/authorize') {
        const encoded = url.searchParams.get('request') ?? '';
        const intent = decodeFederatedLoginIntent(encoded);
        const grant = intent ? await store.getNodeReplicationGrant(intent.grantId) : undefined;
        if (!intent || !grant || grant.peerNodeId !== intent.targetNodeId || grant.revokedAt
          || grant.expiresAt <= nowIso() || !verifyFederatedLoginIntent(intent, grant.peerPublicKey, serverId, grant.grantId)) {
          return send(res, 403, { error: '统一登录目标未获授权或请求已过期' });
        }
        const refreshToken = browserSession.read(req);
        const sessionId = refreshToken?.split('.')[0];
        const session = sessionId ? await store.getSession(sessionId) : undefined;
        const account = session ? await store.getUser(session.username) : undefined;
        if (!refreshToken || !session || !account || account.disabled || session.revokedAt || session.expiresAt <= nowIso()
          || !safeEqual(session.refreshHash, opaqueHash(secret, refreshToken))) {
          const login = `${encodeURI(basePath)}/?federation=${encodeURIComponent(encoded)}`;
          res.writeHead(302, { Location: login, 'Cache-Control': 'no-store' });
          res.end();
          return;
        }
        const code = await store.issueFederatedLoginCode(grant.grantId, account.username, account.accountId, intent.state);
        const callback = new URL(intent.callbackUrl);
        callback.searchParams.set('state', intent.state);
        callback.searchParams.set('code', code);
        res.writeHead(302, { Location: callback.toString(), 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer' });
        res.end();
        return;
      }
      if (req.method === 'GET' && apiPath === '/api/auth/federation/callback') {
        if (!await ledgerWebAccess()) return send(res, 403,
          { code: 'LEDGER_WEB_ACCESS_DISABLED', error: '管理员已关闭通过本站网页记账' });
        const state = url.searchParams.get('state') ?? '';
        const code = url.searchParams.get('code') ?? '';
        const stateCookie = (req.headers.cookie ?? '').split(';').map((part) => part.trim())
          .find((part) => part.startsWith('zichan_federation_state='))?.slice('zichan_federation_state='.length);
        if (!/^[A-Za-z0-9_-]{43}$/.test(state) || !/^[A-Za-z0-9_-]{43}$/.test(code) || stateCookie !== state) {
          return send(res, 403, { error: '统一登录状态无效' });
        }
        const linkId = await store.consumeFederatedLoginState(state);
        const link = linkId ? (await store.listNodeReplicationLinks()).find((item) => item.linkId === linkId) : undefined;
        if (!link) return send(res, 403, { error: '统一登录状态已过期或链路已停用' });
        const assertion = await signedCall(nodeIdentity, link, 'POST', '/api/v4/identity/exchange', JSON.stringify({ code, state }));
        const binding = await store.federatedAccount(link.username);
        if (assertion.issuerNodeId !== link.peerNodeId
          || typeof assertion.subjectAccountId !== 'string'
          || assertion.ledgerId !== link.ledgerId) {
          return send(res, 403, { error: '统一账号映射不匹配' });
        }
        if (!(binding?.issuerNodeId === link.peerNodeId
          && binding.subjectAccountId === assertion.subjectAccountId
          && binding.ledgerId === link.ledgerId)) {
          return send(res, 403, { error: '统一账号不属于当前账本' });
        }
        const memberUsername = link.username;
        const user = await store.getUser(memberUsername);
        if (!user || user.disabled) return send(res, 403, { error: '本地账号不可用' });
        const linkedReplica = await store.getReplicaForLedger(link.username, link.ledgerId);
        if (!linkedReplica || linkedReplica.ledgerId !== link.ledgerId) {
          return send(res, 409, { error: '统一登录账本副本已改变' });
        }
        const newSessionId = `session-${randomBytes(16).toString('hex')}`;
        const localRefreshToken = createRefreshToken(newSessionId);
        await store.createSession({ expectedRegistrationRecord: user.opaqueRegistrationRecord,
          id: newSessionId, username: user.username, deviceId: `federated-${randomBytes(12).toString('hex')}`,
          deviceName: 'Federated Browser', refreshHash: opaqueHash(secret, localRefreshToken),
          expiresAt: new Date(Date.now() + SESSION_TTL_MS).toISOString(), ip,
          replicaId: linkedReplica.replicaId });
        await store.noteLogin(user.username);
        browserSession.write(req, res, localRefreshToken);
        const sessionCookie = res.getHeader('Set-Cookie');
        res.setHeader('Set-Cookie', [String(sessionCookie),
          `zichan_federation_state=; Path=${basePath || ''}/api/auth/federation; HttpOnly; SameSite=Lax; Max-Age=0`]);
        await log('info', 'federated_login_success', 'Federated identity created a node-local session', {
          ip, username: user.username, detail: { issuerNodeId: link.peerNodeId, sessionId: newSessionId },
        });
        res.writeHead(303, { Location: `${encodeURI(basePath)}/`, 'Cache-Control': 'no-store' });
        res.end();
        return;
      }

      if (req.method === 'POST' && apiPath === '/api/auth/password-reset/email/request') {
        const body = await readBody(req, 1024);
        const username = typeof body.username === 'string' ? normalizeSyncUsername(body.username) : '';
        if (!/^[\p{L}\p{N}_.-]{2,64}$/u.test(username)) {
          return send(res, 400, { code: 'INVALID_USERNAME', error: '账号名无效' });
        }
        if (!accountEmailAvailable()) return send(res, 503,
          { code: 'EMAIL_UNAVAILABLE', error: '本站尚未配置账号找回邮件' });
        const code = randomBytes(32).toString('base64url');
        const codeHash = createHash('sha256').update(code).digest('hex');
        const issued = await store.issueEmailPasswordReset(username, codeHash,
          new Date(Date.now() + 15 * 60_000).toISOString());
        if (issued) {
          try {
            await sendAccountMessage(issued.email, '资产账本账号密码重置码',
              `您的账号密码重置码：${code}\n\n15 分钟内有效，只能使用一次。若您没有请求重置，请忽略此邮件。`);
          } catch (error) {
            await store.revokeEmailPasswordReset(issued.accountId, codeHash);
            await log('error', 'password_reset_email_failed', 'Password reset email delivery failed',
              { ip, username, detail: { error: String(error) } });
          }
        }
        res.setHeader('Cache-Control', 'no-store');
        return send(res, 200, { ok: true,
          message: '如果该账号已验证邮箱且未超过发送次数，重置码会发送到已验证邮箱。' });
      }
      if (req.method === 'POST' && (apiPath === '/api/auth/register/start' || apiPath === '/api/auth/password-reset/start')) {
        const resettingPassword = apiPath === '/api/auth/password-reset/start';
        const { username: rawUsername, displayName: rawDisplayName, registrationRequest, inviteCode, ownerSetupToken: suppliedSetup, initializeOwner, passwordResetCode } = await readBody(req, AUTH_BODY_BYTES);
        const username = typeof rawUsername === 'string' ? normalizeSyncUsername(rawUsername) : '';
        const displayName = typeof rawDisplayName === 'string' ? rawDisplayName.trim().normalize('NFC') : undefined;
        if (!/^[\p{L}\p{N}_.-]{2,64}$/u.test(username)
          || (rawDisplayName !== undefined && (typeof rawDisplayName !== 'string' || !displayName || Array.from(displayName).length > 24 || /[\p{Cc}\p{Cf}]/u.test(displayName)))
          || typeof registrationRequest !== 'string'
          || !registrationRequest
          || registrationRequest.length > AUTH_BODY_BYTES
          || (inviteCode != null && (typeof inviteCode !== 'string' || inviteCode.length > 256))) {
          return send(res, 400, { error: 'invalid registration fields' });
        }
        const normalizedInvite = typeof inviteCode === 'string' ? inviteCode : undefined;
        let passwordResetHash: string | undefined;
        if (resettingPassword) {
          if (typeof passwordResetCode !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(passwordResetCode)) return send(res, 403, { code: 'INVALID_PASSWORD_RESET', error: '重置码无效、已使用或已过期' });
          passwordResetHash = createHash('sha256').update(passwordResetCode).digest('hex');
          await store.assertPasswordReset(username, passwordResetHash);
        }
        const webSetup = initializeOwner === true;
        if (webSetup && (req.headers['x-zichan-session'] !== 'admin-cookie' || !browserSession.requested(req))) {
          return send(res, 403, { code: 'SESSION_ORIGIN_REJECTED', error: 'owner initialization requires the same-origin management page' });
        }
        const claimOwner = webSetup || suppliedSetup !== undefined;
        if (!webSetup && claimOwner && (typeof suppliedSetup !== 'string' || !safeEqual(suppliedSetup, ownerSetupToken))) {
          return send(res, 403, { code: 'INVALID_OWNER_SETUP', error: 'invalid owner setup secret' });
        }
        if (!resettingPassword) {
          if (!claimOwner && !await ledgerWebAccess()) return send(res, 403,
            { code: 'LEDGER_WEB_ACCESS_DISABLED', error: '管理员已关闭通过本站网页记账' });
          const group = !claimOwner ? await store.serverSyncGroup() : undefined;
          if (group?.role === 'member') {
            const checked = await signedCall(nodeIdentity, { peerUrl: group.mainUrl,
              peerPublicKey: group.mainPublicKey, grantId: group.groupId },
            'POST', '/api/v4/group/account/check', JSON.stringify({ username,
              ...(normalizedInvite ? { inviteCode: normalizedInvite } : {}) }));
            if (checked.groupId !== group.groupId || checked.serverId !== group.mainNodeId
              || checked.available !== true || !isRecord(checked.registrationPolicy)) {
              return send(res, 409, { code: 'GROUP_REGISTRATION_REJECTED', error: '主节点未核准账号注册' });
            }
            await store.applyJoinedRegistrationPolicy(group.mainNodeId,
              checked.registrationPolicy.mode as 'open' | 'invite' | 'closed',
              Number(checked.registrationPolicy.revision));
          }
          await store.assertRegistrationAllowed(normalizedInvite, claimOwner);
          if (await store.getUser(username) || await store.federatedPasswordCredential(username)) {
            return send(res, 409, { code: 'USER_EXISTS', error: 'user exists' });
          }
        }
        let registrationResponse: string;
        const registrationSetup = opaque.server.createSetup();
        try {
          registrationResponse = opaque.server.createRegistrationResponse({
            serverSetup: registrationSetup,
            userIdentifier: username,
            registrationRequest,
          }).registrationResponse;
        } catch {
          return send(res, 400, { error: 'invalid registration request' });
        }
        const expiresAt = Date.now() + OPAQUE_REGISTRATION_TTL_MS;
        const registrationToken = signToken(secret, {
          purpose: resettingPassword ? 'opaque-password-reset' : 'opaque-registration',
          ...(passwordResetHash ? { passwordResetHash } : {}),
          ...(claimOwner ? { claimOwner: true } : {}),
          ...(webSetup ? { ownerSetupOrigin: req.headers.origin } : {}),
          username,
          ...(displayName && !resettingPassword ? { displayName } : {}),
          ...(normalizedInvite ? { inviteCode: normalizedInvite } : {}),
          exp: expiresAt,
        });
        await store.savePendingOpaqueSetup(createHash('sha256').update(registrationToken).digest('hex'),
          username, registrationSetup, new Date(expiresAt).toISOString());
        return send(res, 200, {
          registrationResponse,
          registrationToken,
          serverId,
          serverPublicKey: opaqueServerPublicKey,
          credentialServerPublicKey: opaque.server.getPublicKey(registrationSetup),
        });
      }
      if (req.method === 'POST' && (apiPath === '/api/auth/register/finish' || apiPath === '/api/auth/password-reset/finish')) {
        const resettingPassword = apiPath === '/api/auth/password-reset/finish';
        const { registrationToken, registrationRecord } = await readBody(req, AUTH_BODY_BYTES);
        const claims = typeof registrationToken === 'string' ? verifyToken(secret, registrationToken) : null;
        if (claims?.purpose !== (resettingPassword ? 'opaque-password-reset' : 'opaque-registration')
          || typeof claims.username !== 'string'
          || typeof registrationRecord !== 'string'
          || !registrationRecord
          || registrationRecord.length > AUTH_BODY_BYTES) {
          return send(res, 400, { error: 'invalid registration completion' });
        }
        if (claims.ownerSetupOrigin && (req.headers.origin !== claims.ownerSetupOrigin
          || req.headers['x-zichan-session'] !== 'admin-cookie' || !browserSession.requested(req))) {
          return send(res, 403, { code: 'SESSION_ORIGIN_REJECTED', error: 'owner initialization origin changed' });
        }
        const registrationSetup = await store.consumePendingOpaqueSetup(
          createHash('sha256').update(registrationToken as string).digest('hex'), claims.username);
        if (!registrationSetup) return send(res, 409,
          { code: 'REGISTRATION_EXPIRED', error: '注册或改密流程已过期，请重新开始' });
        if (resettingPassword) {
          if (typeof claims.passwordResetHash !== 'string') return send(res, 400, { error: 'invalid password reset completion' });
          await store.completePasswordReset(claims.username, claims.passwordResetHash,
            registrationRecord, registrationSetup);
          res.setHeader('Cache-Control', 'no-store');
          return send(res, 200, { ok: true, serverId, role: await store.roleForUser(claims.username) });
        }
        const group = claims.claimOwner === true ? undefined : await store.serverSyncGroup();
        let groupAccountId: string | undefined;
        if (group?.role === 'member') {
          groupAccountId = `account-${randomBytes(16).toString('hex')}`;
          const bundle = { v: 1 as const, ledgerId: group.groupId,
            issuerNodeId: serverId, subjectAccountId: groupAccountId,
            username: claims.username, displayName: claims.displayName ?? claims.username,
            registrationRecord, serverSetup: registrationSetup,
            disabled: false, revision: 1 };
          const accepted = await signedCall(nodeIdentity, { peerUrl: group.mainUrl,
            peerPublicKey: group.mainPublicKey, grantId: group.groupId },
          'POST', '/api/v4/group/account', JSON.stringify({ bundle,
            issuerSignature: signFederatedCredential(nodeIdentity, bundle),
            ...(claims.inviteCode ? { inviteCode: claims.inviteCode } : {}) }));
          if (accepted.groupId !== group.groupId || accepted.serverId !== group.mainNodeId
            || accepted.issuerNodeId !== serverId || accepted.subjectAccountId !== groupAccountId
            || accepted.username !== claims.username) {
            return send(res, 409, { code: 'GROUP_REGISTRATION_REJECTED', error: '主节点账号确认无效' });
          }
        }
        const registration = await store.register(claims.username, registrationRecord, claims.inviteCode,
          claims.claimOwner === true, claims.displayName, registrationSetup, groupAccountId);
        await log('info', 'register_success', 'Registered sync user', {
          ip,
          username: claims.username,
          detail: { role: registration.role },
        });
        return send(res, 200, { ok: true, serverId, role: registration.role });
      }
      if (req.method === 'POST' && apiPath === '/api/auth/login/start') {
        const { username: rawUsername, startLoginRequest, sessionContext } = await readBody(req, AUTH_BODY_BYTES);
        const username = typeof rawUsername === 'string' ? normalizeSyncUsername(rawUsername) : '';
        if (!/^[\p{L}\p{N}_.-]{2,64}$/u.test(username)
          || typeof startLoginRequest !== 'string'
          || !startLoginRequest
          || startLoginRequest.length > AUTH_BODY_BYTES) {
          return send(res, 400, { error: 'invalid login fields' });
        }
        const localUser = await store.getUser(username);
        const federatedCredential = sessionContext === 'ledger' || !localUser
          ? await store.federatedPasswordCredential(username) : undefined;
        const user = federatedCredential
          ? await store.getUser(federatedCredential.localUsername) : localUser;
        const loginRecord = federatedCredential
          ? federatedCredential.disabled ? undefined : federatedCredential.registrationRecord
          : user?.opaqueRegistrationRecord === FEDERATED_ONLY_RECORD
            ? undefined : user?.opaqueRegistrationRecord;
        const credentialServerId = federatedCredential?.issuerNodeId ?? serverId;
        const credentialSetup = federatedCredential?.serverSetup
          ?? (user ? await store.opaqueSetupForUser(user.username) : undefined) ?? opaqueServerSetup;
        let login: ReturnType<typeof opaque.server.startLogin>;
        try {
          login = opaque.server.startLogin({
            serverSetup: credentialSetup,
            registrationRecord: loginRecord,
            startLoginRequest,
            userIdentifier: username,
            identifiers: { client: username, server: credentialServerId },
          });
        } catch {
          return send(res, 400, { error: 'invalid login request' });
        }
        const loginState = await store.createOpaqueLoginState(
          user?.username ?? username,
          JSON.stringify({ state: login.serverLoginState,
            credentialHash: createHash('sha256').update(loginRecord ?? '').digest('hex'),
            clientIdentifier: username, serverIdentifier: credentialServerId,
            federated: Boolean(federatedCredential) }),
          ip,
          new Date(Date.now() + OPAQUE_LOGIN_TTL_MS).toISOString(),
        );
        return send(res, 200, {
          loginId: loginState.id,
          loginResponse: login.loginResponse,
          serverId,
          serverPublicKey: opaqueServerPublicKey,
          credentialServerPublicKey: opaque.server.getPublicKey(credentialSetup),
          credentialServerId,
          credentialClientId: username,
        });
      }
      if (req.method === 'POST' && apiPath === '/api/auth/login/finish') {
        // Validate the transport up front: a cross-site management login is refused here, before
        // a second-factor challenge is even created. The session itself is written later, once
        // every factor has been proven.
        void browserSession.requested(req);
        const { loginId, finishLoginRequest, deviceId, deviceName } = await readBody(req, AUTH_BODY_BYTES);
        const consumed = typeof loginId === 'string'
          ? await store.consumeOpaqueLoginState(loginId, ip)
          : { state: undefined, reason: 'invalid_state_id' as const };
        const loginState = consumed.state;
        const user = loginState ? await store.getUser(loginState.username) : undefined;
        let authenticated = false;
        let failureReason: string = consumed.reason ?? 'invalid_proof';
        if (loginState && typeof finishLoginRequest === 'string' && finishLoginRequest.length <= AUTH_BODY_BYTES) {
          try {
            const stored = JSON.parse(loginState.serverLoginState) as {
              state: string; credentialHash: string; clientIdentifier?: string;
              serverIdentifier?: string; federated?: boolean;
            };
            const credential = stored.federated && stored.clientIdentifier
              ? await store.federatedPasswordCredential(stored.clientIdentifier) : undefined;
            const currentRecord = credential && credential.localUsername === loginState.username
              && !credential.disabled ? credential.registrationRecord
              : stored.federated ? undefined : user?.opaqueRegistrationRecord;
            if (!user || !currentRecord || stored.credentialHash !== createHash('sha256').update(currentRecord).digest('hex')) {
              failureReason = 'credentials_changed';
              throw new Error('credentials changed');
            }
            opaque.server.finishLogin({
              serverLoginState: stored.state,
              finishLoginRequest,
              identifiers: { client: stored.clientIdentifier ?? loginState.username,
                server: stored.serverIdentifier ?? serverId },
            });
            authenticated = Boolean(user);
          } catch {
            authenticated = false;
          }
        } else if (loginState) {
          failureReason = 'invalid_finish_request';
        }
        if (!authenticated || !user) {
          await log('warn', 'login_failed', 'Login failed', { ip, username: loginState?.username,
            status: 401, detail: { reason: failureReason } });
          return send(res, 401, { error: 'invalid credentials' });
        }
        if (user.disabled) {
          await log('warn', 'login_disabled', 'Disabled sync user attempted login', { ip, username: user.username, status: 403 });
          return send(res, 403, { error: 'user disabled' });
        }
        const identity = deviceIdentityOf({ deviceId, deviceName });
        if (!identity) return send(res, 400, { error: 'invalid device identity' });

        const adminContext = req.headers['x-zichan-session'] === 'admin-cookie';
        // Second factor. The password is only half the proof for a management account, so a
        // session is not created yet: the console gets a short-lived challenge to answer.
        if (await mfa.requiredFor(user.username, { manage: adminContext, policy: requireAdminMfa() })) {
          const enrollment = await mfa.status(user.username);
          if (!enrollment.enabled) {
            await log('warn', 'login_mfa_enrollment_required', 'Administrator without MFA was refused at login', { ip, username: user.username, status: 403 });
            return send(res, 403, {
              code: 'MFA_ENROLLMENT_REQUIRED',
              error: '服务器要求管理员启用两步验证。请先在可信环境完成绑定，或由所有者暂时关闭该要求',
            });
          }
          const challenge = await mfa.createChallenge(user.username, adminContext, ip);
          await log('info', 'login_mfa_challenge', 'Password accepted, second factor requested', { ip, username: user.username });
          return send(res, 200, { mfaRequired: true, methods: ['totp'], ...challenge });
        }

        return send(res, 200, await completeLogin({
          user,
          deviceId: identity.deviceId,
          deviceName: identity.deviceName,
          ip,
          adminContext,
          request: req,
          response: res,
        }));
      }
      if (req.method === 'POST' && apiPath === '/api/auth/login/mfa') {
        const body = await readBody(req, AUTH_BODY_BYTES);
        const { challenge, code } = body;
        if (typeof challenge !== 'string' || typeof code !== 'string' || !code.trim()) {
          return send(res, 400, { error: 'invalid second factor request' });
        }
        const identity = deviceIdentityOf(body);
        if (!identity) return send(res, 400, { error: 'invalid device identity' });
        // The factor only guards management logins, so the console context is required here too.
        const adminContext = req.headers['x-zichan-session'] === 'admin-cookie';
        if (!adminContext) {
          return send(res, 400, { code: 'MFA_ADMIN_CONTEXT_REQUIRED', error: '两步验证只用于管理后台登录' });
        }
        const result = await mfa.verifyChallenge(challenge, code, adminContext);
        if (!result.ok) {
          const status = result.reason === 'expired' ? 410 : result.reason === 'consumed' ? 409 : result.reason === 'attempts' ? 429 : 401;
          await log('warn', 'login_mfa_failed', 'Second factor rejected', { ip, status, detail: { reason: result.reason ?? 'invalid' } });
          return send(res, status, {
            code: `MFA_${String(result.reason ?? 'invalid').toUpperCase()}`,
            error: '两步验证未通过，请重新核对验证码或使用恢复码',
          });
        }
        const user = await store.getUser(result.username ?? '');
        if (!user || user.disabled) {
          await log('warn', 'login_disabled', 'Disabled sync user attempted login', { ip, username: result.username, status: 403 });
          return send(res, 403, { error: 'user disabled' });
        }
        await log('info', 'login_mfa_success', 'Second factor accepted', { ip, username: user.username, detail: { method: result.method } });
        return send(res, 200, await completeLogin({
          user,
          deviceId: identity.deviceId,
          deviceName: identity.deviceName,
          ip,
          adminContext,
          request: req,
          response: res,
        }));
      }
      if (req.method === 'POST' && apiPath === '/api/auth/refresh') {
        const cookieSession = browserSession.requested(req);
        const body = await readBody(req, AUTH_BODY_BYTES);
        if (cookieSession && body.refreshToken !== undefined) return send(res, 400, { code: 'MIXED_SESSION_TRANSPORT', error: 'cookie sessions do not accept body tokens' });
        const refreshToken = cookieSession ? browserSession.read(req) : body.refreshToken;
        const sessionId = typeof refreshToken === 'string' ? refreshToken.split('.')[0] ?? '' : '';
        const session = sessionId ? await store.getSession(sessionId) : undefined;
        const user = session ? await store.getUser(session.username) : undefined;
        const suppliedHash = typeof refreshToken === 'string' ? opaqueHash(secret, refreshToken) : '';
        if (!session || !user || user.disabled || session.revokedAt || session.expiresAt <= nowIso()
          || !safeEqual(session.refreshHash, suppliedHash)) {
          await log('warn', 'refresh_failed', 'Session refresh failed', { ip, username: user?.username, status: 401 });
          if (cookieSession) browserSession.write(req, res);
          return send(res, 401, { error: 'invalid refresh token' });
        }
        if (session.kind !== 'admin' && !await ledgerWebAccess()) return send(res, 403,
          { code: 'LEDGER_WEB_ACCESS_DISABLED', error: '管理员已关闭通过本站网页记账' });
        const nextRefreshToken = createRefreshToken(session.id);
        const rotated = await store.rotateSessionRefresh(session.id, session.refreshHash, opaqueHash(secret, nextRefreshToken), ip);
        if (!rotated) return send(res, 401, { error: 'refresh token already used' });
        const replica = await store.getReplica(user.username, rotated.replicaId);
        if (cookieSession) browserSession.write(req, res, nextRefreshToken);
        return send(res, 200, {
          ...issueAccessToken(rotated),
          accountId: user.accountId,
          ...(cookieSession ? { sessionTransport: 'cookie' } : { refreshToken: nextRefreshToken }),
          session: publicSession(rotated),
          role: await store.roleForUser(user.username),
          ...(replica ? { ledgerId: replica.ledgerId, replicaId: replica.replicaId,
            streamEpoch: replica.streamEpoch } : {}),
        });
      }

      // Logout must still clear the HttpOnly cookie after an access token expires.
      if (req.method === 'POST' && apiPath === '/api/auth/logout' && browserSession.requested(req)) {
        const refreshToken = browserSession.read(req);
        const sessionId = refreshToken?.split('.')[0];
        const current = sessionId ? await store.getSession(sessionId) : undefined;
        if (current && refreshToken && safeEqual(current.refreshHash, opaqueHash(secret, refreshToken))) {
          await store.revokeSession(current.id, current.username);
          await log('info', 'logout', 'Browser session logged out', { ip, username: current.username, detail: { sessionId: current.id } });
        }
        browserSession.write(req, res);
        return send(res, 200, { ok: true });
      }
      const auth = await authenticateRequest(req);
      if (!auth) {
        return send(res, 401, { error: 'unauthorized' });
      }
      const { user, session } = auth;
      if (req.method === 'GET' && apiPath === '/api/v4/group/status') {
        const group = await store.serverSyncGroup();
        const members = group ? await store.serverSyncGroupMembers() : [];
        return send(res, 200, { joined: Boolean(group),
          ...(group ? { localNodeId: serverId, memberCount: members.length,
            members: members.map((member) => {
              let label: string;
              try { label = new URL(member.nodeUrl).host; }
              catch { label = `服务器 ${member.nodeId.slice(0, 8)}`; }
              return { nodeId: member.nodeId, label };
            }) } : {}) });
      }
      if (!await ledgerWebAccess() && (session.kind !== 'admin'
        || apiPath.startsWith('/api/v3/') || apiPath.startsWith('/api/v4/'))) {
        return send(res, 403, { code: 'LEDGER_WEB_ACCESS_DISABLED',
          error: '管理员已关闭通过本站网页记账' });
      }
      if (Date.now() - Date.parse(session.lastSeenAt) > 5 * 60 * 1000) await store.touchSession(session.id, ip);

      if (req.method === 'GET' && apiPath === '/api/auth/me') {
        const replica = await store.getReplica(user.username, session.replicaId);
        const federatedIdentity = await store.federatedAccount(user.username);
        return send(res, 200, {
          username: user.username,
          loginUsername: await store.federatedSourceUsername(user.username) ?? user.username,
          displayName: user.displayName,
          role: auth.role,
          accountId: user.accountId,
          federatedIdentity: federatedIdentity ?? null,
          disabled: false,
          session: publicSession(session),
          ...(replica ? {
            ledgerId: replica.ledgerId,
            replicaId: replica.replicaId,
            streamEpoch: replica.streamEpoch,
          } : {}),
        });
      }
      if (req.method === 'PUT' && apiPath === '/api/auth/profile') {
        if (await store.federatedAccount(user.username)) return send(res, 403,
          { code: 'ISSUER_REQUIRED', error: '统一账号昵称请在创建账号的身份源节点修改' });
        const body = await readBody(req, 1024);
        const displayName = typeof body.displayName === 'string' ? body.displayName.trim().normalize('NFC') : '';
        if (!displayName || Array.from(displayName).length > 24 || /[\p{Cc}\p{Cf}]/u.test(displayName)) {
          return send(res, 400, { code: 'INVALID_DISPLAY_NAME', error: '昵称请填写 1 至 24 个字符，不能包含控制字符' });
        }
        await store.setDisplayName(user.username, displayName);
        return send(res, 200, { username: user.username, displayName });
      }
      if (req.method === 'POST' && apiPath === '/api/v4/sync-runs') {
        const runReplica = await store.getReplica(user.username, session.replicaId);
        if (!runReplica) throw new ServerStoreError('REPLICA_UNBOUND', 409, 'bind a ledger first');
        const body = await readBody(req, 2048);
        await store.recordAccountSyncRun(user.username, runReplica.replicaId, {
          runId: String(body.runId ?? ''),
          outcome: String(body.outcome ?? '') as 'converged' | 'partial' | 'failed',
          pulled: Number(body.pulled), pushed: Number(body.pushed),
          attachmentUploads: Number(body.attachmentUploads),
          attachmentDownloads: Number(body.attachmentDownloads),
          durationMs: Number(body.durationMs),
        });
        return send(res, 200, { ok: true });
      }
      if (req.method === 'GET' && apiPath === '/api/auth/usage') {
        const currentReplica = await store.getReplica(user.username, session.replicaId);
        const [commits, attachments, transfer] = await Promise.all([
          store.commitUsage(user.username, session.replicaId),
          blobStore.usage(user.username, currentReplica?.ledgerId),
          store.accountTransfer(user.username),
        ]);
        res.setHeader('Cache-Control', 'no-store');
        return send(res, 200, { commits, attachments, transfer });
      }
      if (apiPath === '/api/auth/email' || apiPath.startsWith('/api/auth/email/')) res.setHeader('Cache-Control', 'no-store');
      if (apiPath === '/api/auth/email' || apiPath.startsWith('/api/auth/email/')) {
        if (await store.federatedAccount(user.username)) {
          if (req.method === 'GET' && apiPath === '/api/auth/email') {
            return send(res, 200, { federated: true, available: false, quotaNotifications: false });
          }
          return send(res, 403,
            { code: 'ISSUER_REQUIRED', error: '统一账号邮箱请在创建账号的身份源节点管理' });
        }
      }
      if (req.method === 'GET' && apiPath === '/api/auth/email') {
        return send(res, 200, { ...await store.accountEmail(user.username), available: accountEmailAvailable() });
      }
      if (req.method === 'POST' && apiPath === '/api/auth/email/request') {
        const body = await readBody(req, 1024);
        const email = typeof body.email === 'string' ? body.email.trim().toLowerCase() : '';
        if (email.length > 254 || !/^[^\s@,<>]+@[^\s@,<>]+\.[^\s@,<>]+$/.test(email)) return send(res, 400, { code: 'INVALID_EMAIL', error: '请输入有效邮箱地址' });
        if (!accountEmailAvailable()) return send(res, 503, { code: 'EMAIL_UNAVAILABLE', error: '服务器尚未配置可用的邮件发送渠道' });
        const code = randomInt(100_000_000).toString().padStart(8, '0');
        const hash = createHmac('sha256', secret).update(`${user.username}:${code}`).digest('hex');
        await store.startEmailVerification(user.username, email, hash);
        try {
          await sendAccountMessage(email, '资产账本邮箱验证码', `您的邮箱验证码是：${code}\n\n验证码 10 分钟内有效。若您没有请求验证，请忽略此邮件。`);
        } catch (error) {
          await store.clearPendingEmailVerification(user.username, hash);
          await log('warn', 'account_email_verification_send_failed', 'Account email verification delivery failed', { username: user.username, detail: { reason: error instanceof Error ? error.message : String(error) } });
          return send(res, 503, { code: 'EMAIL_SEND_FAILED', error: '邮件发送失败，请稍后重试' });
        }
        await log('info', 'account_email_verification_sent', 'Account email verification sent', { username: user.username });
        return send(res, 200, { pendingEmail: email, expiresInSeconds: 600 });
      }
      if (req.method === 'POST' && apiPath === '/api/auth/email/verify') {
        const body = await readBody(req, 1024);
        if (typeof body.code !== 'string' || !/^\d{8}$/.test(body.code)) return send(res, 400, { code: 'INVALID_EMAIL_CODE', error: '请输入邮件中的 8 位验证码' });
        const hash = createHmac('sha256', secret).update(`${user.username}:${body.code}`).digest('hex');
        await store.completeEmailVerification(user.username, hash);
        await log('info', 'account_email_verified', 'Account email verified', { username: user.username });
        return send(res, 200, await store.accountEmail(user.username));
      }
      if (req.method === 'PUT' && apiPath === '/api/auth/email/preferences') {
        const body = await readBody(req, 1024);
        if (typeof body.quotaNotifications !== 'boolean') return send(res, 400, { error: '通知开关无效' });
        await store.setQuotaEmailNotifications(user.username, body.quotaNotifications);
        return send(res, 200, await store.accountEmail(user.username));
      }
      if (req.method === 'DELETE' && apiPath === '/api/auth/email') {
        await store.removeAccountEmail(user.username);
        await log('info', 'account_email_removed', 'Account email removed', { username: user.username });
        return send(res, 200, await store.accountEmail(user.username));
      }
      if (isAdmin) {
        if (auth.role === 'member') {
          await log('warn', 'admin_forbidden', 'Member attempted an administrative request', {
            ip,
            username: auth.user.username,
            status: 403,
            detail: { requestId },
          });
          return send(res, 403, { code: 'ADMIN_REQUIRED', error: 'administrator role required', requestId });
        }
        return await admin.handle(req, res, apiPath, {
          user: { username: user.username, accountId: user.accountId, disabled: user.disabled },
          session: { id: session.id, createdAt: session.createdAt, expiresAt: session.expiresAt, kind: session.kind },
          role: auth.role,
        }, requestId);
      }

      if (req.method === 'POST' && apiPath === '/api/auth/password-change/authorize') {
        const code = randomBytes(32).toString('base64url');
        const expiresAt = new Date(Date.now() + 5 * 60_000).toISOString();
        await store.issueAccountRecovery(createHash('sha256').update(code).digest('hex'), expiresAt, session.id);
        return send(res, 200, { code, expiresAt });
      }

      if (req.method === 'GET' && apiPath === '/api/auth/devices') {
        return send(res, 200, { devices: (await store.listSessions(user.username)).map(publicSession), currentSessionId: session.id });
      }
      const revokeDevice = /^\/api\/auth\/devices\/([^/]+)\/revoke$/.exec(apiPath);
      if (req.method === 'POST' && revokeDevice) {
        const revoked = await store.revokeSession(revokeDevice[1]!, user.username);
        if (!revoked) return send(res, 404, { error: 'session not found' });
        await log('info', 'device_revoked', 'User revoked a sync device session', { ip, username: user.username, detail: { sessionId: revoked.id, deviceId: revoked.deviceId } });
        return send(res, 200, { device: publicSession(revoked) });
      }
      if (req.method === 'POST' && apiPath === '/api/auth/logout') {
        const cookieSession = browserSession.requested(req);
        await store.revokeSession(session.id, user.username);
        if (cookieSession) browserSession.write(req, res);
        await log('info', 'logout', 'Sync session logged out', { ip, username: user.username, detail: { sessionId: session.id } });
        return send(res, 200, { ok: true });
      }
      const replica = await store.getReplica(user.username, session.replicaId);
      const blobUsername = user.username;
      if (!replica && session.replicaId && (apiPath === '/api/v3/commits'
        || apiPath.startsWith('/api/v3/blobs/') || apiPath.startsWith('/api/v4/ledger/'))) {
        throw new ServerStoreError('LEDGER_ACCESS_DENIED', 403, '当前账号已失去此账本的访问权限');
      }
      if (replica && req.method !== 'GET' && req.method !== 'HEAD'
        && (isClientWrite(req.method ?? 'GET', apiPath) || apiPath.startsWith('/api/v4/ledger/'))
        && await store.replicaRetirement(replica.replicaId)) {
        return send(res, 409, { code: 'REPLICA_RETIRED',
          error: '本节点已移出副本组，当前账本禁止继续写入；请改用仍在组内的节点', requestId });
      }
      let secondarySelected = false;
      if (replica && session.replicaId) {
        const primary = await store.getReplica(user.username);
        secondarySelected = primary?.replicaId !== replica.replicaId;
        const legacyScoped = apiPath.startsWith('/api/v3/protection') && req.method !== 'GET'
          || apiPath === '/api/v3/key-envelope' && req.method !== 'GET'
          || apiPath === '/api/v3/replica/bind'
          || apiPath === '/api/v3/replica/replace'
          || apiPath.startsWith('/api/v3/replica/recovery');
        if (secondarySelected && legacyScoped) {
          throw new ServerStoreError('REPLICA_SCOPE_PENDING', 409,
            '此接口尚未完成多账本迁移，不能操作当前选择的第二账本');
        }
      }

      if (apiPath === '/api/v4/ledger/group-members' && req.method === 'GET') {
        if (!replica) throw new ServerStoreError('REPLICA_UNBOUND', 409, 'bind a ledger first');
        await store.assertLedgerAccess(user.username, 'manage', session.replicaId);
        res.setHeader('Cache-Control', 'no-store');
        return send(res, 200, { members: await store.listReplicaGroupMembers(replica.replicaId) });
      }
      const retireGroupMember = /^\/api\/v4\/ledger\/group-members\/([A-Za-z0-9_-]{8,128})$/.exec(apiPath);
      if (retireGroupMember && req.method === 'DELETE') {
        if (!replica) throw new ServerStoreError('REPLICA_UNBOUND', 409, 'bind a ledger first');
        await store.assertLedgerAccess(user.username, 'manage', session.replicaId);
        const nodeId = retireGroupMember[1]!;
        const activeMember = (await store.listReplicaGroupMembers(replica.replicaId))
          .some((member) => member.nodeId === nodeId && !member.retiredAt);
        if (!activeMember) return send(res, 404,
          { code: 'GROUP_MEMBER_MISSING', error: '副本组成员不存在或已移出' });
        const body = await readBody(req, 4096);
        const before = await store.replicaInventory(blobUsername, replica.ledgerId);
        const [physical, reports] = await Promise.all([
          store.replicaPhysicalStatus(blobUsername, replica.ledgerId),
          store.listNodeGroupMemberReports(blobUsername, replica.ledgerId),
        ]);
        const after = await store.replicaInventory(blobUsername, replica.ledgerId);
        const member = reports.find((item) => item.peerNodeId === nodeId);
        const memberHealth = member && assessReplicaGroupMember(after, member);
        const survivors = reports.filter((item) => item.peerNodeId !== nodeId)
          .map((item) => assessReplicaGroupMember(after, item));
        const localHealth = assessReplicaReadiness({ inventory: after, physical, links: [],
          verifiedLinkIds: new Set(), snapshotStable: JSON.stringify(before) === JSON.stringify(after) });
        const unverified = memberHealth?.state !== 'READY' || localHealth.state !== 'READY'
          || !survivors.length || survivors.some((item) => item.state !== 'READY');
        if (unverified && (body.confirmUnverifiedRemoval !== true || body.nodeId !== nodeId)) {
          return send(res, 409, { code: 'GROUP_MEMBER_NOT_VERIFIED',
            error: '移出后的副本组尚未核实为完整且有冗余；可能有未同步写入。核查后明确确认才能移出。',
            memberState: memberHealth?.state ?? 'MISSING', memberIssue: memberHealth?.issue,
            localIssues: localHealth.issues,
            survivingMembers: survivors });
        }
        const retired = await store.retireReplicaGroupMember(user.username, replica.replicaId, nodeId);
        if (!retired) return send(res, 404, { code: 'GROUP_MEMBER_MISSING', error: '副本组成员不存在或已移出' });
        await log('info', 'replica_group_member_retired', 'Ledger replica group member retired', {
          ip, username: user.username, detail: { ledgerId: replica.ledgerId, nodeId,
            unverified, memberState: memberHealth?.state ?? 'MISSING', localState: localHealth.state },
        });
        return send(res, 200, { ok: true, unverified });
      }
      if ((apiPath === '/api/v4/ledger/readiness' || apiPath === '/api/v4/ledger/group-health')
        && req.method === 'GET') {
        if (!replica) throw new ServerStoreError('REPLICA_UNBOUND', 409, 'bind a ledger first');
        await store.assertLedgerAccess(user.username, 'read', session.replicaId);
        res.setHeader('Cache-Control', 'no-store');
        const before = await store.replicaInventory(blobUsername, replica.ledgerId);
        const linksFor = () => store.listNodeReplicationLinks(blobUsername)
          .then((rows) => rows.filter((link) => link.ledgerId === replica.ledgerId && link.enabled));
        const links = await linksFor();
        const verifiedLinkIds = new Set<string>();
        const peerErrors = new Map<string, string>();
        await Promise.all(links.map(async (link) => {
          try {
            if (await verifyNodeReplicaInventory(store, nodeIdentity, link, before)) verifiedLinkIds.add(link.linkId);
          } catch (error) {
            peerErrors.set(link.linkId, error instanceof Error ? error.message : String(error));
          }
        }));
        const [after, physical, currentLinks] = await Promise.all([
          store.replicaInventory(blobUsername, replica.ledgerId),
          store.replicaPhysicalStatus(blobUsername, replica.ledgerId), linksFor(),
        ]);
        const topology = (rows: typeof links) => rows.map((link) =>
          [link.linkId, link.grantId, link.peerNodeId, link.peerReplicaId,
            link.localStreamEpoch, link.peerStreamEpoch]).sort((left, right) => String(left[0]).localeCompare(String(right[0])));
        const localReadiness = assessReplicaReadiness({ inventory: after, physical, links: currentLinks,
          verifiedLinkIds, peerErrors,
          snapshotStable: JSON.stringify(before) === JSON.stringify(after)
            && JSON.stringify(topology(links)) === JSON.stringify(topology(currentLinks)) });
        if (await store.replicaRetirement(replica.replicaId)) {
          localReadiness.state = 'VERIFYING';
          localReadiness.issues.push('本节点已移出副本组，禁止继续写入');
        }
        if (apiPath === '/api/v4/ledger/readiness') return send(res, 200, localReadiness);
        const members = await store.listNodeGroupMemberReports(blobUsername, replica.ledgerId);
        if (members.length || currentLinks.length === 0) {
          return send(res, 200, assessReplicaGroupHealth({ local: after, localReadiness, members }));
        }
        if (currentLinks.length === 1) {
          const link = currentLinks[0]!;
          const saved = await store.nodeGroupSnapshot(link.linkId);
          const snapshot = saved && parseNodeReplicaGroupSnapshot(saved.snapshot, link.peerNodeId,
            link.peerPublicKey, link.peerReplicaId, link.peerStreamEpoch, replica.ledgerId,
            serverId, nodeIdentity.publicKey);
          if (saved && snapshot) {
            return send(res, 200, assessForwardedReplicaGroupHealth(snapshot,
              saved.receivedAt, serverId, localReadiness));
          }
        }
        return send(res, 200, { state: 'VERIFYING', checkedAt: nowIso(), ledgerId: replica.ledgerId,
          coordinatorNodeId: currentLinks[0]?.peerNodeId ?? serverId,
          memberCount: currentLinks.length + 1, readyCount: 0,
          issues: [...localReadiness.issues, currentLinks.length > 1
            ? '本节点存在多条出站链路，无法确认唯一的组目录来源'
            : '尚未收到中继签名副本组目录'],
          members: [{ nodeId: serverId, state: localReadiness.state },
            ...currentLinks.map((link) => ({ nodeId: link.peerNodeId, state: 'MISSING' }))] });
      }
      if (apiPath === '/api/v4/ledger/attachment-promise' && req.method === 'GET') {
        res.setHeader('Cache-Control', 'no-store');
        return send(res, 200, await store.attachmentPromisePage(user.username,
          url.searchParams.get('after') ?? '', Number(url.searchParams.get('limit') ?? 2000), session.replicaId));
      }
      if (apiPath === '/api/v4/ledger/attachment-promise/uploads' && req.method === 'POST') {
        const body = await readBody(req, 4096);
        return send(res, 201, await store.beginAttachmentPromise(user.username,
          Number(body.expectedCount), session.replicaId));
      }
      const promiseUpload = /^\/api\/v4\/ledger\/attachment-promise\/uploads\/([a-f0-9]{32})$/.exec(apiPath);
      if (promiseUpload && req.method === 'GET') {
        res.setHeader('Cache-Control', 'no-store');
        const upload = await store.attachmentPromiseUpload(user.username, promiseUpload[1]!, session.replicaId);
        return upload ? send(res, 200, upload) : send(res, 404, { code: 'ATTACHMENT_PROMISE_UPLOAD_MISSING' });
      }
      const promisePage = /^\/api\/v4\/ledger\/attachment-promise\/uploads\/([a-f0-9]{32})\/pages$/.exec(apiPath);
      if (promisePage && req.method === 'POST') {
        const body = await readBody(req, 256 * 1024);
        return send(res, 200, await store.appendAttachmentPromisePage(user.username,
          promisePage[1]!, body.blobIds as string[], session.replicaId));
      }
      const promiseComplete = /^\/api\/v4\/ledger\/attachment-promise\/uploads\/([a-f0-9]{32})\/complete$/.exec(apiPath);
      if (promiseComplete && req.method === 'POST') {
        return send(res, 200, { catalog: await store.completeAttachmentPromise(user.username,
          promiseComplete[1]!, session.replicaId) });
      }

      if (req.method === 'POST' && apiPath === '/api/v4/replication/join') {
        const role = await store.roleForUser(user.username);
        if (role !== 'owner' && role !== 'admin') return send(res, 403, { code: 'NODE_ADMIN_REQUIRED', error: '只有节点管理员可以加入账本副本' });
        const body = await readBody(req, 4096);
        if (typeof body.peerUrl !== 'string' || typeof body.peerNodeId !== 'string'
          || typeof body.peerPublicKey !== 'string' || typeof body.grantId !== 'string'
          || typeof body.ledgerId !== 'string' || body.peerNodeId === serverId
          || !/^[A-Za-z0-9_-]{8,128}$/.test(body.peerNodeId)
          || !/^[A-Za-z0-9_-]{16,160}$/.test(body.grantId)
          || !/^[A-Za-z0-9_-]{16,128}$/.test(body.ledgerId)) {
          return send(res, 400, { code: 'INVALID_JOIN', error: '副本加入参数无效' });
        }
        let peerUrl: string;
        try { peerUrl = normalizeNodePeerUrl(body.peerUrl); }
        catch (error) { return send(res, 400, { code: 'INVALID_PEER_URL', error: String(error) }); }
        const input = { peerUrl, peerNodeId: body.peerNodeId, peerPublicKey: body.peerPublicKey,
          grantId: body.grantId, ledgerId: body.ledgerId };
        const peer = await probeNodePeer(nodeIdentity, input);
        const [account, keyResponse] = await Promise.all([
          signedCall(nodeIdentity, input, 'GET', '/api/v4/replication/account-identity'),
          signedCall(nodeIdentity, input, 'GET', '/api/v4/replication/key-envelope'),
        ]);
        const peerMatches = (value: JsonRecord) => value.serverId === input.peerNodeId
          && value.replicaId === peer.peerReplicaId && value.streamEpoch === peer.peerStreamEpoch
          && value.ledgerId === input.ledgerId;
        if (!peerMatches(account) || !peerMatches(keyResponse)
          || typeof account.issuerNodeId !== 'string'
          || typeof account.subjectAccountId !== 'string'
          || !/^[A-Za-z0-9_-]{8,160}$/.test(account.subjectAccountId)
          || !isLedgerKeyEnvelope(keyResponse.envelope)
          || keyResponse.envelope.ledgerId !== input.ledgerId) {
          return send(res, 409, { code: 'PEER_BOOTSTRAP_MISMATCH', error: '源节点账本、账号或密钥包身份不匹配' });
        }
        if (account.issuerNodeId !== input.peerNodeId) {
          const group = await store.serverSyncGroup();
          const issuer = (await store.serverSyncGroupMembers()).find((item) =>
            item.nodeId === account.issuerNodeId);
          if (group?.role !== 'member' || group.mainNodeId !== input.peerNodeId || !issuer) {
            return send(res, 403, { code: 'GROUP_ISSUER_REQUIRED',
              error: '中继账本的原始身份节点不属于本站同步组' });
          }
        }
        const link = await store.provisionFederatedReplica({ ...input, ...peer,
          issuerNodeId: account.issuerNodeId, subjectAccountId: account.subjectAccountId,
          envelope: keyResponse.envelope });
        await log('info', 'node_replica_provisioned', 'Node administrator created a federated ledger replica', {
          ip, username: user.username, detail: { linkId: link.linkId, ledgerId: link.ledgerId,
            peerNodeId: link.peerNodeId, replicaUsername: link.username },
        });
        void nodeReplication.run().catch(() => undefined);
        return send(res, 201, { link, replicaUsername: link.username });
      }

      if (req.method === 'GET' && apiPath === '/api/v4/replication/links') {
        const role = await store.roleForUser(user.username);
        const nodeAdmin = role === 'owner' || role === 'admin';
        if (!nodeAdmin || secondarySelected) {
          if (!replica) throw new ServerStoreError('REPLICA_UNBOUND', 409, 'bind a ledger first');
          await store.assertLedgerAccess(user.username, 'manage', session.replicaId);
        }
        return send(res, 200, { links: await store.listNodeReplicationLinks(nodeAdmin && !secondarySelected
          ? undefined : blobUsername, true) });
      }
      const renewNodeLink = /^\/api\/v4\/replication\/links\/([A-Za-z0-9_-]+)\/grant$/.exec(apiPath);
      if (req.method === 'PUT' && renewNodeLink) {
        const body = await readBody(req, 4096);
        if (typeof body.grantId !== 'string' || !/^[A-Za-z0-9_-]{16,160}$/.test(body.grantId)) {
          return send(res, 400, { error: '复制授权无效' });
        }
        const role = await store.roleForUser(user.username);
        const nodeAdmin = role === 'owner' || role === 'admin';
        if (!nodeAdmin || secondarySelected) {
          if (!replica) throw new ServerStoreError('REPLICA_UNBOUND', 409, 'bind a ledger first');
          await store.assertLedgerAccess(user.username, 'manage', session.replicaId);
        }
        const link = (await store.listNodeReplicationLinks(nodeAdmin && !secondarySelected
          ? undefined : blobUsername, true))
          .find((item) => item.linkId === renewNodeLink[1]);
        const linkReplica = link ? await store.getReplicaForLedger(link.username, link.ledgerId) : undefined;
        if (!link || !linkReplica || linkReplica.ledgerId !== link.ledgerId || linkReplica.streamEpoch !== link.localStreamEpoch) {
          return send(res, 404, { error: '复制链路不存在或本地副本已改变' });
        }
        if (link.revocationPending) return send(res, 409, { code: 'REVOCATION_PENDING', error: '旧授权撤销尚未确认' });
        if (body.grantId === link.grantId) return send(res, 409, { code: 'NEW_GRANT_REQUIRED', error: '续签须提供新授权' });
        const peer = await probeNodePeer(nodeIdentity, { peerUrl: link.peerUrl, peerNodeId: link.peerNodeId,
          peerPublicKey: link.peerPublicKey, grantId: body.grantId, ledgerId: link.ledgerId });
        await confirmPeerGrantRevocation(nodeIdentity, link);
        const updated = await store.renewNodeReplicationLink(link.username, link.linkId, body.grantId,
          link.peerNodeId, link.peerPublicKey, peer.peerReplicaId, peer.peerStreamEpoch);
        void nodeReplication.run().catch(() => undefined);
        return send(res, 200, { link: updated });
      }
      if (req.method === 'POST' && apiPath === '/api/v4/replication/links') {
        const body = await readBody(req, 4096);
        if (!replica || typeof body.peerUrl !== 'string' || typeof body.peerNodeId !== 'string'
          || typeof body.peerPublicKey !== 'string' || typeof body.grantId !== 'string'
          || body.peerNodeId === serverId || !/^[A-Za-z0-9_-]{8,128}$/.test(body.peerNodeId)
          || !/^[A-Za-z0-9_-]{16,160}$/.test(body.grantId)) {
          return send(res, 400, { code: 'INVALID_LINK', error: '节点复制链路参数无效' });
        }
        await store.assertLedgerAccess(user.username, 'manage', session.replicaId);
        let peerUrl: string;
        try { peerUrl = normalizeNodePeerUrl(body.peerUrl); }
        catch (error) { return send(res, 400, { code: 'INVALID_PEER_URL', error: String(error) }); }
        const input = { peerUrl, peerNodeId: body.peerNodeId, peerPublicKey: body.peerPublicKey,
          grantId: body.grantId, ledgerId: replica.ledgerId };
        const peer = await probeNodePeer(nodeIdentity, input);
        const link = await store.createNodeReplicationLink({ ...input, ...peer,
          username: blobUsername, localStreamEpoch: replica.streamEpoch });
        await log('info', 'node_replication_linked', 'Ledger replica linked to peer node', {
          ip, username: user.username, detail: { linkId: link.linkId, ledgerId: link.ledgerId, peerNodeId: link.peerNodeId },
        });
        void nodeReplication.run().catch(() => undefined);
        return send(res, 201, { link });
      }
      const rescanNodeLink = /^\/api\/v4\/replication\/links\/([A-Za-z0-9_-]+)\/rescan$/.exec(apiPath);
      if (req.method === 'POST' && rescanNodeLink) {
        const role = await store.roleForUser(user.username);
        const nodeAdmin = role === 'owner' || role === 'admin';
        if (!nodeAdmin || secondarySelected) {
          if (!replica) throw new ServerStoreError('REPLICA_UNBOUND', 409, 'bind a ledger first');
          await store.assertLedgerAccess(user.username, 'manage', session.replicaId);
        }
        const link = (await store.listNodeReplicationLinks(nodeAdmin && !secondarySelected
          ? undefined : blobUsername, true))
          .find((item) => item.linkId === rescanNodeLink[1]);
        if (!link) return send(res, 404, { code: 'LINK_NOT_FOUND', error: '复制链路不存在' });
        await nodeReplication.pause();
        let updated: NodeReplicationLink;
        try { updated = await store.rescanNodeReplicationLink(link.username, link.linkId); }
        finally { nodeReplication.resume(); }
        await log('info', 'node_replication_rescan_requested', 'Node replica full rescan requested', {
          ip, username: user.username, detail: { linkId: link.linkId,
            ledgerId: link.ledgerId, peerNodeId: link.peerNodeId },
        });
        void nodeReplication.run().catch(() => undefined);
        return send(res, 202, { link: updated });
      }
      const disableNodeLink = /^\/api\/v4\/replication\/links\/([A-Za-z0-9_-]+)$/.exec(apiPath);
      if (req.method === 'DELETE' && disableNodeLink) {
        const role = await store.roleForUser(user.username);
        const nodeAdmin = role === 'owner' || role === 'admin';
        if (!nodeAdmin || secondarySelected) {
          if (!replica) throw new ServerStoreError('REPLICA_UNBOUND', 409, 'bind a ledger first');
          await store.assertLedgerAccess(user.username, 'manage', session.replicaId);
        }
        const link = (await store.listNodeReplicationLinks(nodeAdmin && !secondarySelected
          ? undefined : blobUsername, true))
          .find((item) => item.linkId === disableNodeLink[1]);
        if (!link || !await store.disableNodeReplicationLink(link.username, link.linkId)) return send(res, 404, { error: '复制链路不存在' });
        void nodeReplication.run().catch(() => undefined);
        return send(res, 200, { ok: true, revocationPending: true });
      }

      if (req.method === 'GET' && apiPath === '/api/v4/replication/grants') {
        if (!replica) throw new ServerStoreError('REPLICA_UNBOUND', 409, 'bind a ledger first');
        await store.assertLedgerAccess(user.username, 'manage', session.replicaId);
        return send(res, 200, { grants: await store.listNodeReplicationGrants(blobUsername) });
      }
      if (req.method === 'POST' && apiPath === '/api/v4/replication/grants') {
        if (!replica) throw new ServerStoreError('REPLICA_UNBOUND', 409, 'bind a ledger first');
        const body = await readBody(req, 4096);
        if (typeof body.peerNodeId !== 'string' || typeof body.peerPublicKey !== 'string' || typeof body.expiresAt !== 'string'
          || body.renewable !== undefined && typeof body.renewable !== 'boolean') {
          return send(res, 400, { code: 'INVALID_GRANT', error: '节点授权参数无效' });
        }
        const grant = await store.createNodeReplicationGrant(user.username, body.peerNodeId, body.peerPublicKey,
          body.expiresAt, body.renewable === true, session.replicaId);
        await log('info', 'node_replication_granted', 'Ledger account authorized a replica node', {
          ip, username: user.username, detail: { grantId: grant.grantId, ledgerId: grant.ledgerId,
            peerNodeId: grant.peerNodeId, renewable: grant.renewable },
        });
        return send(res, 201, { grantId: grant.grantId, ledgerId: grant.ledgerId,
          peerNodeId: grant.peerNodeId, expiresAt: grant.expiresAt, renewable: grant.renewable });
      }
      const revokeNodeGrant = /^\/api\/v4\/replication\/grants\/([A-Za-z0-9_-]+)$/.exec(apiPath);
      if (req.method === 'DELETE' && revokeNodeGrant) {
        if (!replica) throw new ServerStoreError('REPLICA_UNBOUND', 409, 'bind a ledger first');
        await store.assertLedgerAccess(user.username, 'manage', session.replicaId);
        const revoked = await store.revokeNodeReplicationGrant(blobUsername, revokeNodeGrant[1]!);
        if (!revoked) return send(res, 404, { error: '复制授权不存在或已撤销' });
        await log('info', 'node_replication_revoked', 'Ledger account revoked a replica node', {
          ip, username: user.username, detail: { grantId: revokeNodeGrant[1] },
        });
        return send(res, 200, { ok: true });
      }

      if (replica && apiPath.startsWith('/api/v3/')) {
        const readOnly = req.method === 'GET' || req.method === 'HEAD'
          || req.method === 'POST' && apiPath === '/api/v3/blobs/status';
        const management = apiPath === '/api/v3/key-envelope'
          || apiPath.startsWith('/api/v3/protection/')
          || apiPath === '/api/v3/protection'
          || apiPath === '/api/v3/replica/replace'
          || apiPath.startsWith('/api/v3/replica/recovery');
        await store.assertLedgerAccess(user.username, management ? 'manage' : readOnly ? 'read' : 'write', session.replicaId);
      }
      const custodyScope = `${serverId}:${user.accountId}`;
      const protectionResponse = async () => {
        const bound = await store.getReplica(user.username, session.replicaId);
        const legacy = await store.getReplica(user.username);
        const legacySelected = !bound || bound.replicaId === legacy?.replicaId;
        const protection = legacySelected ? await store.getLedgerProtection(user.username) : undefined;
        return {
          mode: protection?.mode ?? (bound ? 'relay' : null), version: protection?.version ?? 0,
          defaultMode: defaultProtection, custodyEnabled,
          secret: protection?.mode === 'managed' && protection.sealedSecret ? openCustodySecret(custodyKey, custodyScope, protection.sealedSecret) : null,
          envelope: bound && legacySelected
            ? await store.getKeyEnvelope(user.username, bound.ledgerId, 'account', session.replicaId) ?? null : null,
          replica: bound ? { serverId, ...bound } : null,
        };
      };
      if (req.method === 'GET' && apiPath === '/api/v3/protection') return send(res, 200, await protectionResponse());
      if (req.method === 'POST' && apiPath === '/api/v3/protection/replace') {
        const body = await readBody(req, 512 * 1024);
        if (!replica || body.confirmation !== '替换旧账本' || body.expectedLedgerId !== replica.ledgerId || body.expectedStreamEpoch !== replica.streamEpoch) return send(res, 409, { error: '请确认当前旧账本后重试' });
        if (body.mode !== undefined && body.mode !== 'managed') return send(res, 400, { error: '保护方式无效' });
        const secretValue = randomBytes(32).toString('base64url');
        const envelope = (await createLedgerKeyEnvelope(newId(), secretValue)).envelope;
        if (!isLedgerKeyEnvelope(envelope) || envelope.ledgerId === replica.ledgerId) return send(res, 400, { error: '新账本密钥包无效' });
        await store.replaceReplica(user.username, session.id, { ledgerId: replica.ledgerId, streamEpoch: replica.streamEpoch }, envelope as unknown as JsonRecord, [], { mode: 'managed', sealedSecret: sealCustodySecret(custodyKey, custodyScope, secretValue) });
        await log('info', 'replica_replaced', 'User replaced ledger and custody policy', { ip, username: user.username, detail: { mode: 'managed' } });
        return send(res, 200, await protectionResponse());
      }
      if (req.method === 'POST' && apiPath === '/api/v3/protection/initialize') {
        const body = await readBody(req, 512 * 1024);
        if (await store.getLedgerProtection(user.username)) return send(res, 200, await protectionResponse());
        if (replica) throw new ServerStoreError('ALREADY_BOUND', 409, '已有账本请使用保护设置接口');
        if (body.mode !== undefined && body.mode !== 'managed') return send(res, 400, { error: '保护方式无效' });
        const importing = body.envelope !== undefined || body.secret !== undefined;
        if (importing && (!isLedgerKeyEnvelope(body.envelope) || typeof body.secret !== 'string'
          || body.secret.length < 32 || body.secret.length > 256)) return send(res, 400, { error: '账本密钥包无效' });
        const secretValue = importing ? body.secret as string : randomBytes(32).toString('base64url');
        const envelope = importing ? body.envelope : (await createLedgerKeyEnvelope(newId(), secretValue)).envelope;
        if (importing) {
          try { await unlockLedgerKeyEnvelope(secretValue, envelope as unknown as LedgerKeyEnvelope); }
          catch { return send(res, 400, { error: '托管凭据无法解锁此账本' }); }
        }
        try {
          await store.setLedgerProtection(user.username, session.id, 0, { mode: 'managed', sealedSecret: sealCustodySecret(custodyKey, custodyScope, secretValue) }, envelope as unknown as JsonRecord);
        } catch (error) {
          if (!(error instanceof ServerStoreError) || error.code !== 'PROTECTION_CHANGED') throw error;
        }
        return send(res, 200, await protectionResponse());
      }
      if (req.method === 'PUT' && apiPath === '/api/v3/protection') {
        const { mode, version, envelope, secret: secretValue, confirmation } = await readBody(req, 512 * 1024);
        if (!replica || !isLedgerKeyEnvelope(envelope) || envelope.ledgerId !== replica.ledgerId || !Number.isSafeInteger(version)
          || mode !== 'managed') return send(res, 400, { error: '保护设置无效' });
        if (confirmation !== '允许此服务器解密账本' || typeof secretValue !== 'string' || secretValue.length < 32 || secretValue.length > 256) return send(res, 400, { error: '请确认托管授权并提供有效密钥' });
        try { await unlockLedgerKeyEnvelope(secretValue, envelope as unknown as LedgerKeyEnvelope); }
        catch { return send(res, 400, { error: '托管凭据无法解锁此密钥包' }); }
        await store.setLedgerProtection(user.username, session.id, Number(version), { mode: 'managed', sealedSecret: sealCustodySecret(custodyKey, custodyScope, secretValue) }, envelope);
        await log('info', 'ledger_protection_updated', 'Updated ledger custody policy', { username: user.username, ip, detail: { mode } });
        return send(res, 200, await protectionResponse());
      }

      if (req.method === 'GET' && apiPath === '/api/v3/replica/recovery') {
        const current = await store.getReplica(user.username, session.replicaId);
        if (!current) throw new ServerStoreError('REPLICA_UNBOUND', 409, '当前账号没有可恢复的个人账本');
        return send(res, 200, { current: { serverId, ...current },
          checkpoints: await store.listReplacementCheckpoints(user.username) });
      }
      if (req.method === 'POST' && apiPath === '/api/v3/replica/recovery/restore') {
        const { checkpointId, expectedLedgerId, expectedStreamEpoch, confirmation } = await readBody(req, 16 * 1024);
        if (confirmation !== '恢复旧账本' || typeof checkpointId !== 'string'
          || !/^checkpoint-[a-f0-9]{32}$/.test(checkpointId)
          || typeof expectedLedgerId !== 'string' || typeof expectedStreamEpoch !== 'string') {
          return send(res, 400, { code: 'INVALID_LEDGER_RECOVERY', error: '请确认恢复点和当前账本身份' });
        }
        const restored = await store.restoreReplacementCheckpoint(user.username, session.id,
          { ledgerId: expectedLedgerId, streamEpoch: expectedStreamEpoch }, checkpointId);
        await log('info', 'replica_restored', 'User restored an encrypted ledger checkpoint', {
          ip, username: user.username, detail: { checkpointId, ledgerId: restored.ledgerId },
        });
        return send(res, 200, { serverId, ledgerId: restored.ledgerId, replicaId: restored.replicaId,
          streamEpoch: restored.streamEpoch, headSeq: restored.headSeq });
      }
      if (req.method === 'POST' && apiPath === '/api/v3/replica/replace') {
        const { expectedLedgerId, expectedStreamEpoch, confirmation, envelope, commits, secret: secretValue } = await readBody(req, MAX_BODY_BYTES);
        if (confirmation !== '替换旧账本' || typeof expectedLedgerId !== 'string' || typeof expectedStreamEpoch !== 'string' || !isLedgerKeyEnvelope(envelope) || envelope.ledgerId === expectedLedgerId) {
          return send(res, 400, { code: 'INVALID_LEDGER_REPLACEMENT', error: '请明确确认旧账本并提供完整的新账本密钥和初始数据' });
        }
        const initial = initialEncryptedCommits(commits, String(envelope.ledgerId));
        if (typeof secretValue !== 'string' || secretValue.length < 32 || secretValue.length > 256) return send(res, 400, { error: '缺少账本托管密钥' });
        try { await unlockLedgerKeyEnvelope(secretValue, envelope as unknown as LedgerKeyEnvelope); }
        catch { return send(res, 400, { error: '托管凭据无法解锁此账本' }); }
        const bound = await store.replaceReplica(user.username, session.id, { ledgerId: expectedLedgerId, streamEpoch: expectedStreamEpoch }, envelope, initial,
          { mode: 'managed', sealedSecret: sealCustodySecret(custodyKey, custodyScope, secretValue) });
        await log('info', 'replica_replaced', 'User replaced encrypted ledger', { ip, username: user.username, detail: { previousLedgerId: expectedLedgerId, ledgerId: bound.ledgerId } });
        return send(res, 200, { serverId, ledgerId: bound.ledgerId, replicaId: bound.replicaId, streamEpoch: bound.streamEpoch });
      }
      if (req.method === 'GET' && apiPath === '/api/v3/replica') {
        if (!replica) return send(res, 200, { serverId, bound: false, headSeq: 0,
          serverManagedReplication: false, capabilities: ['asset-cost-v2'] });
        const links = (await store.listNodeReplicationLinks(blobUsername))
          .filter((link) => link.ledgerId === replica.ledgerId)
          .map((link) => ({ peerNodeId: link.peerNodeId, localStreamEpoch: link.localStreamEpoch,
            peerStreamEpoch: link.peerStreamEpoch, enabled: link.enabled,
            lastSuccessAt: link.lastSuccessAt, lastError: link.lastError,
            inventoryMatchedAt: link.inventoryMatchedAt, inventoryIssue: link.inventoryIssue }));
        const groupMembers = await store.listReplicaGroupMembers(replica.replicaId);
        return send(res, 200, {
          serverId, bound: true, ledgerId: replica.ledgerId, replicaId: replica.replicaId,
          streamEpoch: replica.streamEpoch, headSeq: replica.headSeq, capabilities: ['asset-cost-v2'],
          // Preserve server-managed routing during bootstrap, outages and grant revocation.
          serverManagedReplication: links.length > 0 || groupMembers.length > 0,
          physical: await store.replicaPhysicalStatus(blobUsername, replica.ledgerId), links,
        });
      }
      if (req.method === 'GET' && apiPath === '/api/v4/ledger/browser-inventory') {
        if (!replica) throw new ServerStoreError('REPLICA_UNBOUND', 409, 'bind a ledger first');
        await store.assertLedgerAccess(user.username, 'read', session.replicaId);
        const inventory = await store.replicaInventory(blobUsername, replica.ledgerId, replica.replicaId);
        return send(res, 200, { serverId, replicaId: replica.replicaId,
          streamEpoch: replica.streamEpoch, ledgerId: replica.ledgerId,
          commitCount: inventory.commitCount, commitHash: inventory.commitHash,
          promisedBlobCount: inventory.promisedBlobCount, promisedBlobHash: inventory.promisedBlobHash,
          missingPromisedBlobCount: inventory.missingPromisedBlobCount,
          attachmentPromiseCurrent: inventory.attachmentPromiseCurrent });
      }
      if (req.method === 'POST' && apiPath === '/api/v3/replica/bind') {
        const { ledgerId } = await readBody(req, AUTH_BODY_BYTES);
        if (typeof ledgerId !== 'string' || !/^[A-Za-z0-9_-]{16,128}$/.test(ledgerId)) return send(res, 400, { code: 'INVALID_LEDGER_ID', error: 'invalid ledger id' });
        const bound = await store.bindReplica(user.username, ledgerId);
        await log('info', 'replica_bound', 'Bound sync account to ledger', { ip, username: user.username, detail: { ledgerId } });
        return send(res, 200, { ok: true, serverId, ledgerId: bound.ledgerId, replicaId: bound.replicaId, streamEpoch: bound.streamEpoch, headSeq: bound.headSeq });
      }
      if (req.method === 'GET' && apiPath === '/api/v3/key-envelope') {
        if (!replica) throw new ServerStoreError('REPLICA_UNBOUND', 409, 'bind a ledger first');
        return send(res, 200, { envelope: await store.getKeyEnvelope(user.username, replica.ledgerId,
          'account', session.replicaId) ?? null });
      }
      if (req.method === 'PUT' && apiPath === '/api/v3/key-envelope') {
        if (!replica) throw new ServerStoreError('REPLICA_UNBOUND', 409, 'bind a ledger first');
        const { envelope } = await readBody(req, 512 * 1024);
        if (!isLedgerKeyEnvelope(envelope) || envelope.ledgerId !== replica.ledgerId) return send(res, 400, { code: 'INVALID_KEY_ENVELOPE', error: 'invalid ledger key envelope' });
        const custody = await store.getLedgerProtection(user.username);
        if (custody?.mode === 'managed' && custody.sealedSecret) {
          try { await unlockLedgerKeyEnvelope(openCustodySecret(custodyKey, custodyScope, custody.sealedSecret), envelope as unknown as LedgerKeyEnvelope); }
          catch { return send(res, 409, { error: '托管凭据不匹配，请通过保护设置更新密钥' }); }
        }
        await store.putKeyEnvelope(user.username, replica.ledgerId, String(envelope.keyringId),
          Number(envelope.generation), envelope, 'account', session.replicaId);
        await log('info', 'key_envelope_updated', 'Updated encrypted ledger key envelope', { ip, username: user.username, detail: { ledgerId: replica.ledgerId, generation: envelope.generation } });
        return send(res, 200, { ok: true, generation: envelope.generation });
      }
      if (req.method === 'POST' && apiPath === '/api/v3/blobs/status') {
        if (!replica) throw new ServerStoreError('REPLICA_UNBOUND', 409, 'bind a ledger first');
        const { blobIds } = await readBody(req, ADMIN_BODY_BYTES);
        if (!Array.isArray(blobIds) || blobIds.length > 500 || blobIds.some((value) => typeof value !== 'string')) return send(res, 400, { error: 'invalid blob ids' });
        const [objects, usage] = await Promise.all([blobStore.status(blobUsername, replica.ledgerId, blobIds as string[]), blobStore.usage(blobUsername, replica.ledgerId)]);
        return send(res, 200, { objects, usage });
      }
      if (req.method === 'GET' && apiPath === '/api/v3/blobs/usage') {
        if (!replica) throw new ServerStoreError('REPLICA_UNBOUND', 409, 'bind a ledger first');
        return send(res, 200, { usage: await blobStore.usage(blobUsername, replica.ledgerId) });
      }
      if (req.method === 'POST' && apiPath === '/api/v3/blobs/uploads') {
        if (!replica) throw new ServerStoreError('REPLICA_UNBOUND', 409, 'bind a ledger first');
        const { manifest } = await readBody(req, 2 * 1024 * 1024);
        const plan = await blobStore.beginUpload(blobUsername, replica.ledgerId, manifest);
        await log('info', plan.status === 'available' ? 'blob_deduplicated' : 'blob_upload_started', 'Encrypted attachment upload initialized', { ip, username: user.username, detail: { status: plan.status, chunks: plan.missingChunks.length } });
        return send(res, plan.status === 'available' ? 200 : 201, plan);
      }
      const uploadChunk = /^\/api\/v3\/blobs\/uploads\/([a-f0-9]{32})\/chunks\/(\d+)$/.exec(apiPath);
      if (req.method === 'PUT' && uploadChunk) {
        const chunk = await readBinaryBody(req);
        await blobStore.putChunk(blobUsername, uploadChunk[1]!, Number(uploadChunk[2]), chunk);
        await store.recordAccountTransfer(user.username, 'blob-upload', chunk.byteLength);
        return send(res, 200, { ok: true });
      }
      const uploadComplete = /^\/api\/v3\/blobs\/uploads\/([a-f0-9]{32})\/complete$/.exec(apiPath);
      if (req.method === 'POST' && uploadComplete) { const manifest = await blobStore.completeUpload(blobUsername, uploadComplete[1]!); if (replica && manifest.v === 2) await store.invalidateReplicaPhysicalStatus(blobUsername, replica.ledgerId); await log('info', 'blob_upload_completed', 'Encrypted attachment upload completed', { ip, username: user.username, detail: { chunks: manifest.chunkCount, bytes: manifest.cipherBytes } }); return send(res, 200, { ok: true, blobId: manifest.blobId }); }
      const blobManifest = /^\/api\/v3\/blobs\/([a-f0-9]{64})\/manifest$/.exec(apiPath);
      if (req.method === 'GET' && blobManifest) { if (!replica) throw new ServerStoreError('REPLICA_UNBOUND', 409, 'bind a ledger first'); const manifest = await blobStore.manifest(blobUsername, replica.ledgerId, blobManifest[1]!); return manifest ? send(res, 200, { manifest }) : send(res, 404, { error: 'blob not found' }); }
      const blobChunk = /^\/api\/v3\/blobs\/([a-f0-9]{64})\/chunks\/(\d+)$/.exec(apiPath);
      if ((req.method === 'GET' || req.method === 'HEAD') && blobChunk) {
        if (!replica) throw new ServerStoreError('REPLICA_UNBOUND', 409, 'bind a ledger first');
        const chunk = await blobStore.chunk(blobUsername, replica.ledgerId, blobChunk[1]!, Number(blobChunk[2]));
        if (!chunk) return send(res, 404, { error: 'blob chunk not found' });
        if (req.method === 'HEAD') { res.writeHead(200, { 'Content-Type': 'application/octet-stream', 'Content-Length': String(chunk.byteLength) }); res.end(); return; }
        await store.recordAccountTransfer(user.username, 'blob-download', chunk.byteLength);
        return sendBinary(res, 200, chunk);
      }
      const blobRestore = /^\/api\/v3\/blobs\/([a-f0-9]{64})\/restore$/.exec(apiPath);
      if (req.method === 'POST' && blobRestore) { if (!replica) throw new ServerStoreError('REPLICA_UNBOUND', 409, 'bind a ledger first'); const restored = await blobStore.restore(blobUsername, replica.ledgerId, blobRestore[1]!); if (restored) await store.invalidateReplicaPhysicalStatus(blobUsername, replica.ledgerId); return send(res, restored ? 200 : 404, restored ? { ok: true } : { error: 'blob not found in trash' }); }
      const blobObject = /^\/api\/v3\/blobs\/([a-f0-9]{64})$/.exec(apiPath);
      if (req.method === 'DELETE' && blobObject) { if (!replica) throw new ServerStoreError('REPLICA_UNBOUND', 409, 'bind a ledger first'); const removed = await blobStore.remove(blobUsername, replica.ledgerId, blobObject[1]!); if (removed) await store.invalidateReplicaPhysicalStatus(blobUsername, replica.ledgerId); return send(res, 200, { ok: true, removed }); }

      if (req.method === 'GET' && apiPath === '/api/v3/backups') {
        if (!replica) throw new ServerStoreError('REPLICA_UNBOUND', 409, 'bind a ledger first');
        const requested = Number(url.searchParams.get('limit') ?? 100);
        const limit = Number.isSafeInteger(requested) ? Math.max(1, Math.min(500, requested)) : 100;
        return send(res, 200, { backups: await store.listBackupArchives(user.username, replica.ledgerId, limit,
          session.replicaId) });
      }
      if (req.method === 'POST' && apiPath === '/api/v3/backups') {
        if (!replica) throw new ServerStoreError('REPLICA_UNBOUND', 409, 'bind a ledger first');
        const { archive } = await readBody(req, 256 * 1024);
        if (!isRecord(archive)
          || typeof archive.archiveId !== 'string' || !/^[A-Za-z0-9_-]{16,160}$/.test(archive.archiveId)
          || typeof archive.blobId !== 'string' || !/^[a-f0-9]{64}$/.test(archive.blobId)
          || typeof archive.createdAt !== 'string' || !Number.isFinite(Date.parse(archive.createdAt))
          || (archive.reason !== 'auto' && archive.reason !== 'manual' && archive.reason !== 'pre-import')
          || (archive.kind !== 'portable' && archive.kind !== 'device')
          || typeof archive.label !== 'string' || archive.label.length > 160
          || !Number.isSafeInteger(archive.sizeBytes) || Number(archive.sizeBytes) < 128
          || (archive.sourceGeneration != null
            && (typeof archive.sourceGeneration !== 'string'
              || !/^[A-Za-z0-9:_-]{1,256}$/.test(archive.sourceGeneration)))) {
          return send(res, 400, { code: 'INVALID_BACKUP', error: 'invalid encrypted backup metadata' });
        }
        const manifest = await blobStore.manifest(blobUsername, replica.ledgerId, archive.blobId);
        if (!manifest || manifest.cipherBytes !== Number(archive.sizeBytes)) {
          return send(res, 409, { code: 'BACKUP_BLOB_MISSING', error: 'encrypted backup blob is missing or has a different size' });
        }
        const saved = await store.putBackupArchive(user.username, replica.ledgerId, {
          archiveId: archive.archiveId,
          blobId: archive.blobId,
          createdAt: archive.createdAt,
          reason: archive.reason,
          kind: archive.kind,
          label: archive.label,
          sizeBytes: Number(archive.sizeBytes),
          ...(archive.sourceGeneration ? { sourceGeneration: archive.sourceGeneration } : {}),
        }, session.replicaId);
        await log('info', 'backup_uploaded', 'Encrypted backup archive registered', {
          ip,
          username: user.username,
          detail: { archiveId: saved.archiveId, bytes: saved.sizeBytes, reason: saved.reason },
        });
        return send(res, 201, { backup: saved });
      }
      const backupObject = /^\/api\/v3\/backups\/([A-Za-z0-9_-]{16,160})$/.exec(apiPath);
      if (req.method === 'DELETE' && backupObject) {
        if (!replica) throw new ServerStoreError('REPLICA_UNBOUND', 409, 'bind a ledger first');
        const removed = await store.removeBackupArchive(user.username, replica.ledgerId, backupObject[1]!,
          session.replicaId);
        if (!removed) return send(res, 404, { error: 'backup not found' });
        await blobStore.remove(blobUsername, replica.ledgerId, removed.blobId);
        await log('info', 'backup_deleted', 'Encrypted backup archive moved to trash', {
          ip,
          username: user.username,
          detail: { archiveId: removed.archiveId, bytes: removed.sizeBytes },
        });
        return send(res, 200, { ok: true });
      }

      if (req.method === 'GET' && apiPath === '/api/v3/commits') {
        if (!replica) throw new ServerStoreError('REPLICA_UNBOUND', 409, 'bind a ledger first');
        const after = Number(url.searchParams.get('after') ?? 0);
        const requested = Number(url.searchParams.get('limit') ?? 200);
        if (!Number.isSafeInteger(after) || after < 0) return send(res, 400, { error: 'invalid cursor' });
        const page = await store.listCommits(user.username, after, Number.isSafeInteger(requested) ? Math.max(1, Math.min(200, requested)) : 200,
          'account', session.replicaId);
        const payload = { ...page, commits: page.commits, serverId, replicaId: replica.replicaId,
          streamEpoch: replica.streamEpoch,
 };
        const transferBytes = Buffer.byteLength(JSON.stringify(payload));
        await store.recordAccountTransfer(user.username, 'commit-pull', transferBytes);
        await store.recordSyncEvent({
          operation: 'pull',
          outcome: 'ok',
          username: user.username,
          accountId: user.accountId,
          deviceName: session.deviceName,
          commitCount: page.commits.length,
          bytes: transferBytes,
          durationMs: Date.now() - requestStartedAt,
          requestId,
          ...(client ? { clientKind: client.kind, clientVersion: client.version, protocolVersion: client.protocol } : {}),
        });
        return send(res, 200, payload);
      }
      if (req.method === 'POST' && apiPath === '/api/v3/commits') {
        if (!replica) throw new ServerStoreError('REPLICA_UNBOUND', 409, 'bind a ledger first');
        const { commits, capabilities = [], requiredCapabilities = [] } = await readBody(req, MAX_BODY_BYTES);
        if (!Array.isArray(capabilities) || !Array.isArray(requiredCapabilities)
          || capabilities.length > 32 || requiredCapabilities.length > 32
          || [...capabilities, ...requiredCapabilities].some((value) => typeof value !== 'string' || value.length > 80)) return send(res, 400, { error: 'invalid capabilities' });
        if (!Array.isArray(commits) || commits.length > 100) return send(res, 400, { error: 'invalid commit batch' });
        const incoming: Omit<StoredCommit, 'seq' | 'cipherBytes' | 'createdAt'>[] = [];
        const batchIds = new Map<string, string>();
        for (const row of commits) {
          if (!isRecord(row) || typeof row.commitId !== 'string' || !/^[A-Za-z0-9_-]{16,160}$/.test(row.commitId) || row.ledgerId !== replica.ledgerId || typeof row.contentHash !== 'string' || !/^[a-f0-9]{64}$/.test(row.contentHash) || !isRecord(row.encCommit) || row.encCommit.v !== 3 || typeof row.encCommit.keyId !== 'string' || !/^[A-Za-z0-9_-]{16,160}$/.test(row.encCommit.keyId) || typeof row.encCommit.iv !== 'string' || typeof row.encCommit.ct !== 'string' || row.encCommit.iv.length > 256 || row.encCommit.ct.length > MAX_BODY_BYTES) return send(res, 400, { code: 'INVALID_COMMIT', error: 'invalid encrypted commit' });
          const previous = batchIds.get(row.commitId);
          if (previous) return send(res, previous === row.contentHash ? 400 : 409, { code: previous === row.contentHash ? 'DUPLICATE_COMMIT_ID' : 'COMMIT_ID_COLLISION', error: `duplicate commit ${row.commitId}` });
          batchIds.set(row.commitId, row.contentHash);
          incoming.push({ commitId: row.commitId, ledgerId: row.ledgerId, contentHash: row.contentHash, encCommit: row.encCommit });
        }
        const result = await store.pushCommits(user.username, incoming, capabilities as string[], requiredCapabilities as string[],
          'account', session.replicaId);
        const transferBytes = Buffer.byteLength(JSON.stringify({ commits, capabilities, requiredCapabilities }));
        await store.recordAccountTransfer(user.username, 'commit-push', transferBytes);
        if (result.assigned.length) await log('info', 'commits_pushed', 'Received encrypted commits', { ip, username: user.username, detail: { count: result.assigned.length, requestId } });
        await store.recordSyncEvent({
          operation: 'push',
          outcome: 'ok',
          username: user.username,
          accountId: user.accountId,
          deviceName: session.deviceName,
          commitCount: result.assigned.length,
          bytes: transferBytes,
          durationMs: Date.now() - requestStartedAt,
          requestId,
          ...(client ? { clientKind: client.kind, clientVersion: client.version, protocolVersion: client.protocol } : {}),
        });
        return send(res, 200, { assigned: result.assigned, headSeq: result.replica.headSeq, serverId, replicaId: result.replica.replicaId, streamEpoch: result.replica.streamEpoch });
      }
      return send(res, 404, { error: 'not found' });
    } catch (error) {
      const isBlob = Boolean(routedPath?.startsWith('/api/v3/blobs'));
      const status = errorStatus(error, isBlob);
      const code = errorCode(error);
      const message = error instanceof Error ? error.message : String(error);
      await log(
        status >= 500 ? 'error' : 'warn',
        isBlob ? 'blob_request_failed' : 'request_failed',
        isBlob ? 'Encrypted attachment request failed' : 'Server request failed',
        { ip, status, detail: { method: req.method, path: routedPath?.replace(/(\/invites\/)[^/]+/g, '$1<redacted>').replace(/[a-f0-9]{32,64}/g, '<opaque-id>'), code, error: message, requestId } },
      ).catch(() => undefined);
      // Server-visible sync failures feed the diagnostics page; client offline gaps stay out of scope.
      if (routedPath?.startsWith('/api/v3')) {
        await store.recordSyncEvent({
          operation: isBlob ? 'blob' : 'commit',
          outcome: 'error',
          ...(code ? { resultCode: code } : {}),
          category: syncEventCategory(code, status),
          durationMs: Date.now() - requestStartedAt,
          requestId,
          ...(client ? { clientKind: client.kind, clientVersion: client.version, protocolVersion: client.protocol } : {}),
        }).catch(() => undefined);
      }
      return send(res, status, { ...(code ? { code } : {}), error: message, requestId });
    } finally {
      if (countedWrite) writeTracker.end();
    }
  });
  server.headersTimeout = 15_000;
  server.requestTimeout = 30_000;
  server.keepAliveTimeout = 5_000;

  return {
    server,
    adminAccessPath: () => String(settings.effective('adminAccessPath')),
    serverId,
    dataDir,
    ready,
    started,
    flushAccountEmails: async () => { processAccountEmails(); await accountEmailFlight; },
    flushNodeReplication: async () => { await ready; await nodeReplication.drain(); await nodeReplication.run(); await nodeReplication.drain(); },
    flushGroupReplication: async () => { await ready; await groupReconciler.run(); },
    backupPlan: async () => {
      await runtimeSettings.load();
      return { enabled: settings.effective('backupAutoEnabled') === 'on', directory: String(settings.effective('backupDirectory')),
        window: String(settings.effective('backupWindow')), serverId };
    },
    close: async () => {
      nodeReplication.stop();
      groupReconciler.stop();
      clearInterval(queueWatchdog);
      clearInterval(accountEmailTimer);
      clearInterval(nodeReplicationTimer);
      await nodeReplication.drain();
      await groupReconciler.drain();
      await metrics.stop();
      await accountEmailFlight;
      // Workers keep the process alive and hold their own heap; a shutdown that leaves them running
      // would make the process appear to hang after the server has closed.
      await hashOffload.close();
      await started.catch(() => undefined);
      if (server.listening) await new Promise<void>((resolveClose, reject) => server.close((error) => error ? reject(error) : resolveClose()));
      await jobs.stop();
      await store.close();
      await blobStore.close();
    },
  };
}
