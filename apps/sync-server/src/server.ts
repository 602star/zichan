/** End-to-end encrypted sync relay backed by a transactional SQLite WAL store. */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { existsSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { extname, join, resolve, sep } from 'node:path';
import * as opaque from '@serenity-kit/opaque';
import { normalizeSyncUsername } from '@zichan/core';
import { EncryptedBlobStore, MAX_ENCRYPTED_CHUNK_BYTES } from './blob-store.js';
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
const DEFAULT_CORS_ORIGINS = [
  'tauri://localhost',
  'http://tauri.localhost',
  'https://tauri.localhost',
  'http://localhost:5173',
  'http://127.0.0.1:5173',
];

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
  res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(body));
}

function sendBinary(res: ServerResponse, status: number, body: Uint8Array): void {
  res.writeHead(status, { 'Content-Type': 'application/octet-stream', 'Content-Length': String(body.byteLength), 'Cache-Control': 'private, max-age=31536000, immutable' });
  res.end(body);
}

function remoteIp(req: IncomingMessage): string {
  return (req.socket.remoteAddress ?? 'unknown').replace(/^::ffff:/, '');
}

function isLoopback(ip: string): boolean {
  return ip === '127.0.0.1' || ip === '::1' || ip === 'localhost';
}

function isPrivateIp(ip: string): boolean {
  if (isLoopback(ip)) return true;
  const parts = ip.split('.').map(Number);
  if (parts.length === 4 && parts.every((part) => Number.isInteger(part) && part >= 0 && part <= 255)) {
    return parts[0] === 10
      || (parts[0] === 172 && parts[1]! >= 16 && parts[1]! <= 31)
      || (parts[0] === 192 && parts[1] === 168);
  }
  return ip.startsWith('fc') || ip.startsWith('fd') || ip.startsWith('fe80:');
}

function isTrustedProxy(req: IncomingMessage, trustedProxies: string[]): boolean {
  const remote = remoteIp(req);
  return trustedProxies.some((rule) =>
    rule === remote || (rule === 'loopback' && isLoopback(remote)) || (rule === 'private' && isPrivateIp(remote)));
}

function forwardedValue(req: IncomingMessage, name: string, trustedProxies: string[]): string {
  if (!isTrustedProxy(req, trustedProxies)) return '';
  return headerValue(req, name).split(',')[0]?.trim() ?? '';
}

function clientIp(req: IncomingMessage, trustedProxies: string[]): string {
  const forwarded = req.headers['x-forwarded-for'];
  return isTrustedProxy(req, trustedProxies) && typeof forwarded === 'string' && forwarded
    ? forwarded.split(',')[0]!.trim().replace(/^::ffff:/, '')
    : remoteIp(req);
}

function requestProtocol(req: IncomingMessage, trustedProxies: string[]): 'http' | 'https' {
  return forwardedValue(req, 'x-forwarded-proto', trustedProxies).toLowerCase() === 'https' ? 'https' : 'http';
}

function secureTransport(req: IncomingMessage, trustedProxies: string[], allowInsecureHttp: boolean): boolean {
  return requestProtocol(req, trustedProxies) === 'https' || isLoopback(clientIp(req, trustedProxies)) || allowInsecureHttp;
}

function sameOrigin(req: IncomingMessage, origin: string, trustedProxies: string[]): boolean {
  try {
    const parsed = new URL(origin);
    const host = forwardedValue(req, 'x-forwarded-host', trustedProxies) || headerValue(req, 'host');
    return parsed.protocol === `${requestProtocol(req, trustedProxies)}:` && parsed.host === host;
  } catch {
    return false;
  }
}

function applyCors(
  req: IncomingMessage,
  res: ServerResponse,
  allowedOrigins: string[],
  trustedProxies: string[],
): boolean {
  const origin = headerValue(req, 'origin');
  res.setHeader('Vary', 'Origin');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'no-referrer');
  if (!origin) return true;
  if (!allowedOrigins.includes(origin) && !sameOrigin(req, origin, trustedProxies)) return false;
  res.setHeader('Access-Control-Allow-Origin', origin);
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,PUT,DELETE,HEAD,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type,Content-Length,Authorization,X-Admin-Token');
  res.setHeader('Access-Control-Max-Age', '600');
  return true;
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

