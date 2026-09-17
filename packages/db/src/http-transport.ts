/** HTTP transport for protocol-v3 relay APIs carrying commit-DAG v2 envelopes. */
import { requestJson as fetch, HttpRequestError, type HttpRequestOptions } from './http-request.js';
import {
  decryptJson,
  encryptJson,
  isPlainHttpHost,
  normalizeSyncUsername,
  sha256Json,
  type Encrypted,
  type LedgerCryptoSession,
  type LedgerKeyEnvelope,
  type SyncCommitV2,
} from '@zichan/core';
import type { CommitTransport, ReplicaConnection } from './event-sync.js';
import type { SyncReplicaIdentity } from './sync-types.js';


export interface HttpTransportOptions {
  baseUrl: string;
  token: string;
  /** Unwrapped only for this application session; never sent to the server. */
  cryptoSession: LedgerCryptoSession;
  /** Opaque password-wrapped keyring replicated to every configured server. */
  keyEnvelope: LedgerKeyEnvelope;
  /** Refuse to create a server-side binding; used by destructive join preflight. */
  requireExistingReplica?: boolean;
}

export interface RegisterAccountOptions extends HttpRequestOptions {
  passwordResetCode?: string;
  initializeOwner?: boolean;
  ownerSetupToken?: string;
  inviteCode?: string;
  expectedServerId?: string;
  expectedServerPublicKey?: string;
}

export interface RegisterAccountResult {
  role: 'owner' | 'admin' | 'viewer' | 'member';
}

export interface LoginAccountOptions extends HttpRequestOptions {
  sessionContext?: 'admin';
  sessionTransport?: 'cookie' | 'token';
  deviceId?: string;
  deviceName?: string;
  expectedServerPublicKey?: string;
  expectedServerId?: string;
}

export interface SyncAuthSession {
  accountId?: string;
  sessionTransport?: 'cookie' | 'token';
  accessToken: string;
  refreshToken: string;
  accessExpiresAt: string;
  session: {
    id: string;
    username: string;
    deviceId: string;
    deviceName: string;
    createdAt: string;
    updatedAt: string;
    expiresAt: string;
    lastSeenAt: string;
    lastIp: string | null;
    revokedAt: string | null;
    active: boolean;
  };
  role?: 'owner' | 'admin' | 'viewer' | 'member';
  ledgerId?: string;
}

export interface SyncAuthMe {
  accountId?: string;
  username: string;
  role: 'owner' | 'admin' | 'viewer' | 'member';
  disabled: boolean;
  session: SyncAuthSession['session'];
  ledgerId?: string;
  replicaId?: string;
  streamEpoch?: string;
}

function context(ledgerId: string, commitId: string, contentHash: string) {
  return { protocol: 2, ledgerId, commitId, contentHash };
}

async function errorMessage(prefix: string, response: { status: number; json(): Promise<unknown> }): Promise<Error> {
  try {
    const body = await response.json() as { error?: string; code?: string };
    return new HttpRequestError('http', `${prefix}: HTTP ${response.status}${body?.code ? ` ${body.code}` : ''}${body?.error ? ` ${body.error}` : ''}`, response.status);
  } catch {
    return new HttpRequestError('http', `${prefix}: HTTP ${response.status}`, response.status);
  }
}

function localNetworkHostname(hostname: string): boolean {
  const normalized = hostname.toLowerCase();
  const ipv6Literal = normalized.startsWith('[') && normalized.endsWith(']');
  const value = ipv6Literal ? normalized.slice(1, -1) : normalized;
  if (value === 'localhost' || value.endsWith('.localhost')) return true;
  if (ipv6Literal) {
    if (value === '::1') return true;
    // The URL parser has already validated and canonicalized a bracketed IPv6
    // literal. Apply CIDR checks only to that literal, never to a DNS name that
    // happens to begin with "fc" or "fd".
    const firstHextet = Number.parseInt(value.split(':', 1)[0] ?? '', 16);
    if (!Number.isInteger(firstHextet)) return false;
    return (firstHextet & 0xfe00) === 0xfc00 // fc00::/7 (ULA)
      || (firstHextet & 0xffc0) === 0xfe80; // fe80::/10 (link-local)
  }
  const parts = value.split('.').map(Number);
  if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) return false;
  return parts[0] === 127
    || parts[0] === 10
    || (parts[0] === 172 && parts[1]! >= 16 && parts[1]! <= 31)
    || (parts[0] === 192 && parts[1] === 168)
    || (parts[0] === 169 && parts[1] === 254);
}

