/** Encrypted sync storage with optional account key custody and transactional SQLite WAL. */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { existsSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { extname, join, resolve, sep } from 'node:path';
import * as opaque from '@serenity-kit/opaque';
import { normalizeSyncUsername, createLedgerKeyEnvelope, unlockLedgerKeyEnvelope, newId, type LedgerKeyEnvelope } from '@zichan/core';
import { loadCustodyKey, sealCustodySecret, openCustodySecret } from './key-custody.js';
import { EncryptedBlobStore, MAX_ENCRYPTED_CHUNK_BYTES } from './blob-store.js';
import { createRequestOrigin } from './request-origin.js';
import { createBrowserSessionCookies } from './browser-session.js';
import {
  ServerStoreError,
  SyncServerStore,
  type JsonRecord,
  type RegistrationMode,
  type ServerLog,
  type StoredCommit,
} from './store.js';

export type { RegistrationMode } from './store.js';

const ACCESS_TOKEN_TTL_MS = 15 * 60 * 1000;
const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const OPAQUE_LOGIN_TTL_MS = 60 * 1000;
const OPAQUE_REGISTRATION_TTL_MS = 5 * 60 * 1000;
const MAX_BODY_BYTES = 16 * 1024 * 1024;
const AUTH_BODY_BYTES = 64 * 1024;
const ADMIN_BODY_BYTES = 256 * 1024;
const LOG_RETENTION = 5_000;

function nowIso(): string {
  return new Date().toISOString();
}

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
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

function normalizeBasePath(raw?: string): string {
  const value = (raw ?? '').trim();
  if (!value || value === '/') return '';
  return (value.startsWith('/') ? value : `/${value}`).replace(/\/+$/, '');
}

function initialEncryptedCommits(value: unknown, ledgerId: string): Omit<StoredCommit, 'seq' | 'cipherBytes' | 'createdAt'>[] {
  if (!Array.isArray(value) || !value.length || value.length > 100) throw new ServerStoreError('INVALID_COMMIT', 400, 'initial encrypted commits required');
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
  claimOwner?: boolean;
  ownerSetupOrigin?: string;
  passwordResetHash?: string;
  username?: string;
  sessionId?: string;
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

function headerValue(req: IncomingMessage, name: string): string {
  const value = req.headers[name.toLowerCase()];
  return Array.isArray(value) ? value[0] ?? '' : value ?? '';
}

function bearerToken(req: IncomingMessage): string {
  return headerValue(req, 'authorization').replace(/^Bearer\s+/i, '');
}

class RequestBodyError extends Error {
  constructor(readonly status: number, message: string) { super(message); }
}

function readBody(req: IncomingMessage, maxBytes = MAX_BODY_BYTES): Promise<JsonRecord> {
  return new Promise((resolveBody, reject) => {
    let body = '';
    let bytes = 0;
    let tooLarge = false;
    const declared = Number(headerValue(req, 'content-length'));
    if (Number.isFinite(declared) && declared > maxBytes) tooLarge = true;
    req.setEncoding('utf8');
    req.on('data', (chunk: string) => {
      bytes += Buffer.byteLength(chunk);
      if (bytes > maxBytes) tooLarge = true;
      else if (!tooLarge) body += chunk;
    });
    req.on('end', () => {
      if (tooLarge) return reject(new RequestBodyError(413, 'request body too large'));
      try {
        const parsed = body ? JSON.parse(body) as unknown : {};
        if (!isRecord(parsed)) throw new Error('body must be an object');
        resolveBody(parsed);
      } catch {
        reject(new RequestBodyError(400, 'invalid JSON body'));
      }
    });
    req.on('error', reject);
  });
}

function readBinaryBody(req: IncomingMessage, maxBytes = MAX_ENCRYPTED_CHUNK_BYTES): Promise<Uint8Array> {
  return new Promise((resolveBody, reject) => {
    const chunks: Buffer[] = [];
    let bytes = 0;
    const declared = Number(headerValue(req, 'content-length'));
    if (!Number.isSafeInteger(declared) || declared < 1 || declared > maxBytes) {
      reject(new RequestBodyError(declared > maxBytes ? 413 : 400, 'invalid binary content length'));
      req.resume();
      return;
    }
    req.on('data', (chunk: Buffer) => { bytes += chunk.byteLength; if (bytes <= maxBytes) chunks.push(chunk); });
    req.on('end', () => {
      if (bytes > maxBytes) reject(new RequestBodyError(413, 'request body too large'));
      else if (bytes !== declared) reject(new RequestBodyError(400, 'binary content length mismatch'));
      else resolveBody(Buffer.concat(chunks));
    });
    req.on('error', reject);
  });
}

function send(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': 'application/json',
    'Content-Length': String(Buffer.byteLength(payload)),
    'Cache-Control': 'no-store',
  });
  res.end(payload);
}

function sendBinary(res: ServerResponse, status: number, body: Uint8Array): void {
  res.writeHead(status, { 'Content-Type': 'application/octet-stream', 'Content-Length': String(body.byteLength), 'Cache-Control': 'private, max-age=31536000, immutable' });
  res.end(body);
}

function applyCors(req: IncomingMessage, res: ServerResponse): void {
  const origin = headerValue(req, 'origin');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'no-referrer');
  if (!origin) return;
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,PUT,DELETE,HEAD,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type,Authorization');
  res.setHeader('Access-Control-Max-Age', '600');
}

function errorStatus(error: unknown, blob = false): number {
  if (error instanceof RequestBodyError || error instanceof ServerStoreError) return error.status;
  const code = typeof error === 'object' && error !== null && 'code' in error ? String((error as { code?: unknown }).code) : '';
  if (code === 'QUOTA_EXCEEDED') return 507;
  if (code === 'UPLOAD_NOT_FOUND') return 404;
  if (code === 'CHUNK_CHECKSUM_MISMATCH') return 422;
  if (['UPLOAD_INCOMPLETE', 'BLOB_ID_COLLISION', 'UPLOAD_MANIFEST_MISMATCH'].includes(code)) return 409;
  return blob ? 400 : 500;
}