function loadPersistedValue(dataDir: string, name: string, provided: string | undefined, create: () => string): string {
  const path = join(dataDir, name);
  const configured = provided?.trim();
  if (existsSync(path)) {
    const persisted = readFileSync(path, 'utf8').trim();
    if (configured && configured !== persisted) throw new Error(`${name} 与现有服务器数据目录不匹配`);
    return persisted;
  }
  const value = configured || create();
  writeFileSync(path, value, { mode: 0o600 });
  return value;
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
  if (path === '/api' || path.startsWith('/api/') || path === '/admin' || path.startsWith('/admin/')) return false;
  const root = resolve(webDir);
  const staticPath = path === '/app' || path === '/app/' ? '/' : path.startsWith('/app/') ? path.slice(4) : path;
  const target = safeResolve(root, staticPath);
  if (!target) { res.writeHead(403); res.end('forbidden'); return true; }
  let file = fileIfExists(target);
  if (!file && extname(target) === '') file = fileIfExists(join(root, 'index.html'));
  if (!file) { res.writeHead(404); res.end('not found'); return true; }
  res.writeHead(200, { 'Content-Type': MIME[extname(file).toLowerCase()] ?? 'application/octet-stream', 'Cache-Control': file.endsWith('index.html') ? 'no-cache' : 'public, max-age=31536000, immutable' });
  if (req.method === 'HEAD') res.end(); else res.end(readFileSync(file));
  return true;
}

function pathParts(path: string): string[] {
  return path.split('/').filter(Boolean).map((part) => { try { return decodeURIComponent(part); } catch { return part; } });
}

export interface SyncServerOptions {
  dataDir?: string;
  attachmentQuotaBytes?: number;
  attachmentMaxFileBytes?: number;
  attachmentTrashRetentionMs?: number;
  commitQuotaBytes?: number;
  secret?: string;
  serverId?: string;
  opaqueServerSetup?: string;
  adminToken?: string;
  registrationMode?: RegistrationMode;
  enableSync?: boolean;
  webDir?: string;
  enableWeb?: boolean;
  basePath?: string;
  allowedOrigins?: string[];
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
  const allowedOrigins = options.allowedOrigins ?? DEFAULT_CORS_ORIGINS;
  const trustedProxies = options.trustedProxies ?? [];
  const allowInsecureHttp = options.allowInsecureHttp === true;
  const blobStore = new EncryptedBlobStore({
    dataDir: options.dataDir,
    quotaBytes: options.attachmentQuotaBytes,
    maxBlobBytes: options.attachmentMaxFileBytes,
    trashRetentionMs: options.attachmentTrashRetentionMs,
  });
  const dataDir = blobStore.dataDir;
  const secret = loadPersistedValue(dataDir, 'server.secret', options.secret, () => randomBytes(32).toString('hex'));
  const serverId = loadPersistedValue(dataDir, 'server-id', options.serverId, () => `srv-${randomBytes(8).toString('hex')}`);
  const store = new SyncServerStore(join(dataDir, 'server.sqlite'), options.registrationMode ?? 'open', serverId, options.commitQuotaBytes);
  let opaqueServerSetup = '';
  let opaqueServerPublicKey = '';
  const ready = Promise.all([blobStore.ready, store.ready, opaque.ready]).then(() => {
    opaqueServerSetup = loadPersistedValue(
      dataDir,
      'opaque.server-setup',
      options.opaqueServerSetup,
      () => opaque.server.createSetup(),
    );
    opaqueServerPublicKey = opaque.server.getPublicKey(opaqueServerSetup);
  });
  const adminToken = options.adminToken?.trim();