export function isLocalNetworkSyncUrl(baseUrl: string): boolean {
  try {
    const url = new URL(baseUrl);
    return (url.protocol === 'http:' || url.protocol === 'https:') && localNetworkHostname(url.hostname);
  } catch {
    return false;
  }
}

/**
 * Prevent credentials and bearer tokens from being sent to public HTTP
 * endpoints. Plain HTTP remains available for loopback, explicit LAN use, and
 * the reviewed hosts in `PLAIN_HTTP_HOST_ALLOWLIST` (@zichan/core).
 *
 * The browser enforces the same policy a second time through `connect-src`, so
 * an exception added to that list must also reach the CSP in @zichan/sync-server.
 */
export function assertSecureSyncUrl(baseUrl: string): void {
  let url: URL;
  try {
    url = new URL(baseUrl);
  } catch {
    throw new Error('同步服务器地址无效');
  }
  if (url.username || url.password) throw new Error('同步服务器地址不能包含用户名或密码');
  if (url.protocol === 'https:') return;
  if (url.protocol === 'http:' && (isLocalNetworkSyncUrl(url.toString()) || isPlainHttpHost(url.hostname))) return;
  throw new Error('公网同步必须使用 HTTPS；HTTP 仅允许本机、私有局域网或已显式放行的主机');
}