function errorCode(error: unknown): string | undefined {
  if (error instanceof ServerStoreError) return error.code;
  return typeof error === 'object' && error !== null && 'code' in error ? String((error as { code?: unknown }).code) : undefined;
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
  const entries = readdirSync(dataDir);
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

function serveWeb(req: IncomingMessage, res: ServerResponse, path: string, webDir?: string): boolean {
  if (!webDir || (req.method !== 'GET' && req.method !== 'HEAD')) return false;
  if (path === '/api' || path.startsWith('/api/')) return false;
  const root = resolve(webDir);
  const staticPath = path === '/app' || path === '/app/' || path === '/admin' || path === '/admin/' ? '/'
    : path.startsWith('/app/') ? path.slice(4) : path.startsWith('/admin/') ? path.slice(6) : path;
  const target = safeResolve(root, staticPath);
  if (!target) { res.writeHead(403); res.end('forbidden'); return true; }
  let file = fileIfExists(target);
  if (!file && extname(target) === '') file = fileIfExists(join(root, 'index.html'));
  if (!file) { res.writeHead(404); res.end('not found'); return true; }
  res.writeHead(200, {
    'Content-Type': MIME[extname(file).toLowerCase()] ?? 'application/octet-stream',
    'Cache-Control': file.endsWith('index.html') || file.endsWith('sw.js') ? 'no-cache' : 'public, max-age=31536000, immutable',
    'Content-Security-Policy': "default-src 'self'; connect-src 'self' https: http://localhost:* http://127.0.0.1:* http://[::1]:*; img-src 'self' blob: data:; style-src 'self' 'unsafe-inline'; script-src 'self' 'wasm-unsafe-eval'; font-src 'self' data:; worker-src 'self' blob:; object-src 'none'; base-uri 'self'; form-action 'self'; frame-ancestors 'none'",
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'no-referrer',
  });
  if (req.method === 'HEAD') res.end(); else res.end(readFileSync(file));
  return true;
}

function pathParts(path: string): string[] {
  return path.split('/').filter(Boolean).map((part) => { try { return decodeURIComponent(part); } catch { return part; } });
}

export interface SyncServerOptions {
  /** Explicit deployment policy; a same-origin address is not an official-server identity. */
  accountProtection?: 'managed' | 'private';
  custodyEnabled?: boolean;
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
  allowInsecureHttp?: boolean;
}

export interface SyncServer {
  server: Server;
  serverId: string;
  dataDir: string;
  ready: Promise<void>;
  close: () => Promise<void>;
}

export function createSyncServer(options: SyncServerOptions = {}): SyncServer {
  const enableSync = options.enableSync !== false;
  const enableWeb = options.enableWeb ?? Boolean(options.webDir);
  const basePath = normalizeBasePath(options.basePath);
  const trustedProxies = options.trustedProxies ?? [];
  const allowInsecureHttp = options.allowInsecureHttp === true;
  const origin = createRequestOrigin(trustedProxies, allowInsecureHttp);
  const browserSession = createBrowserSessionCookies(basePath, origin.browserOrigin);
  const requestedDataDir = options.dataDir ? resolve(options.dataDir) : undefined;
  assertServerIdentityComplete(requestedDataDir);
  const blobStore = new EncryptedBlobStore({
    dataDir: requestedDataDir,
    quotaBytes: options.attachmentQuotaBytes,
    maxBlobBytes: options.attachmentMaxFileBytes,
    trashRetentionMs: options.attachmentTrashRetentionMs,
  });
  const dataDir = blobStore.dataDir;
  const secret = loadPersistedValue(dataDir, 'server.secret', options.secret, () => randomBytes(32).toString('hex'));
  const ownerSetupToken = loadPersistedValue(dataDir, 'owner-setup.secret', options.ownerSetupToken, () => randomBytes(32).toString('hex'));
  if (ownerSetupToken.length < 32) throw new Error('owner-setup.secret must contain at least 32 characters');
  const serverId = loadPersistedValue(dataDir, 'server-id', options.serverId, () => `srv-${randomBytes(8).toString('hex')}`);
  // Both stores use separate SQLite connections to the same file. Initialize
  // them in sequence so catalog recovery cannot hold a write transaction while
  // the server schema connection synchronously waits for that lock.
  const store = new SyncServerStore(
    join(dataDir, 'server.sqlite'),
    options.registrationMode ?? 'invite',
    serverId,
    options.commitQuotaBytes,
    blobStore.ready,
  );
  const custodyEnabled = options.custodyEnabled !== false;
  const defaultProtection = custodyEnabled ? options.accountProtection ?? 'managed' : 'private';
  let custodyKey: Buffer;
  let opaqueServerSetup = '';
  let opaqueServerPublicKey = '';
  const ready = Promise.all([blobStore.ready, store.ready, opaque.ready]).then(async () => {
    custodyKey = loadCustodyKey(options.custodyKeyPath ?? join(dataDir, 'custody.key'), await store.hasCustodySecrets());
    opaqueServerSetup = loadPersistedValue(
      dataDir,
      'opaque.server-setup',
      options.opaqueServerSetup,
      () => opaque.server.createSetup(),
    );
    opaqueServerPublicKey = opaque.server.getPublicKey(opaqueServerSetup);
  });
  const log = async (level: ServerLog['level'], action: string, message: string, meta: Omit<ServerLog, 'id' | 'at' | 'level' | 'action' | 'message'> = {}) => {
    await store.appendLog({ id: randomBytes(12).toString('hex'), at: nowIso(), level, action, message, ...meta });
  };
  const allow = (ip: string, bucket: string, limit: number, windowMs: number) =>
    store.takeRateLimit(`${ip}:${bucket}`, limit, windowMs);
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
    active: !session.revokedAt && session.expiresAt > nowIso(),
  } : undefined;
  const issueAccessToken = (username: string, sessionId: string) => {
    const expiresAtMs = Date.now() + ACCESS_TOKEN_TTL_MS;
    return {
      accessToken: signToken(secret, { username, sessionId, exp: expiresAtMs }),
      accessExpiresAt: new Date(expiresAtMs).toISOString(),
    };
  };
  const createRefreshToken = (sessionId: string) => `${sessionId}.${randomBytes(32).toString('base64url')}`;

  const authenticateRequest = async (req: IncomingMessage) => {
    const claims = verifyToken(secret, bearerToken(req));
    const user = claims?.username ? await store.getUser(claims.username) : undefined;
    const session = claims?.sessionId ? await store.getSession(claims.sessionId) : undefined;
    if (!user || user.disabled || !session || session.username !== user.username
      || session.revokedAt || session.expiresAt <= nowIso()) return undefined;
    return { user, session, role: await store.roleForUser(user.username) };
  };

  const handleAdmin = async (
    req: IncomingMessage,
    res: ServerResponse,
    apiPath: string,
    auth: NonNullable<Awaited<ReturnType<typeof authenticateRequest>>>,
  ) => {
    const ip = origin.clientIp(req);
    if (auth.role === 'member') {
      await log('warn', 'admin_forbidden', 'Member attempted an administrative request', {
        ip,
        username: auth.user.username,
        status: 403,
      });
      return send(res, 403, { code: 'ADMIN_REQUIRED', error: 'administrator role required' });
    }
    let suffix = apiPath.slice('/api/admin'.length) || '/';
    let parts = pathParts(suffix);
    const assertManageTarget = async (username: string, quota = false) => {
      const target = await store.getUser(username);
      if (!target) throw new ServerStoreError('NOT_FOUND', 404, 'account not found');
      const role = await store.roleForUser(target.username);
      if ((!quota && role === 'owner') || auth.role === 'admin' && role !== 'member') throw new ServerStoreError('PROTECTED_ACCOUNT', 403, 'cannot manage this privileged account');
      return target;
    };
    // New management URLs use immutable IDs. Legacy URLs below keep the same guards.
    if (parts[0] === 'accounts' && parts.length === 3) {
      const target = await store.userByAccountId(parts[1]!);
      if (!target) return send(res, 404, { error: 'account not found' });
      if (req.method === 'POST' && parts[2] === 'password-reset') {
        const code = randomBytes(32).toString('base64url');
        const expiresAt = new Date(Date.now() + 15 * 60_000).toISOString();
        await store.mutateAdmin(auth.session.id, { action: 'password-reset-issue', accountId: target.accountId, codeHash: createHash('sha256').update(code).digest('hex'), expiresAt });
        res.setHeader('Cache-Control', 'no-store');
        return send(res, 200, { code, expiresAt, username: target.username });
      }
      if (req.method === 'POST' && parts[2] === 'role') {
        const { role } = await readBody(req, ADMIN_BODY_BYTES);
        if (role !== 'admin' && role !== 'member') return send(res, 400, { error: 'invalid role' });
        await store.mutateAdmin(auth.session.id, { action: 'role', accountId: target.accountId, role });
        return send(res, 200, { ok: true });
      }
      if (req.method === 'GET' && parts[2] === 'usage') {
        return send(res, 200, await blobStore.usage(target.username));
      }
      const routes: Record<string, string> = { state: 'users', devices: 'users', blobs: 'quotas', commits: 'quotas' };
      const group = routes[parts[2]!];
      if (!group) return send(res, 404, { error: 'not found' });
      suffix = `/${group}/${encodeURIComponent(target.username)}/${parts[2] === 'state' ? 'disable' : parts[2]}`;
      parts = pathParts(suffix);
    }
    if (req.method === 'GET' && suffix === '/audit') {
      const params = new URL(req.url ?? '/', 'http://localhost').searchParams;
      const before = Number(params.get('cursor') ?? Number.MAX_SAFE_INTEGER);
      if (!Number.isSafeInteger(before) || before < 1) return send(res, 400, { error: 'invalid cursor' });
      const search = params.get('search')?.trim() ?? '';
      if (search.length > 128) return send(res, 400, { error: 'search must not exceed 128 characters' });
      return send(res, 200, await store.listAdminAudit(before, 50, search));
    }
    if (req.method === 'GET' && suffix === '/status') {
      return send(res, 200, {
        ok: true,
        serverId,
        syncEnabled: enableSync,
        webEnabled: enableWeb && Boolean(options.webDir),
        basePath,
        dataDir,
        databaseFile: store.databaseFile,
        ...await store.status(),
      });
    }
    if (req.method === 'GET' && suffix === '/database/verify') {
      return send(res, 200, { verification: await store.verify() });
    }
    if (req.method === 'GET' && suffix === '/quotas') {
      const params = new URL(req.url ?? '/', 'http://localhost').searchParams;
      const limit = Number(params.get('limit') ?? 100);
      if (!Number.isSafeInteger(limit) || limit < 1 || limit > 500) return send(res, 400, { error: 'limit must be between 1 and 500' });
      const { users, nextCursor } = await store.listUsers(params.get('cursor') ?? '', limit);
      return send(res, 200, {
        users: await Promise.all(users.map(async (user) => ({
          username: user['username'],
          ...await blobStore.usage(String(user['username'])),
        }))),
        dataDir,
        nextCursor,
      });
    }
    if (req.method === 'POST' && suffix === '/quotas/blobs/verify') {
      const verification = await blobStore.verify();
      await log(verification.issues.length ? 'error' : 'info', 'blob_verification', 'Encrypted attachment verification completed', {
        ip,
        username: auth.user.username,
        detail: { checkedObjects: verification.checkedObjects, checkedChunks: verification.checkedChunks, issues: verification.issues.length },
      });
      return send(res, 200, { verification });
    }
    if (req.method === 'POST' && parts[0] === 'quotas' && parts[2] === 'blobs') {
      const username = parts[1] ?? '';
      const target = await assertManageTarget(username, true);
      const { quotaBytes } = await readBody(req, ADMIN_BODY_BYTES);
      if (quotaBytes !== null && (!Number.isSafeInteger(quotaBytes)
        || Number(quotaBytes) < 1024 * 1024 || Number(quotaBytes) > 1024 ** 4)) {
        return send(res, 400, { error: 'invalid quotaBytes' });
      }
      await store.mutateAdmin(auth.session.id, { action: 'blob-quota', accountId: target.accountId, bytes: quotaBytes === null ? null : Number(quotaBytes) });
      const usage = await blobStore.usage(username);
      await log('info', 'blob_quota_changed', 'Attachment quota changed', {
        ip,
        username,
        detail: { quotaBytes: usage.quotaBytes, changedBy: auth.user.username },
      });
      return send(res, 200, { username, usage });
    }
    if (req.method === 'POST' && parts[0] === 'quotas' && parts[2] === 'commits') {
      const username = parts[1] ?? '';
      const target = await assertManageTarget(username, true);
      const { commitQuotaBytes } = await readBody(req, ADMIN_BODY_BYTES);
      if (commitQuotaBytes !== null && (!Number.isSafeInteger(commitQuotaBytes)
        || Number(commitQuotaBytes) < 1024 * 1024 || Number(commitQuotaBytes) > 1024 ** 4)) {
        return send(res, 400, { error: 'invalid commitQuotaBytes' });
      }
      await store.mutateAdmin(auth.session.id, { action: 'commit-quota', accountId: target.accountId, bytes: commitQuotaBytes === null ? null : Number(commitQuotaBytes) });
      await log('info', 'commit_quota_changed', 'Encrypted commit quota changed', {
        ip,
        username,
        detail: { commitQuotaBytes, changedBy: auth.user.username },
      });
      return send(res, 200, { ok: true });
    }
    if (req.method === 'GET' && suffix === '/logs') {
      const requestUrl = new URL(req.url ?? '/', 'http://localhost');
      const limit = Math.min(Math.max(Number(requestUrl.searchParams.get('limit') ?? 100), 1), LOG_RETENTION);
      return send(res, 200, await store.listLogs({
        limit,
        level: requestUrl.searchParams.get('level') ?? undefined,
        from: requestUrl.searchParams.get('from') ?? undefined,
        until: requestUrl.searchParams.get('until') ?? undefined,
        cursor: requestUrl.searchParams.get('cursor') ?? undefined,
      }));
    }
    if (req.method === 'GET' && suffix === '/users') {
      const requestUrl = new URL(req.url ?? '/', 'http://localhost');
      const limit = Math.min(Math.max(Number(requestUrl.searchParams.get('limit') ?? 100), 1), 500);
      if (!Number.isSafeInteger(limit)) return send(res, 400, { error: 'invalid limit' });
      const role = requestUrl.searchParams.get('role') ?? '';
      const state = requestUrl.searchParams.get('state') ?? '';
      if (!['', 'owner', 'admin', 'member'].includes(role) || !['', 'enabled', 'disabled'].includes(state)) return send(res, 400, { error: 'invalid filter' });
      return send(res, 200, await store.listUsers(requestUrl.searchParams.get('cursor') ?? '', limit, { search: (requestUrl.searchParams.get('search') ?? '').slice(0, 128), role, state }));
    }
    if (req.method === 'GET' && suffix === '/devices') {
      const params = new URL(req.url ?? '/', 'http://localhost').searchParams;
      const limit = Number(params.get('limit') ?? 100);
      if (!Number.isSafeInteger(limit) || limit < 1 || limit > 500) return send(res, 400, { error: 'limit must be between 1 and 500' });
      const search = params.get('search') ?? '';
      if (search.length > 128) return send(res, 400, { error: 'search must not exceed 128 characters' });
      const { users, nextCursor } = await store.listUsers(params.get('cursor') ?? '', limit, { search, ...(auth.role === 'admin' ? { role: 'member' } : {}) });
      const devices = (await Promise.all(users.filter((user) => auth.role === 'owner' || user['role'] === 'member').map(async (user) =>
        (await store.listSessions(String(user['username']))).map((session) => ({ ...publicSession(session), accountId: user['accountId'], role: user['role'] }))))).flat();
      return send(res, 200, { devices, nextCursor, paginationUnit: 'account' });
    }
    if (req.method === 'GET' && parts[0] === 'users' && parts[2] === 'devices') {
      const username = parts[1] ?? '';
      if (!await store.getUser(username)) return send(res, 404, { error: 'user not found' });
      if (auth.role !== 'owner') await assertManageTarget(username);
      return send(res, 200, { devices: (await store.listSessions(username)).map(publicSession) });
    }
    if (req.method === 'POST' && parts[0] === 'sessions' && parts[2] === 'revoke') {
      await store.mutateAdmin(auth.session.id, { action: 'revoke-session', sessionId: parts[1] ?? '' });
      const targetSession = await store.getSession(parts[1] ?? '');
      if (!targetSession) return send(res, 404, { error: 'session not found' });
      await log('info', 'device_revoked', 'Revoked sync device session', {
        ip,
        username: targetSession.username,
        detail: { sessionId: targetSession.id, deviceId: targetSession.deviceId, changedBy: auth.user.username },
      });
      return send(res, 200, { device: publicSession(targetSession) });
    }
    if (req.method === 'POST' && parts[0] === 'users' && parts[2] === 'disable') {
      const username = parts[1] ?? '';
      if (username.toLocaleLowerCase() === auth.user.username.toLocaleLowerCase()) {
        return send(res, 409, { code: 'OWNER_CANNOT_BE_DISABLED', error: 'administrator cannot disable the current account' });
      }
      const body = await readBody(req, ADMIN_BODY_BYTES);
      if (typeof body.disabled !== 'boolean') return send(res, 400, { error: 'disabled must be a boolean' });
      const target = await assertManageTarget(username);
      await store.mutateAdmin(auth.session.id, { action: 'state', accountId: target.accountId, disabled: body.disabled });
      const targetUser = (await store.getUser(username))!;
      await log('info', targetUser.disabled ? 'user_disabled' : 'user_enabled', targetUser.disabled ? 'Disabled sync user' : 'Enabled sync user', {
        ip,
        username,
        detail: { changedBy: auth.user.username },
      });
      return send(res, 200, {
        user: {
          username: targetUser.username,
          role: await store.roleForUser(targetUser.username),
          disabled: targetUser.disabled,
          createdAt: targetUser.createdAt,
          updatedAt: targetUser.updatedAt,
          lastLoginAt: targetUser.lastLoginAt ?? null,
        },
      });
    }
    if (req.method === 'GET' && suffix === '/invites') {
      const params = new URL(req.url ?? '/', 'http://localhost').searchParams;
      const cursor = params.get('cursor') ?? '';
      const limit = Number(params.get('limit') ?? 25);
      const state = params.get('state') ?? '';
      if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100
        || cursor !== '' && (!/^[1-9]\d*$/.test(cursor) || !Number.isSafeInteger(Number(cursor)))
        || !['', 'available', 'used', 'revoked', 'expired'].includes(state)) {
        return send(res, 400, { error: 'invalid invitation pagination or filter' });
      }
      res.setHeader('Cache-Control', 'no-store');
      return send(res, 200, await store.listInvitesPage(Number(cursor), limit, state));
    }
    if (req.method === 'POST' && suffix === '/invites') {
      const body = await readBody(req, ADMIN_BODY_BYTES);
      const code = typeof body.code === 'string' && body.code.trim() ? body.code.trim() : randomBytes(12).toString('base64url');
      const days = body.days === undefined ? 7 : Number(body.days);
      if (!Number.isInteger(days) || days < 1 || days > 30) return send(res, 400, { error: 'invite expiry must be 1–30 days' });
      await store.mutateAdmin(auth.session.id, { action: 'invite-create', code, expiresAt: new Date(Date.now() + days * 86_400_000).toISOString() });
      const invite = await store.getInvite(code);
      await log('info', 'invite_created', 'Created registration invite', { ip, username: auth.user.username });
      return send(res, 200, { invite });
    }
    if (req.method === 'POST' && parts[0] === 'invites' && parts[2] === 'disable') {
      const code = parts[1] ?? '';
      const body = await readBody(req, ADMIN_BODY_BYTES);
      if (typeof body.disabled !== 'boolean') return send(res, 400, { error: 'disabled must be a boolean' });
      await store.mutateAdmin(auth.session.id, { action: 'invite-state', code, disabled: body.disabled });
      const invite = await store.getInvite(code);
      if (!invite) return send(res, 404, { error: 'invite not found' });
      await log('info', invite.disabled ? 'invite_disabled' : 'invite_enabled', invite.disabled ? 'Disabled invite' : 'Enabled invite', {
        ip,
        username: auth.user.username,
      });
      return send(res, 200, { invite });
    }
    if (req.method === 'GET' && suffix === '/registration') return send(res, 200, { mode: await store.registrationMode() });
    if (req.method === 'POST' && suffix === '/registration') {
      const { mode } = await readBody(req, ADMIN_BODY_BYTES);
      if (mode !== 'open' && mode !== 'invite' && mode !== 'closed') return send(res, 400, { error: 'invalid registration mode' });
      await store.mutateAdmin(auth.session.id, { action: 'registration', mode });
      await log('info', 'registration_mode_changed', 'Changed registration mode', {
        ip,
        username: auth.user.username,
        detail: { mode },
      });
      return send(res, 200, { mode });
    }
    return send(res, 404, { error: 'not found' });
  };

  const server = createServer(async (req, res) => {
    applyCors(req, res);
    if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }
    const url = new URL(req.url ?? '/', 'http://localhost');
    const path = decodePathname(url.pathname);
    const routedPath = stripBasePath(path, basePath);
    const ip = origin.clientIp(req);
    try {
      await ready;
      if (routedPath === '/api/health' && req.method === 'GET') {
        const status = await store.status();
        const capabilities = [
          'account-roles-v1',
          'account-identity-v1',
          'owner-setup-v1',
          'admin-session-v1',
          'device-sessions-v1',
          'same-origin-session-v1',
          'server-management-v1',
          'password-reset-v1',
          'encrypted-blobs-v1',
          'encrypted-commits-v3',
          'ledger-key-envelope-v1',
          'ledger-protection-v1',
          ...(custodyEnabled ? ['managed-key-custody-v1'] : []),
          'ledger-replacement-v1',
          'multi-origin-web-v1',
          'opaque-pake-v1',
          'sqlite-wal-v3',
        ];
        return send(res, 200, {
          ok: true,
          serverId,
          serverPublicKey: opaqueServerPublicKey,
          claimed: status.claimed,
          protocols: [3],
          capabilities,
          syncEnabled: enableSync,
          webEnabled: enableWeb && Boolean(options.webDir),
          registrationMode: status.registrationMode,
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
        const verification = await store.verify();
        return send(res, verification.ok ? 200 : 503, { ok: verification.ok, serverId, database: verification });
      }
      if (basePath && (path === '/api' || path.startsWith('/api/'))) return send(res, 404, { error: 'not found' });
      if (routedPath && serveWeb(req, res, routedPath, enableWeb ? options.webDir : undefined)) return;
      if (!routedPath && serveWeb(req, res, path, enableWeb ? options.webDir : undefined)) return;
      if (!routedPath) return send(res, 404, { error: 'not found' });
      const apiPath = routedPath;
      if (apiPath !== '/api' && !apiPath.startsWith('/api/')) return send(res, 404, { error: 'not found' });
      if (!enableSync && (apiPath === '/api' || apiPath.startsWith('/api/'))) return send(res, 503, { error: 'sync api disabled' });
      const isAdmin = apiPath === '/api/admin' || apiPath.startsWith('/api/admin/');
      if (isAdmin && !origin.secureTransport(req, allowInsecureHttp)) {
        return send(res, 426, { code: 'HTTPS_REQUIRED', error: 'HTTPS is required for remote administration' });
      }
      if (!origin.secureTransport(req, allowInsecureHttp)) return send(res, 426, { code: 'HTTPS_REQUIRED', error: 'HTTPS is required for remote synchronization' });
      const isAuth = apiPath.startsWith('/api/auth/');
      const isBlob = apiPath.startsWith('/api/v3/blobs');
      const rate = await allow(
        ip,
        isAuth ? `auth:${apiPath}` : isAdmin ? 'admin' : isBlob ? 'blob' : 'api',
        isAuth ? 20 : isBlob ? 600 : 120,
        60_000,
      );
      if (!rate.allowed) {
        res.setHeader('Retry-After', String(rate.retryAfterSeconds));
        await log('warn', 'rate_limited', 'API request rate limited', { ip, status: 429 });
        return send(res, 429, { error: 'rate limited, slow down' });
      }

      if (req.method === 'POST' && (apiPath === '/api/auth/register/start' || apiPath === '/api/auth/password-reset/start')) {
        const resettingPassword = apiPath === '/api/auth/password-reset/start';
        const { username: rawUsername, registrationRequest, inviteCode, ownerSetupToken: suppliedSetup, initializeOwner, passwordResetCode } = await readBody(req, AUTH_BODY_BYTES);
        const username = typeof rawUsername === 'string' ? normalizeSyncUsername(rawUsername) : '';
        if (!/^[\p{L}\p{N}_.-]{3,64}$/u.test(username)
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
          await store.assertRegistrationAllowed(normalizedInvite, claimOwner);
          if (await store.getUser(username)) return send(res, 409, { code: 'USER_EXISTS', error: 'user exists' });
        }
        let registrationResponse: string;
        try {
          registrationResponse = opaque.server.createRegistrationResponse({
            serverSetup: opaqueServerSetup,
            userIdentifier: username,
            registrationRequest,
          }).registrationResponse;
        } catch {
          return send(res, 400, { error: 'invalid registration request' });
        }
        const registrationToken = signToken(secret, {
          purpose: resettingPassword ? 'opaque-password-reset' : 'opaque-registration',
          ...(passwordResetHash ? { passwordResetHash } : {}),
          ...(claimOwner ? { claimOwner: true } : {}),
          ...(webSetup ? { ownerSetupOrigin: req.headers.origin } : {}),
          username,
          ...(normalizedInvite ? { inviteCode: normalizedInvite } : {}),
          exp: Date.now() + OPAQUE_REGISTRATION_TTL_MS,
        });
        return send(res, 200, {
          registrationResponse,
          registrationToken,
          serverId,
          serverPublicKey: opaqueServerPublicKey,
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
        if (resettingPassword) {
          if (typeof claims.passwordResetHash !== 'string') return send(res, 400, { error: 'invalid password reset completion' });
          await store.completePasswordReset(claims.username, claims.passwordResetHash, registrationRecord);
          res.setHeader('Cache-Control', 'no-store');
          return send(res, 200, { ok: true, serverId, role: await store.roleForUser(claims.username) });
        }
        const registration = await store.register(claims.username, registrationRecord, claims.inviteCode, claims.claimOwner === true);
        await log('info', 'register_success', 'Registered sync user', {
          ip,
          username: claims.username,
          detail: { role: registration.role },
        });
        return send(res, 200, { ok: true, serverId, role: registration.role });
      }
      if (req.method === 'POST' && apiPath === '/api/auth/login/start') {
        const { username: rawUsername, startLoginRequest } = await readBody(req, AUTH_BODY_BYTES);
        const username = typeof rawUsername === 'string' ? normalizeSyncUsername(rawUsername) : '';
        if (!/^[\p{L}\p{N}_.-]{3,64}$/u.test(username)
          || typeof startLoginRequest !== 'string'
          || !startLoginRequest
          || startLoginRequest.length > AUTH_BODY_BYTES) {
          return send(res, 400, { error: 'invalid login fields' });
        }
        const user = await store.getUser(username);
        let login: ReturnType<typeof opaque.server.startLogin>;
        try {
          login = opaque.server.startLogin({
            serverSetup: opaqueServerSetup,
            registrationRecord: user?.opaqueRegistrationRecord,
            startLoginRequest,
            userIdentifier: username,
            identifiers: { client: username, server: serverId },
          });
        } catch {
          return send(res, 400, { error: 'invalid login request' });
        }
        const loginState = await store.createOpaqueLoginState(
          username,
          JSON.stringify({ state: login.serverLoginState, credentialHash: createHash('sha256').update(user?.opaqueRegistrationRecord ?? '').digest('hex') }),
          ip,
          new Date(Date.now() + OPAQUE_LOGIN_TTL_MS).toISOString(),
        );
        return send(res, 200, {
          loginId: loginState.id,
          loginResponse: login.loginResponse,
          serverId,
          serverPublicKey: opaqueServerPublicKey,
        });
      }
      if (req.method === 'POST' && apiPath === '/api/auth/login/finish') {
        const cookieSession = browserSession.requested(req);
        const { loginId, finishLoginRequest, deviceId, deviceName } = await readBody(req, AUTH_BODY_BYTES);
        const loginState = typeof loginId === 'string'
          ? await store.consumeOpaqueLoginState(loginId, ip)
          : undefined;
        const user = loginState ? await store.getUser(loginState.username) : undefined;
        let authenticated = false;
        if (loginState && typeof finishLoginRequest === 'string' && finishLoginRequest.length <= AUTH_BODY_BYTES) {
          try {
            const stored = JSON.parse(loginState.serverLoginState) as { state: string; credentialHash: string };
            if (!user || stored.credentialHash !== createHash('sha256').update(user.opaqueRegistrationRecord).digest('hex')) throw new Error('credentials changed');
            opaque.server.finishLogin({
              serverLoginState: stored.state,
              finishLoginRequest,
              identifiers: { client: loginState.username, server: serverId },
            });
            authenticated = Boolean(user);
          } catch {
            authenticated = false;
          }
        }
        if (!authenticated || !user) {
          await log('warn', 'login_failed', 'Login failed', { ip, username: loginState?.username, status: 401 });
          return send(res, 401, { error: 'invalid credentials' });
        }
        if (user.disabled) {
          await log('warn', 'login_disabled', 'Disabled sync user attempted login', { ip, username: user.username, status: 403 });
          return send(res, 403, { error: 'user disabled' });
        }
        if (typeof deviceId !== 'string' || !/^[A-Za-z0-9_.:-]{8,128}$/.test(deviceId)
          || typeof deviceName !== 'string' || !deviceName.trim() || deviceName.length > 120) {
          return send(res, 400, { error: 'invalid device identity' });
        }
        const sessionId = `session-${randomBytes(16).toString('hex')}`;
        const refreshToken = createRefreshToken(sessionId);
        const session = await store.createSession({
          expectedRegistrationRecord: user.opaqueRegistrationRecord,
          id: sessionId,
          username: user.username,
          deviceId,
          deviceName: deviceName.trim(),
          refreshHash: opaqueHash(secret, refreshToken),
          expiresAt: new Date(Date.now() + SESSION_TTL_MS).toISOString(),
          ip,
        });
        await store.noteLogin(user.username);
        await log('info', 'login_success', 'Sync user logged in', { ip, username: user.username, detail: { sessionId: session.id, deviceId: session.deviceId } });
        const replica = await store.getReplica(user.username);
        if (cookieSession) browserSession.write(req, res, refreshToken);
        return send(res, 200, {
          ...issueAccessToken(user.username, session.id),
          accountId: user.accountId,
          ...(cookieSession ? { sessionTransport: 'cookie' } : { refreshToken }),
          session: publicSession(session),
          role: await store.roleForUser(user.username),
          ...(replica ? { ledgerId: replica.ledgerId } : {}),
        });
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
        const nextRefreshToken = createRefreshToken(session.id);
        const rotated = await store.rotateSessionRefresh(session.id, session.refreshHash, opaqueHash(secret, nextRefreshToken), ip);
        if (!rotated) return send(res, 401, { error: 'refresh token already used' });
        const replica = await store.getReplica(user.username);
        if (cookieSession) browserSession.write(req, res, nextRefreshToken);
        return send(res, 200, {
          ...issueAccessToken(user.username, session.id),
          accountId: user.accountId,
          ...(cookieSession ? { sessionTransport: 'cookie' } : { refreshToken: nextRefreshToken }),
          session: publicSession(rotated),
          role: await store.roleForUser(user.username),
          ...(replica ? { ledgerId: replica.ledgerId } : {}),
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
      if (Date.now() - Date.parse(session.lastSeenAt) > 5 * 60 * 1000) await store.touchSession(session.id, ip);

      if (req.method === 'GET' && apiPath === '/api/auth/me') {
        const replica = await store.getReplica(user.username);
        return send(res, 200, {
          username: user.username,
          role: auth.role,
          accountId: user.accountId,
          disabled: false,
          session: publicSession(session),
          ...(replica ? {
            ledgerId: replica.ledgerId,
            replicaId: replica.replicaId,
            streamEpoch: replica.streamEpoch,
          } : {}),
        });
      }
      if (isAdmin) return await handleAdmin(req, res, apiPath, auth);

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
      const replica = await store.getReplica(user.username);

      const custodyScope = `${serverId}:${user.accountId}`;
      const protectionResponse = async () => {
        const protection = await store.getLedgerProtection(user.username);
        const bound = await store.getReplica(user.username);
        return {
          mode: protection?.mode ?? (bound ? 'relay' : null), version: protection?.version ?? 0,
          defaultMode: defaultProtection, custodyEnabled,
          secret: protection?.mode === 'managed' && protection.sealedSecret ? openCustodySecret(custodyKey, custodyScope, protection.sealedSecret) : null,
          envelope: bound ? await store.getKeyEnvelope(user.username, bound.ledgerId) ?? null : null,
          replica: bound ? { serverId, ...bound } : null,
        };
      };
      if (req.method === 'GET' && apiPath === '/api/v3/protection') return send(res, 200, await protectionResponse());
      if (req.method === 'POST' && apiPath === '/api/v3/protection/replace') {
        const body = await readBody(req, 512 * 1024);
        if (!replica || body.confirmation !== '替换旧账本' || body.expectedLedgerId !== replica.ledgerId || body.expectedStreamEpoch !== replica.streamEpoch) return send(res, 409, { error: '请确认当前旧账本后重试' });
        const mode = body.mode;
        if ((mode !== 'managed' && mode !== 'private') || mode === 'managed' && !custodyEnabled) return send(res, 400, { error: '此服务器不支持所选保护方式' });
        const secretValue = mode === 'managed' ? randomBytes(32).toString('base64url') : null;
        const envelope = secretValue ? (await createLedgerKeyEnvelope(newId(), secretValue)).envelope : body.envelope;
        if (!isLedgerKeyEnvelope(envelope) || envelope.ledgerId === replica.ledgerId) return send(res, 400, { error: '新账本密钥包无效' });
        await store.replaceReplica(user.username, session.id, { ledgerId: replica.ledgerId, streamEpoch: replica.streamEpoch }, envelope as unknown as JsonRecord, [], { mode, sealedSecret: secretValue ? sealCustodySecret(custodyKey, custodyScope, secretValue) : null });
        await log('info', 'replica_replaced', 'User replaced ledger and custody policy', { ip, username: user.username, detail: { mode } });
        return send(res, 200, await protectionResponse());
      }
      if (req.method === 'POST' && apiPath === '/api/v3/protection/initialize') {
        const body = await readBody(req, 512 * 1024);
        if (await store.getLedgerProtection(user.username)) return send(res, 200, await protectionResponse());
        if (replica) throw new ServerStoreError('ALREADY_BOUND', 409, '已有账本请使用保护设置接口');
        const mode = body.mode ?? defaultProtection;
        if (mode !== 'managed' && mode !== 'private' || mode === 'managed' && !custodyEnabled) return send(res, 400, { error: '此服务器不支持所选保护方式' });
        const secretValue = mode === 'managed' ? randomBytes(32).toString('base64url') : null;
        const envelope = secretValue ? (await createLedgerKeyEnvelope(newId(), secretValue)).envelope : body.envelope;
        if (!isLedgerKeyEnvelope(envelope)) return send(res, 400, { error: '私密模式需要恢复码保护的密钥包' });
        try {
          await store.setLedgerProtection(user.username, session.id, 0, { mode, sealedSecret: secretValue ? sealCustodySecret(custodyKey, custodyScope, secretValue) : null }, envelope as unknown as JsonRecord);
        } catch (error) {
          if (!(error instanceof ServerStoreError) || error.code !== 'PROTECTION_CHANGED') throw error;
        }
        return send(res, 200, await protectionResponse());
      }
      if (req.method === 'PUT' && apiPath === '/api/v3/protection') {
        const { mode, version, envelope, secret: secretValue, confirmation } = await readBody(req, 512 * 1024);
        if (!replica || !isLedgerKeyEnvelope(envelope) || envelope.ledgerId !== replica.ledgerId || !Number.isSafeInteger(version)
          || (mode !== 'managed' && mode !== 'private' && mode !== 'relay')) return send(res, 400, { error: '保护设置无效' });
        if (mode === 'managed') {
          if (!custodyEnabled || confirmation !== '允许此服务器解密账本' || typeof secretValue !== 'string' || secretValue.length < 32 || secretValue.length > 256) return send(res, 400, { error: '请确认托管授权并提供有效密钥' });
          try { await unlockLedgerKeyEnvelope(secretValue, envelope as unknown as LedgerKeyEnvelope); }
          catch { return send(res, 400, { error: '托管凭据无法解锁此密钥包' }); }
        }
        await store.setLedgerProtection(user.username, session.id, Number(version), { mode, sealedSecret: mode === 'managed' ? sealCustodySecret(custodyKey, custodyScope, secretValue as string) : null }, envelope);
        await log('info', 'ledger_protection_updated', 'Updated ledger custody policy', { username: user.username, ip, detail: { mode } });
        return send(res, 200, await protectionResponse());
      }

      if (req.method === 'POST' && apiPath === '/api/v3/replica/replace') {
        const { expectedLedgerId, expectedStreamEpoch, confirmation, envelope, commits } = await readBody(req, MAX_BODY_BYTES);
        if (confirmation !== '替换旧账本' || typeof expectedLedgerId !== 'string' || typeof expectedStreamEpoch !== 'string' || !isLedgerKeyEnvelope(envelope) || envelope.ledgerId === expectedLedgerId) {
          return send(res, 400, { code: 'INVALID_LEDGER_REPLACEMENT', error: '请明确确认旧账本并提供完整的新账本密钥和初始数据' });
        }
        const initial = initialEncryptedCommits(commits, String(envelope.ledgerId));
        const bound = await store.replaceReplica(user.username, session.id, { ledgerId: expectedLedgerId, streamEpoch: expectedStreamEpoch }, envelope, initial);
        await log('info', 'replica_replaced', 'User replaced encrypted ledger', { ip, username: user.username, detail: { previousLedgerId: expectedLedgerId, ledgerId: bound.ledgerId } });
        return send(res, 200, { serverId, ledgerId: bound.ledgerId, replicaId: bound.replicaId, streamEpoch: bound.streamEpoch });
      }
      if (req.method === 'GET' && apiPath === '/api/v3/replica') return send(res, 200, replica ? { serverId, bound: true, ledgerId: replica.ledgerId, replicaId: replica.replicaId, streamEpoch: replica.streamEpoch, headSeq: replica.headSeq } : { serverId, bound: false, headSeq: 0 });
      if (req.method === 'POST' && apiPath === '/api/v3/replica/bind') {
        const { ledgerId } = await readBody(req, AUTH_BODY_BYTES);
        if (typeof ledgerId !== 'string' || !/^[A-Za-z0-9_-]{16,128}$/.test(ledgerId)) return send(res, 400, { code: 'INVALID_LEDGER_ID', error: 'invalid ledger id' });
        const bound = await store.bindReplica(user.username, ledgerId);
        await log('info', 'replica_bound', 'Bound sync account to ledger', { ip, username: user.username, detail: { ledgerId } });
        return send(res, 200, { ok: true, serverId, ledgerId: bound.ledgerId, replicaId: bound.replicaId, streamEpoch: bound.streamEpoch, headSeq: bound.headSeq });
      }
      if (req.method === 'GET' && apiPath === '/api/v3/key-envelope') {
        if (!replica) throw new ServerStoreError('REPLICA_UNBOUND', 409, 'bind a ledger first');
        return send(res, 200, { envelope: await store.getKeyEnvelope(user.username, replica.ledgerId) ?? null });
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
        await store.putKeyEnvelope(user.username, replica.ledgerId, String(envelope.keyringId), Number(envelope.generation), envelope);
        await log('info', 'key_envelope_updated', 'Updated encrypted ledger key envelope', { ip, username: user.username, detail: { ledgerId: replica.ledgerId, generation: envelope.generation } });
        return send(res, 200, { ok: true, generation: envelope.generation });
      }
      if (req.method === 'POST' && apiPath === '/api/v3/blobs/status') {
        if (!replica) throw new ServerStoreError('REPLICA_UNBOUND', 409, 'bind a ledger first');
        const { blobIds } = await readBody(req, ADMIN_BODY_BYTES);
        if (!Array.isArray(blobIds) || blobIds.length > 500 || blobIds.some((value) => typeof value !== 'string')) return send(res, 400, { error: 'invalid blob ids' });
        const [objects, usage] = await Promise.all([blobStore.status(user.username, replica.ledgerId, blobIds as string[]), blobStore.usage(user.username)]);
        return send(res, 200, { objects, usage });
      }
      if (req.method === 'GET' && apiPath === '/api/v3/blobs/usage') return send(res, 200, { usage: await blobStore.usage(user.username) });
      if (req.method === 'POST' && apiPath === '/api/v3/blobs/uploads') {
        if (!replica) throw new ServerStoreError('REPLICA_UNBOUND', 409, 'bind a ledger first');
        const { manifest } = await readBody(req, 2 * 1024 * 1024);
        const plan = await blobStore.beginUpload(user.username, replica.ledgerId, manifest);
        await log('info', plan.status === 'available' ? 'blob_deduplicated' : 'blob_upload_started', 'Encrypted attachment upload initialized', { ip, username: user.username, detail: { status: plan.status, chunks: plan.missingChunks.length } });
        return send(res, plan.status === 'available' ? 200 : 201, plan);
      }
      const uploadChunk = /^\/api\/v3\/blobs\/uploads\/([a-f0-9]{32})\/chunks\/(\d+)$/.exec(apiPath);
      if (req.method === 'PUT' && uploadChunk) { await blobStore.putChunk(user.username, uploadChunk[1]!, Number(uploadChunk[2]), await readBinaryBody(req)); return send(res, 200, { ok: true }); }
      const uploadComplete = /^\/api\/v3\/blobs\/uploads\/([a-f0-9]{32})\/complete$/.exec(apiPath);
      if (req.method === 'POST' && uploadComplete) { const manifest = await blobStore.completeUpload(user.username, uploadComplete[1]!); await log('info', 'blob_upload_completed', 'Encrypted attachment upload completed', { ip, username: user.username, detail: { chunks: manifest.chunkCount, bytes: manifest.cipherBytes } }); return send(res, 200, { ok: true, blobId: manifest.blobId }); }
      const blobManifest = /^\/api\/v3\/blobs\/([a-f0-9]{64})\/manifest$/.exec(apiPath);
      if (req.method === 'GET' && blobManifest) { if (!replica) throw new ServerStoreError('REPLICA_UNBOUND', 409, 'bind a ledger first'); const manifest = await blobStore.manifest(user.username, replica.ledgerId, blobManifest[1]!); return manifest ? send(res, 200, { manifest }) : send(res, 404, { error: 'blob not found' }); }
      const blobChunk = /^\/api\/v3\/blobs\/([a-f0-9]{64})\/chunks\/(\d+)$/.exec(apiPath);
      if ((req.method === 'GET' || req.method === 'HEAD') && blobChunk) {
        if (!replica) throw new ServerStoreError('REPLICA_UNBOUND', 409, 'bind a ledger first');
        const chunk = await blobStore.chunk(user.username, replica.ledgerId, blobChunk[1]!, Number(blobChunk[2]));
        if (!chunk) return send(res, 404, { error: 'blob chunk not found' });
        if (req.method === 'HEAD') { res.writeHead(200, { 'Content-Type': 'application/octet-stream', 'Content-Length': String(chunk.byteLength) }); res.end(); return; }
        return sendBinary(res, 200, chunk);
      }
      const blobRestore = /^\/api\/v3\/blobs\/([a-f0-9]{64})\/restore$/.exec(apiPath);
      if (req.method === 'POST' && blobRestore) { if (!replica) throw new ServerStoreError('REPLICA_UNBOUND', 409, 'bind a ledger first'); const restored = await blobStore.restore(user.username, replica.ledgerId, blobRestore[1]!); return send(res, restored ? 200 : 404, restored ? { ok: true } : { error: 'blob not found in trash' }); }
      const blobObject = /^\/api\/v3\/blobs\/([a-f0-9]{64})$/.exec(apiPath);
      if (req.method === 'DELETE' && blobObject) { if (!replica) throw new ServerStoreError('REPLICA_UNBOUND', 409, 'bind a ledger first'); return send(res, 200, { ok: true, removed: await blobStore.remove(user.username, replica.ledgerId, blobObject[1]!) }); }

      if (req.method === 'GET' && apiPath === '/api/v3/backups') {
        if (!replica) throw new ServerStoreError('REPLICA_UNBOUND', 409, 'bind a ledger first');
        const requested = Number(url.searchParams.get('limit') ?? 100);
        const limit = Number.isSafeInteger(requested) ? Math.max(1, Math.min(500, requested)) : 100;
        return send(res, 200, { backups: await store.listBackupArchives(user.username, replica.ledgerId, limit) });
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
        const manifest = await blobStore.manifest(user.username, replica.ledgerId, archive.blobId);
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
        });
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
        const removed = await store.removeBackupArchive(user.username, replica.ledgerId, backupObject[1]!);
        if (!removed) return send(res, 404, { error: 'backup not found' });
        await blobStore.remove(user.username, replica.ledgerId, removed.blobId);
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
        const page = await store.listCommits(user.username, after, Number.isSafeInteger(requested) ? Math.max(1, Math.min(200, requested)) : 200);
        return send(res, 200, { ...page, serverId, replicaId: replica.replicaId, streamEpoch: replica.streamEpoch });
      }
      if (req.method === 'POST' && apiPath === '/api/v3/commits') {
        if (!replica) throw new ServerStoreError('REPLICA_UNBOUND', 409, 'bind a ledger first');
        const { commits } = await readBody(req, MAX_BODY_BYTES);
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
        const result = await store.pushCommits(user.username, incoming);
        if (result.assigned.length) await log('info', 'commits_pushed', 'Received encrypted commits', { ip, username: user.username, detail: { count: result.assigned.length } });
        return send(res, 200, { assigned: result.assigned, headSeq: result.replica.headSeq, serverId, replicaId: result.replica.replicaId, streamEpoch: result.replica.streamEpoch });
      }
      return send(res, 404, { error: 'not found' });
    } catch (error) {
      const isBlob = Boolean(routedPath?.startsWith('/api/v3/blobs'));
      const status = errorStatus(error, isBlob);
      const code = errorCode(error);
      await log(
        status >= 500 ? 'error' : 'warn',
        isBlob ? 'blob_request_failed' : 'request_failed',
        isBlob ? 'Encrypted attachment request failed' : 'Server request failed',
        { ip, status, detail: { method: req.method, path: routedPath?.replace(/(\/invites\/)[^/]+/g, '$1<redacted>').replace(/[a-f0-9]{32,64}/g, '<opaque-id>'), code, error: error instanceof Error ? error.message : String(error) } },
      ).catch(() => undefined);
      return send(res, status, { ...(code ? { code } : {}), error: error instanceof Error ? error.message : String(error) });
    }
  });
  server.headersTimeout = 15_000;
  server.requestTimeout = 30_000;
  server.keepAliveTimeout = 5_000;

  return {
    server,
    serverId,
    dataDir,
    ready,
    close: async () => {
      if (server.listening) await new Promise<void>((resolveClose, reject) => server.close((error) => error ? reject(error) : resolveClose()));
      await store.close();
      await blobStore.close();
    },
  };
}