  const log = async (level: ServerLog['level'], action: string, message: string, meta: Omit<ServerLog, 'id' | 'at' | 'level' | 'action' | 'message'> = {}) => {
    await store.appendLog({ id: randomBytes(12).toString('hex'), at: nowIso(), level, action, message, ...meta });
  };
  const allow = (ip: string, bucket: string, limit: number, windowMs: number) =>
    store.takeRateLimit(`${ip}:${bucket}`, limit, windowMs);
  const isAdmin = (req: IncomingMessage) => {
    if (!adminToken) return false;
    const provided = bearerToken(req) || headerValue(req, 'x-admin-token');
    return !!provided && safeEqual(provided, adminToken);
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

  const handleAdmin = async (req: IncomingMessage, res: ServerResponse, path: string) => {
    const ip = clientIp(req, trustedProxies);
    if (!adminToken) { await log('warn', 'admin_disabled', 'Admin API is disabled', { ip, status: 403 }); return send(res, 403, { error: 'admin disabled' }); }
    if (!isAdmin(req)) { await log('warn', 'admin_unauthorized', 'Admin API unauthorized request', { ip, status: 401 }); return send(res, 401, { error: 'admin unauthorized' }); }
    const parts = pathParts(path);
    if (req.method === 'GET' && path === '/admin/status') {
      return send(res, 200, { ok: true, serverId, syncEnabled: enableSync, webEnabled: enableWeb && Boolean(options.webDir), basePath, dataDir, databaseFile: store.databaseFile, ...await store.status() });
    }
    if (req.method === 'GET' && path === '/admin/database/verify') return send(res, 200, { verification: await store.verify() });
    if (req.method === 'GET' && path === '/admin/blobs') {
      const { users } = await store.listUsers('', 1000);
      return send(res, 200, { users: await Promise.all(users.map(async (user) => ({ username: user['username'], ...await blobStore.usage(String(user['username'])) }))), dataDir });
    }
    if (req.method === 'POST' && path === '/admin/blobs/verify') {
      const verification = await blobStore.verify();
      await log(verification.issues.length ? 'error' : 'info', 'blob_verification', 'Encrypted attachment verification completed', { ip, detail: { checkedObjects: verification.checkedObjects, checkedChunks: verification.checkedChunks, issues: verification.issues.length } });
      return send(res, 200, { verification });
    }
    if (req.method === 'POST' && parts[0] === 'admin' && parts[1] === 'blobs' && parts[3] === 'quota') {
      const username = parts[2] ?? '';
      if (!await store.getUser(username)) return send(res, 404, { error: 'user not found' });
      const { quotaBytes } = await readBody(req, ADMIN_BODY_BYTES);
      if (quotaBytes !== null && (!Number.isSafeInteger(quotaBytes) || Number(quotaBytes) < 1024 * 1024 || Number(quotaBytes) > 1024 ** 4)) return send(res, 400, { error: 'invalid quotaBytes' });
      const usage = await blobStore.setUserQuota(username, quotaBytes === null ? undefined : Number(quotaBytes));
      await log('info', 'blob_quota_changed', 'Attachment quota changed', { ip, username, detail: { quotaBytes: usage.quotaBytes } });
      return send(res, 200, { username, usage });
    }
    if (req.method === 'POST' && parts[0] === 'admin' && parts[1] === 'users' && parts[3] === 'quota') {
      const username = parts[2] ?? '';
      if (!await store.getUser(username)) return send(res, 404, { error: 'user not found' });
      const { commitQuotaBytes } = await readBody(req, ADMIN_BODY_BYTES);
      if (commitQuotaBytes !== null && (!Number.isSafeInteger(commitQuotaBytes) || Number(commitQuotaBytes) < 1024 * 1024 || Number(commitQuotaBytes) > 1024 ** 4)) return send(res, 400, { error: 'invalid commitQuotaBytes' });
      await store.setCommitQuota(username, commitQuotaBytes === null ? undefined : Number(commitQuotaBytes));
      await log('info', 'commit_quota_changed', 'Encrypted commit quota changed', { ip, username, detail: { commitQuotaBytes } });
      return send(res, 200, { ok: true });
    }
    if (req.method === 'GET' && path === '/admin/logs') {
      const url = new URL(req.url ?? '/', 'http://localhost');
      const limit = Math.min(Math.max(Number(url.searchParams.get('limit') ?? 100), 1), LOG_RETENTION);
      return send(res, 200, await store.listLogs({ limit, level: url.searchParams.get('level') ?? undefined, from: url.searchParams.get('from') ?? undefined, until: url.searchParams.get('until') ?? undefined, cursor: url.searchParams.get('cursor') ?? undefined }));
    }
    if (req.method === 'GET' && path === '/admin/users') {
      const url = new URL(req.url ?? '/', 'http://localhost');
      const limit = Math.min(Math.max(Number(url.searchParams.get('limit') ?? 100), 1), 500);
      return send(res, 200, await store.listUsers(url.searchParams.get('cursor') ?? '', limit));
    }
    if (req.method === 'GET' && parts[0] === 'admin' && parts[1] === 'users' && parts[3] === 'devices') {
      const username = parts[2] ?? '';
      if (!await store.getUser(username)) return send(res, 404, { error: 'user not found' });
      const sessions = await store.listSessions(username);
      return send(res, 200, { devices: sessions.map(publicSession) });
    }
    if (req.method === 'POST' && parts[0] === 'admin' && parts[1] === 'sessions' && parts[3] === 'revoke') {
      const session = await store.revokeSession(parts[2] ?? '');
      if (!session) return send(res, 404, { error: 'session not found' });
      await log('info', 'device_revoked', 'Revoked sync device session', { ip, username: session.username, detail: { sessionId: session.id, deviceId: session.deviceId } });
      return send(res, 200, { device: publicSession(session) });
    }
    if (req.method === 'POST' && parts[0] === 'admin' && parts[1] === 'users' && parts[3] === 'disable') {
      const username = parts[2] ?? '';
      const body = await readBody(req, ADMIN_BODY_BYTES);
      const user = await store.setUserDisabled(username, typeof body.disabled === 'boolean' ? body.disabled : true);
      if (!user) return send(res, 404, { error: 'user not found' });
      await log('info', user.disabled ? 'user_disabled' : 'user_enabled', user.disabled ? 'Disabled sync user' : 'Enabled sync user', { ip, username });
      return send(res, 200, {
        user: {
          username: user.username,
          disabled: user.disabled,
          createdAt: user.createdAt,
          updatedAt: user.updatedAt,
          lastLoginAt: user.lastLoginAt ?? null,
        },
      });
    }
    if (req.method === 'GET' && path === '/admin/invites') return send(res, 200, { invites: await store.listInvites() });
    if (req.method === 'POST' && path === '/admin/invites') {
      const body = await readBody(req, ADMIN_BODY_BYTES);
      const code = typeof body.code === 'string' && body.code.trim() ? body.code.trim() : randomBytes(12).toString('base64url');
      const invite = await store.createInvite(code);
      await log('info', 'invite_created', 'Created registration invite', { ip });
      return send(res, 200, { invite });
    }
    if (req.method === 'POST' && parts[0] === 'admin' && parts[1] === 'invites' && parts[3] === 'disable') {
      const code = parts[2] ?? '';
      const body = await readBody(req, ADMIN_BODY_BYTES);
      const invite = await store.setInviteDisabled(code, typeof body.disabled === 'boolean' ? body.disabled : true);
      if (!invite) return send(res, 404, { error: 'invite not found' });
      await log('info', invite.disabled ? 'invite_disabled' : 'invite_enabled', invite.disabled ? 'Disabled invite' : 'Enabled invite', { ip });
      return send(res, 200, { invite });
    }
    if (req.method === 'GET' && path === '/admin/registration') return send(res, 200, { mode: await store.registrationMode() });
    if (req.method === 'POST' && path === '/admin/registration') {
      const { mode } = await readBody(req, ADMIN_BODY_BYTES);
      if (mode !== 'open' && mode !== 'invite' && mode !== 'closed') return send(res, 400, { error: 'invalid registration mode' });
      await store.setRegistrationMode(mode);
      await log('info', 'registration_mode_changed', 'Changed registration mode', { ip, detail: { mode } });
      return send(res, 200, { mode });
    }
    return send(res, 404, { error: 'not found' });
  };

  const server = createServer(async (req, res) => {
    if (!applyCors(req, res, allowedOrigins, trustedProxies)) return send(res, 403, { code: 'CORS_ORIGIN_DENIED', error: 'origin is not allowed' });
    if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }
    const url = new URL(req.url ?? '/', 'http://localhost');
    const path = decodePathname(url.pathname);
    const routedPath = stripBasePath(path, basePath);
    const ip = clientIp(req, trustedProxies);
    try {
      await ready;
      if (routedPath === '/api/health' && req.method === 'GET') {
        return send(res, 200, {
          ok: true,
          serverId,
          protocols: [3],
          features: [
            'encrypted-blobs-v1',
            'encrypted-commits-v3',
            'ledger-key-envelope-v1',
            'sqlite-wal-v3',
            'opaque-pake-v1',
            'device-sessions-v1',
          ],
          syncEnabled: enableSync,
          webEnabled: enableWeb && Boolean(options.webDir),
          registrationMode: await store.registrationMode(),
          basePath,
          security: {
            httpsRequired: !allowInsecureHttp,
            adminHttpsRequired: true,
            accessTokenMinutes: ACCESS_TOKEN_TTL_MS / 60_000,
            sessionDays: SESSION_TTL_MS / 86_400_000,
          },
        });
      }
      if (routedPath === '/api/ready' && req.method === 'GET') {
        const verification = await store.verify();
        return send(res, verification.ok ? 200 : 503, { ok: verification.ok, serverId, database: verification });
      }
      if (routedPath && (routedPath === '/admin' || routedPath.startsWith('/admin/'))) {
        if (!secureTransport(req, trustedProxies, false)) return send(res, 426, { code: 'HTTPS_REQUIRED', error: 'HTTPS is required for remote administration' });
        const limit = await allow(ip, 'admin', 120, 60_000);
        if (!limit.allowed) {
          res.setHeader('Retry-After', String(limit.retryAfterSeconds));
          await log('warn', 'rate_limited', 'Admin request rate limited', { ip, status: 429 });
          return send(res, 429, { error: 'rate limited, slow down' });
        }
        return await handleAdmin(req, res, routedPath);
      }
      if (basePath && (path === '/api' || path.startsWith('/api/') || path === '/admin' || path.startsWith('/admin/'))) return send(res, 404, { error: 'not found' });
      if (routedPath && serveWeb(req, res, routedPath, enableWeb ? options.webDir : undefined)) return;
      if (serveWeb(req, res, path, enableWeb ? options.webDir : undefined)) return;
      if (!routedPath) return send(res, 404, { error: 'not found' });
      const apiPath = routedPath;
      if (!enableSync && (apiPath === '/api' || apiPath.startsWith('/api/'))) return send(res, 503, { error: 'sync api disabled' });
      if (!secureTransport(req, trustedProxies, allowInsecureHttp)) return send(res, 426, { code: 'HTTPS_REQUIRED', error: 'HTTPS is required for remote synchronization' });
      const isAuth = apiPath.startsWith('/api/auth/');
      const isBlob = apiPath.startsWith('/api/v3/blobs');
      const rate = await allow(
        ip,
        isAuth ? `auth:${apiPath}` : isBlob ? 'blob' : 'api',
        isAuth ? 20 : isBlob ? 600 : 120,
        60_000,
      );
      if (!rate.allowed) {
        res.setHeader('Retry-After', String(rate.retryAfterSeconds));
        await log('warn', 'rate_limited', 'API request rate limited', { ip, status: 429 });
        return send(res, 429, { error: 'rate limited, slow down' });
      }

      if (req.method === 'POST' && apiPath === '/api/auth/register/start') {
        const { username: rawUsername, registrationRequest, inviteCode } = await readBody(req, AUTH_BODY_BYTES);
        const username = typeof rawUsername === 'string' ? normalizeSyncUsername(rawUsername) : '';
        if (!/^[\p{L}\p{N}_.-]{3,64}$/u.test(username)
          || typeof registrationRequest !== 'string'
          || !registrationRequest
          || registrationRequest.length > AUTH_BODY_BYTES
          || (inviteCode != null && (typeof inviteCode !== 'string' || inviteCode.length > 256))) {
          return send(res, 400, { error: 'invalid registration fields' });
        }
        const normalizedInvite = typeof inviteCode === 'string' ? inviteCode : undefined;
        await store.assertRegistrationAllowed(normalizedInvite);
        if (await store.getUser(username)) return send(res, 409, { code: 'USER_EXISTS', error: 'user exists' });
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
          purpose: 'opaque-registration',
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
      if (req.method === 'POST' && apiPath === '/api/auth/register/finish') {
        const { registrationToken, registrationRecord } = await readBody(req, AUTH_BODY_BYTES);
        const claims = typeof registrationToken === 'string' ? verifyToken(secret, registrationToken) : null;
        if (claims?.purpose !== 'opaque-registration'
          || typeof claims.username !== 'string'
          || typeof registrationRecord !== 'string'
          || !registrationRecord
          || registrationRecord.length > AUTH_BODY_BYTES) {
          return send(res, 400, { error: 'invalid registration completion' });
        }
        await store.register(claims.username, registrationRecord, claims.inviteCode);
        await log('info', 'register_success', 'Registered sync user', { ip, username: claims.username });
        return send(res, 200, { ok: true, serverId });
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
          login.serverLoginState,
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
        const { loginId, finishLoginRequest, deviceId, deviceName } = await readBody(req, AUTH_BODY_BYTES);
        const loginState = typeof loginId === 'string'
          ? await store.consumeOpaqueLoginState(loginId, ip)
          : undefined;
        const user = loginState ? await store.getUser(loginState.username) : undefined;
        let authenticated = false;
        if (loginState && typeof finishLoginRequest === 'string' && finishLoginRequest.length <= AUTH_BODY_BYTES) {
          try {
            opaque.server.finishLogin({
              serverLoginState: loginState.serverLoginState,
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
        return send(res, 200, {
          ...issueAccessToken(user.username, session.id),
          refreshToken,
          session: publicSession(session),
        });
      }
      if (req.method === 'POST' && apiPath === '/api/auth/refresh') {
        const { refreshToken } = await readBody(req, AUTH_BODY_BYTES);
        const sessionId = typeof refreshToken === 'string' ? refreshToken.split('.')[0] ?? '' : '';
        const session = sessionId ? await store.getSession(sessionId) : undefined;
        const user = session ? await store.getUser(session.username) : undefined;
        const suppliedHash = typeof refreshToken === 'string' ? opaqueHash(secret, refreshToken) : '';
        if (!session || !user || user.disabled || session.revokedAt || session.expiresAt <= nowIso()
          || !safeEqual(session.refreshHash, suppliedHash)) {
          await log('warn', 'refresh_failed', 'Session refresh failed', { ip, username: user?.username, status: 401 });
          return send(res, 401, { error: 'invalid refresh token' });
        }
        const nextRefreshToken = createRefreshToken(session.id);
        const rotated = await store.rotateSessionRefresh(session.id, session.refreshHash, opaqueHash(secret, nextRefreshToken), ip);
        if (!rotated) return send(res, 401, { error: 'refresh token already used' });
        return send(res, 200, {
          ...issueAccessToken(user.username, session.id),
          refreshToken: nextRefreshToken,
          session: publicSession(rotated),
        });
      }

      const claims = verifyToken(secret, bearerToken(req));
      const user = claims?.username ? await store.getUser(claims.username) : undefined;
      const session = claims?.sessionId ? await store.getSession(claims.sessionId) : undefined;
      if (!user || !session || session.username !== user.username || session.revokedAt || session.expiresAt <= nowIso()) {
        return send(res, 401, { error: 'unauthorized' });
      }
      if (user.disabled) return send(res, 403, { error: 'user disabled' });
      if (Date.now() - Date.parse(session.lastSeenAt) > 5 * 60 * 1000) await store.touchSession(session.id, ip);

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
        await store.revokeSession(session.id, user.username);
        await log('info', 'logout', 'Sync session logged out', { ip, username: user.username, detail: { sessionId: session.id } });
        return send(res, 200, { ok: true });
      }
      const replica = await store.getReplica(user.username);

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
        { ip, status, detail: { method: req.method, path: routedPath?.replace(/[a-f0-9]{32,64}/g, '<opaque-id>'), code, error: error instanceof Error ? error.message : String(error) } },
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