export function httpCommitTransport(opts: HttpTransportOptions): CommitTransport {
  assertSecureSyncUrl(opts.baseUrl);
  const headers = { 'Content-Type': 'application/json', Authorization: `Bearer ${opts.token}` };
  let connection: ReplicaConnection | undefined;

  const readReplica = async (): Promise<{
    serverId: string;
    bound: boolean;
    ledgerId?: string;
    replicaId?: string;
    streamEpoch?: string;
    headSeq?: number;
  }> => {
    const response = await fetch(`${opts.baseUrl}/api/v3/replica`, { headers, redirect: 'error' });
    if (!response.ok) throw await errorMessage('replica lookup failed', response);
    return response.json() as Promise<{
      serverId: string;
      bound: boolean;
      ledgerId?: string;
      replicaId?: string;
      streamEpoch?: string;
      headSeq?: number;
    }>;
  };

  return {
    async connect(ledgerId) {
      if (connection) {
        if (connection.ledgerId !== ledgerId) throw new Error(`LEDGER_MISMATCH:${connection.ledgerId}`);
        return connection;
      }
      let replica = await readReplica();
      if (!replica.bound) {
        if (opts.requireExistingReplica) throw new Error('同步账号尚未绑定远端账本');
        const response = await fetch(`${opts.baseUrl}/api/v3/replica/bind`, {
          method: 'POST', headers, body: JSON.stringify({ ledgerId }), redirect: 'error',
        });
        if (!response.ok) throw await errorMessage('replica bind failed', response);
        replica = await readReplica();
      }
      if (replica.ledgerId !== ledgerId) throw new Error(`LEDGER_MISMATCH:${replica.ledgerId ?? 'unknown'}`);
      if (!replica.replicaId || !replica.streamEpoch || !replica.serverId) throw new Error('同步副本身份不完整');
      connection = {
        serverId: replica.serverId,
        replicaId: replica.replicaId,
        streamEpoch: replica.streamEpoch,
        ledgerId,
        headSeq: Number(replica.headSeq ?? 0),
      };
      if (opts.cryptoSession.ledgerId !== ledgerId || opts.keyEnvelope.ledgerId !== ledgerId) {
        throw new Error('账本数据与已解锁密钥包不匹配');
      }
      const remoteEnvelope = await fetchLedgerKeyEnvelope(opts.baseUrl, opts.token);
      if (opts.requireExistingReplica) {
        if (!remoteEnvelope) throw new Error('远端账本密钥封套在预检期间消失');
        if (await sha256Json(remoteEnvelope) !== await sha256Json(opts.keyEnvelope)) {
          throw new Error('远端账本密钥封套在预检期间发生变化');
        }
      } else if (!remoteEnvelope) {
        await putLedgerKeyEnvelope(opts.baseUrl, opts.token, opts.keyEnvelope);
      } else if (remoteEnvelope.keyringId !== opts.keyEnvelope.keyringId) {
        throw new Error('同步服务器保存的是另一个账本密钥包');
      } else if (remoteEnvelope.generation > opts.keyEnvelope.generation) {
        throw new Error('同步服务器有更新的账本密钥包，请先获取并重新解锁');
      } else if (remoteEnvelope.generation < opts.keyEnvelope.generation) {
        await putLedgerKeyEnvelope(opts.baseUrl, opts.token, opts.keyEnvelope);
      }
      return connection;
    },

    async pullCommits(identity: SyncReplicaIdentity, afterSeq: number, limit = 200) {
      const response = await fetch(
        `${opts.baseUrl}/api/v3/commits?after=${encodeURIComponent(String(afterSeq))}&limit=${encodeURIComponent(String(limit))}`,
        { headers, redirect: 'error' },
      );
      if (!response.ok) throw await errorMessage('commit pull failed', response);
      const body = await response.json() as {
        commits?: { seq: number; commitId: string; ledgerId: string; contentHash: string; encCommit: Encrypted }[];
        nextSeq?: number;
        headSeq?: number;
        hasMore?: boolean;
        serverId?: string;
        replicaId?: string;
        streamEpoch?: string;
      };
      if (body.serverId !== identity.serverId || body.replicaId !== identity.replicaId || body.streamEpoch !== identity.streamEpoch) {
        throw new Error('同步副本身份在拉取期间发生变化');
      }
      const commits = [];
      for (const row of body.commits ?? []) {
        if (row.ledgerId !== identity.ledgerId) throw new Error(`LEDGER_MISMATCH:${row.ledgerId}`);
        const commit = await decryptJson<SyncCommitV2>(opts.cryptoSession, row.encCommit, context(row.ledgerId, row.commitId, row.contentHash));
        const actualHash = await sha256Json(commit);
        if (actualHash !== row.contentHash || commit.commitId !== row.commitId || commit.ledgerId !== row.ledgerId) {
          throw new Error(`同步提交 ${row.commitId} 内容校验失败`);
        }
        commits.push({ seq: row.seq, commit, contentHash: row.contentHash });
      }
      return {
        commits,
        nextSeq: Number(body.nextSeq ?? afterSeq),
        headSeq: Number(body.headSeq ?? 0),
        hasMore: body.hasMore === true,
      };
    },

    async pushCommits(identity: SyncReplicaIdentity, commits: SyncCommitV2[]) {
      const encrypted = [];
      for (const commit of commits) {
        if (commit.ledgerId !== identity.ledgerId) throw new Error(`LEDGER_MISMATCH:${commit.ledgerId}`);
        const contentHash = await sha256Json(commit);
        encrypted.push({
          commitId: commit.commitId,
          ledgerId: commit.ledgerId,
          contentHash,
          encCommit: await encryptJson(opts.cryptoSession, commit, context(commit.ledgerId, commit.commitId, contentHash)),
        });
      }
      const response = await fetch(`${opts.baseUrl}/api/v3/commits`, {
        method: 'POST', headers, body: JSON.stringify({ commits: encrypted }), redirect: 'error',
      });
      if (!response.ok) throw await errorMessage('commit push failed', response);
      const body = await response.json() as {
        assigned?: { commitId: string; seq: number; contentHash: string }[];
        headSeq?: number;
        serverId?: string;
        replicaId?: string;
        streamEpoch?: string;
      };
      if (body.serverId !== identity.serverId || body.replicaId !== identity.replicaId || body.streamEpoch !== identity.streamEpoch) {
        throw new Error('同步副本身份在推送期间发生变化');
      }
      return { assigned: body.assigned ?? [], headSeq: Number(body.headSeq ?? 0) };
    },
  };
}

export async function fetchLedgerKeyEnvelope(baseUrl: string, token: string): Promise<LedgerKeyEnvelope | undefined> {
  assertSecureSyncUrl(baseUrl);
  const response = await fetch(`${baseUrl}/api/v3/key-envelope`, { headers: { Authorization: `Bearer ${token}` }, redirect: 'error' });
  if (!response.ok) throw await errorMessage('key envelope lookup failed', response);
  const body = await response.json() as { envelope?: LedgerKeyEnvelope | null };
  return body.envelope ?? undefined;
}

export async function putLedgerKeyEnvelope(baseUrl: string, token: string, envelope: LedgerKeyEnvelope): Promise<void> {
  assertSecureSyncUrl(baseUrl);
  const response = await fetch(`${baseUrl}/api/v3/key-envelope`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify({ envelope }),
    redirect: 'error',
  });
  if (!response.ok) throw await errorMessage('key envelope update failed', response);
}

export async function registerAccount(baseUrl: string, username: string, password: string, opts: RegisterAccountOptions = {}): Promise<RegisterAccountResult> {
  assertSecureSyncUrl(baseUrl);
  const normalized = normalizeSyncUsername(username);
  if (!normalized || !password) throw new Error('同步用户名和密码不能为空');
  const opaque = await import('@serenity-kit/opaque');
  await opaque.ready;
  const start = opaque.client.startRegistration({ password });
  const operation = opts.passwordResetCode ? 'password-reset' : 'register';
  const registrationHeaders = { 'Content-Type': 'application/json', ...(opts.initializeOwner ? { 'X-Zichan-Session': 'admin-cookie' } : {}) };
  const startResponse = await fetch(`${baseUrl}/api/auth/${operation}/start`, {
    method: 'POST',
    headers: registrationHeaders,
    body: JSON.stringify({
      username: normalized,
      registrationRequest: start.registrationRequest,
      inviteCode: opts.inviteCode || undefined,
      ownerSetupToken: opts.ownerSetupToken || undefined,
      initializeOwner: opts.initializeOwner || undefined,
      passwordResetCode: opts.passwordResetCode || undefined,
    }),
    redirect: 'error',
  }, opts);
  if (!startResponse.ok) throw await errorMessage('register start failed', startResponse);
  const startBody = await startResponse.json() as {
    registrationResponse?: string;
    registrationToken?: string;
    serverId?: string;
    serverPublicKey?: string;
  };
  if (!startBody.registrationResponse || !startBody.registrationToken || !startBody.serverId || !startBody.serverPublicKey) {
    throw new Error('register start returned an incomplete OPAQUE response');
  }
  if (opts.expectedServerId && opts.expectedServerId !== startBody.serverId) {
    throw new Error('同步服务器 ID 与已验证记录不一致');
  }
  if (opts.expectedServerPublicKey && opts.expectedServerPublicKey !== startBody.serverPublicKey) {
    throw new Error('同步服务器身份公钥与已验证记录不一致');
  }
  const finish = opaque.client.finishRegistration({
    password,
    registrationResponse: startBody.registrationResponse,
    clientRegistrationState: start.clientRegistrationState,
    identifiers: { client: normalized, server: startBody.serverId },
    keyStretching: 'memory-constrained',
  });
  if (finish.serverStaticPublicKey !== startBody.serverPublicKey) {
    throw new Error('同步服务器 OPAQUE 公钥校验失败');
  }
  const finishResponse = await fetch(`${baseUrl}/api/auth/${operation}/finish`, {
    method: 'POST',
    headers: registrationHeaders,
    body: JSON.stringify({
      registrationToken: startBody.registrationToken,
      registrationRecord: finish.registrationRecord,
    }),
    redirect: 'error',
  }, opts);
  if (!finishResponse.ok) throw await errorMessage('register finish failed', finishResponse);
  const result = await finishResponse.json() as { role?: 'owner' | 'admin' | 'viewer' | 'member' };
  if (result.role !== 'owner' && result.role !== 'admin' && result.role !== 'member') throw new Error('register finish returned an invalid account role');
  return { role: result.role };
}

function generatedDeviceId(): string {
  const id = globalThis.crypto?.randomUUID?.();
  return id ? `client-${id}` : `client-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

export async function loginAccount(
  baseUrl: string,
  username: string,
  password: string,
  options: LoginAccountOptions = {},
): Promise<SyncAuthSession> {
  assertSecureSyncUrl(baseUrl);
  const normalized = normalizeSyncUsername(username);
  if (!normalized || !password) throw new Error('同步用户名和密码不能为空');
  const opaque = await import('@serenity-kit/opaque');
  await opaque.ready;
  const start = opaque.client.startLogin({ password });
  const startResponse = await fetch(`${baseUrl}/api/auth/login/start`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: normalized, startLoginRequest: start.startLoginRequest }),
    redirect: 'error',
  }, options);
  if (!startResponse.ok) throw await errorMessage('login start failed', startResponse);
  const startBody = await startResponse.json() as {
    loginId?: string;
    loginResponse?: string;
    serverId?: string;
    serverPublicKey?: string;
  };
  if (!startBody.loginId || !startBody.loginResponse || !startBody.serverId || !startBody.serverPublicKey) {
    throw new Error('login start returned an incomplete OPAQUE response');
  }
  if (options.expectedServerId && options.expectedServerId !== startBody.serverId) {
    throw new Error('同步服务器 ID 与已信任记录不一致');
  }
  if (options.expectedServerPublicKey && options.expectedServerPublicKey !== startBody.serverPublicKey) {
    throw new Error('同步服务器身份公钥与已信任记录不一致');
  }
  const finish = opaque.client.finishLogin({
    clientLoginState: start.clientLoginState,
    loginResponse: startBody.loginResponse,
    password,
    identifiers: { client: normalized, server: startBody.serverId },
    keyStretching: 'memory-constrained',
  });
  if (!finish) throw new Error('同步用户名或密码错误');
  if (finish.serverStaticPublicKey !== startBody.serverPublicKey) {
    throw new Error('同步服务器 OPAQUE 公钥校验失败');
  }
  const loginResponse = await fetch(`${baseUrl}/api/auth/login/finish`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...(options.sessionTransport === 'cookie' ? { 'X-Zichan-Session': options.sessionContext === 'admin' ? 'admin-cookie' : 'cookie' } : {}) },
    credentials: options.sessionTransport === 'cookie' ? 'same-origin' : 'omit',
    body: JSON.stringify({
      loginId: startBody.loginId,
      finishLoginRequest: finish.finishLoginRequest,
      deviceId: options.deviceId ?? generatedDeviceId(),
      deviceName: options.deviceName?.trim() || 'Zichan client',
    }),
    redirect: 'error',
  }, options);
  if (!loginResponse.ok) throw await errorMessage('login failed', loginResponse);
  return readAuthSession(loginResponse, options.sessionTransport ?? 'token');
}

async function readAuthSession(response: { json(): Promise<unknown> }, transport: 'cookie' | 'token'): Promise<SyncAuthSession> {
  const body = await response.json() as SyncAuthSession;
  if (!body.accessToken || !body.accessExpiresAt || !body.session?.id || !body.session.expiresAt
    || (transport === 'cookie' ? body.sessionTransport !== 'cookie' || body.refreshToken !== undefined : !body.refreshToken)) {
    throw new Error('authentication returned an incomplete or mismatched session');
  }
  return { ...body, sessionTransport: transport, refreshToken: transport === 'cookie' ? '' : body.refreshToken };
}

export async function refreshAccountSession(baseUrl: string, refreshToken: string, transport: 'cookie' | 'token' = 'token', context?: 'admin', options: HttpRequestOptions = {}): Promise<SyncAuthSession> {
  assertSecureSyncUrl(baseUrl);
  const response = await fetch(`${baseUrl}/api/auth/refresh`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...(transport === 'cookie' ? { 'X-Zichan-Session': context === 'admin' ? 'admin-cookie' : 'cookie' } : {}) },
    credentials: transport === 'cookie' ? 'same-origin' : 'omit',
    body: JSON.stringify(transport === 'cookie' ? {} : { refreshToken }),
    redirect: 'error',
  }, options);
  if (!response.ok) throw await errorMessage('session refresh failed', response);
  return readAuthSession(response, transport);
}

export async function fetchAuthMe(baseUrl: string, accessToken: string, options: HttpRequestOptions = {}): Promise<SyncAuthMe> {
  assertSecureSyncUrl(baseUrl);
  const response = await fetch(`${baseUrl}/api/auth/me`, {
    headers: { Authorization: `Bearer ${accessToken}` },
    redirect: 'error',
  }, options);
  if (!response.ok) throw await errorMessage('account lookup failed', response);
  const body = await response.json() as SyncAuthMe;
  // The read-only operator is a valid role here: it is an administrator that may only read.
  if (!body.username || (body.role !== 'owner' && body.role !== 'admin' && body.role !== 'viewer' && body.role !== 'member') || !body.session?.id) {
    throw new Error('account lookup returned an incomplete response');
  }
  return body;
}
