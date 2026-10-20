import { completeMfaLogin, fetchAuthMe, loginAccount, MfaRequiredError, refreshAccountSession, registerAccount, type MfaChallenge, type SyncAuthMe, type SyncAuthSession } from '@zichan/db';

export interface AdminHealth {
  serverId: string;
  serverPublicKey: string;
  claimed: boolean;
  capabilities: string[];
}

export class AdminError extends Error {
  constructor(readonly status: number, readonly code: string, message: string, readonly requestId?: string) { super(message); }
}

async function readAdminJson<T>(res: Response): Promise<T> {
  try { return await res.json() as T; }
  catch {
    throw new AdminError(res.status, 'INVALID_API_RESPONSE', '管理 API 未返回有效 JSON，可能连接到了前端页面或开发代理未启动。请运行 npm run start:all 后重试，或使用服务器启动日志中的管理后台安全地址。');
  }
}

async function timedRequest<T>(url: string, init: RequestInit, read: (response: Response) => Promise<T>, timeout = 30_000): Promise<T> {
  const controller = new AbortController();
  const cancel = () => controller.abort(init.signal?.reason);
  init.signal?.addEventListener('abort', cancel, { once: true });
  if (init.signal?.aborted) cancel();
  let timedOut = false;
  const timer = setTimeout(() => { timedOut = true; controller.abort(); }, timeout);
  try {
    return await read(await fetch(url, { ...init, signal: controller.signal }));
  } catch (error) {
    if (timedOut) throw new AdminError(0, 'REQUEST_TIMEOUT', init.method === 'POST'
      ? '请求超时，服务器可能已完成操作。请先刷新核实结果，再决定是否重试；未自动重复提交。'
      : '读取超时，请检查服务器连接后重试。');
    throw error;
  } finally {
    clearTimeout(timer);
    init.signal?.removeEventListener('abort', cancel);
  }
}

/**
 * The filename a download response asked to be saved as.
 *
 * Prefers RFC 5987 `filename*` (UTF-8 percent-encoded) over the plain `filename`, because a
 * ledger's files routinely have non-ASCII names and the plain form cannot carry them. Falls back
 * to an empty string so the caller can substitute its own.
 */
export function fileNameFromDisposition(header: string | null): string {
  if (!header) return '';
  const extended = /filename\*=UTF-8''([^;]+)/i.exec(header);
  if (extended?.[1]) {
    try { return decodeURIComponent(extended[1].trim()); } catch { /* fall through to the plain form */ }
  }
  const plain = /filename="([^"]*)"/i.exec(header);
  return plain?.[1] ?? '';
}

export function adminBaseUrl(location: Pick<Location, 'origin' | 'pathname'>): string | undefined {
  const match = /^(.*)\/[^/]+\/admin(?:\/.*)?$/.exec(location.pathname);
  return match ? `${location.origin}${match[1]}` : undefined;
}

/**
 * A 404 with no error code is not a missing record: the server does not serve this route at
 * all. In practice that means the console is newer than the process answering it - a page
 * served from source against a server built before the route existed. Passing the server's
 * bare "not found" through tells the operator nothing and reads like their data is gone, so
 * name the mismatch and the fix instead.
 */
export function describeUnservedRoute(status: number, code: string, text: string): string {
  if (status !== 404 || code) return text;
  return /^not found$/i.test(text.trim())
    ? '服务器未提供该管理接口（HTTP 404）。这通常表示运行中的服务端比当前页面旧：请先重新构建并重启服务端（npm run build:server 后 npm run start:all），再刷新本页。'
    : text;
}

/** Management sessions never enter ledger stores, localStorage or sessionStorage. */
export class AdminClient {
  private session?: SyncAuthSession;
  private identity?: AdminHealth;
  /** Set between a password that needs a code and the answer that completes the login. */
  private pendingMfa?: { username: string; challenge: MfaChallenge; health: AdminHealth; generation: number };
  private generation = 0;
  private controller = new AbortController();
  private refreshing?: Promise<void>;
  private channel?: BroadcastChannel;

  constructor(readonly baseUrl: string, private readonly onLost: (message: string) => void) {
    if (typeof BroadcastChannel !== 'undefined') {
      this.channel = new BroadcastChannel(`zichan:admin:${baseUrl}`);
      this.channel.onmessage = () => { this.clear(); this.onLost('其他标签页已改变管理会话，请重新登录。'); };
    }
  }

  private clear(): void {
    this.generation++;
    this.controller.abort();
    this.controller = new AbortController();
    this.session = undefined;
    this.pendingMfa = undefined;
    this.refreshing = undefined;
  }

  dispose(): void { this.clear(); this.channel?.close(); }

  private current(generation: number): void {
    if (generation !== this.generation) throw new DOMException('旧管理请求已取消', 'AbortError');
  }

  async health(): Promise<AdminHealth> {
    const generation = this.generation;
    const body = await timedRequest(`${this.baseUrl}/api/health`, { cache: 'no-store', redirect: 'error', signal: this.controller.signal }, async (res) => {
      if (!res.ok) throw new AdminError(res.status, '', `无法连接管理 API（HTTP ${res.status}）。请确认服务器已启动；开发模式使用 npm run start:all，启动后刷新页面重试。`);
      return readAdminJson<AdminHealth>(res);
    });
    this.current(generation);
    if (!body.serverId || !body.serverPublicKey || !body.capabilities?.includes('server-management-v1')) throw new Error('服务器尚未升级到独立管理后台版本');
    if (this.identity && (body.serverId !== this.identity.serverId || body.serverPublicKey !== this.identity.serverPublicKey)) throw new Error('服务器身份已变化，请核实部署后重新打开管理后台');
    this.identity = body;
    return body;
  }

  async login(username: string, password: string, initializeOwner = false, onInitialized?: () => void): Promise<SyncAuthMe> {
    this.clear();
    const generation = this.generation;
    const health = await this.health();
    if (initializeOwner) {
      if (health.claimed) throw new Error('管理员已设置，请使用已有账号登录。');
      await registerAccount(this.baseUrl, username, password, { signal: this.controller.signal, initializeOwner: true, expectedServerId: health.serverId, expectedServerPublicKey: health.serverPublicKey });
      this.current(generation);
      onInitialized?.();
    }
    let session: SyncAuthSession;
    try {
      session = await loginAccount(this.baseUrl, username, password, { signal: this.controller.signal, sessionTransport: 'cookie', sessionContext: 'admin', deviceName: 'Zichan · 服务器管理后台', expectedServerId: health.serverId, expectedServerPublicKey: health.serverPublicKey });
    } catch (error) {
      // A password accepted without a code is not a session: the challenge is kept in memory and
      // the console asks for the code before anything is treated as authenticated.
      if (error instanceof MfaRequiredError) {
        this.pendingMfa = { username, challenge: error.mfa, health, generation };
      }
      throw error;
    }
    this.current(generation);
    return this.adopt(session, generation);
  }

  /** Answers the second factor for a login that `login` left pending. */
  async completeMfa(code: string): Promise<SyncAuthMe> {
    const pending = this.pendingMfa;
    if (!pending) throw new AdminError(400, 'MFA_CHALLENGE_MISSING', '两步验证挑战已失效，请重新输入账号密码登录。');
    this.current(pending.generation);
    let session: SyncAuthSession;
    try {
      session = await completeMfaLogin(this.baseUrl, pending.challenge.challenge, code, {
        signal: this.controller.signal, sessionTransport: 'cookie', sessionContext: 'admin',
        deviceName: 'Zichan · 服务器管理后台', expectedServerId: pending.health.serverId, expectedServerPublicKey: pending.health.serverPublicKey,
      });
    } catch (error) {
      // A wrong code keeps the challenge alive; only expiry or an already-answered challenge
      // sends the operator back to the password step.
      if (error instanceof AdminError && (error.status === 410 || error.status === 409)) this.pendingMfa = undefined;
      throw error;
    }
    this.current(pending.generation);
    return this.adopt(session, pending.generation);
  }

  /** The challenge this tab is answering, if any. */
  pendingChallenge(): MfaChallenge | undefined { return this.pendingMfa?.challenge; }

  private async adopt(session: SyncAuthSession, generation: number): Promise<SyncAuthMe> {
    this.pendingMfa = undefined;
    this.session = session;
    this.current(generation);
    const account = await this.me();
    if (account.role === 'member') {
      await this.logout();
      throw new AdminError(403, 'ADMIN_REQUIRED', '此账号没有服务器管理权限，请使用所有者或管理员账号。');
    }
    this.channel?.postMessage('session-changed');
    return account;
  }

  async restore(): Promise<SyncAuthMe | undefined> {
    try {
      await this.refresh();
      const account = await this.me();
      if (account.role === 'member') { await this.logout(); return undefined; }
      return account;
    } catch (error) {
      if (error instanceof AdminError && error.status === 401 || error instanceof Error && /HTTP 401/.test(error.message)) return undefined;
      throw error;
    }
  }

  private async refresh(): Promise<void> {
    if (this.refreshing) return this.refreshing;
    const generation = this.generation;
    const expected = this.session?.accountId;
    const pending = (async () => {
      await this.health();
      const run = async () => {
        this.current(generation);
        const session = await refreshAccountSession(this.baseUrl, '', 'cookie', 'admin', { signal: this.controller.signal });
        this.current(generation);
        if (expected && session.accountId !== expected) throw new AdminError(401, 'ACCOUNT_CHANGED', '管理账号已改变，请重新登录');
        this.session = session;
      };
      if (globalThis.navigator?.locks) await navigator.locks.request(`zichan:admin-refresh:${this.baseUrl}`, run);
      else await run();
    })();
    this.refreshing = pending;
    try { await pending; } finally { if (this.refreshing === pending) this.refreshing = undefined; }
  }

  /** The session this tab is using: it ends through logout, never through a revoke button. */
  currentSessionId(): string | undefined { return this.session?.session.id; }

  async me(): Promise<SyncAuthMe> {
    const generation = this.generation;
    const result = await fetchAuthMe(this.baseUrl, this.session?.accessToken ?? '', { signal: this.controller.signal });
    this.current(generation);
    return result;
  }

  /**
   * `idempotencyKey` makes a retried write safe: the server replays the first result
   * for the same key and parameters instead of creating the work twice.
   */
  async request<T>(path: string, body?: unknown, options: { idempotencyKey?: string; timeoutMs?: number } = {}): Promise<T> {
    const generation = this.generation;
    try {
      if (!this.session || Date.parse(this.session.accessExpiresAt) < Date.now() + 30_000) await this.refresh();
      this.current(generation);
      return await timedRequest(`${this.baseUrl}/api/admin${path}`, {
        method: body === undefined ? 'GET' : 'POST', cache: 'no-store', redirect: 'error', signal: this.controller.signal,
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${this.session!.accessToken}`,
          ...(options.idempotencyKey ? { 'Idempotency-Key': options.idempotencyKey } : {}),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      }, async (res) => {
        const result = await readAdminJson<{ code?: string; error?: string; requestId?: string }>(res);
        this.current(generation);
        if (!res.ok) throw new AdminError(res.status, result.code ?? '', describeUnservedRoute(res.status, result.code ?? '', result.error ?? `HTTP ${res.status}`), result.requestId ?? res.headers?.get?.('x-request-id') ?? undefined);
        return result as T;
      }, options.timeoutMs ?? (path.endsWith('/verify') ? 120_000 : 30_000));
    } catch (error) {
      this.current(generation);
      if (error instanceof AdminError && (error.status === 401 || error.code === 'ADMIN_REQUIRED')
        || error instanceof Error && /HTTP 401/.test(error.message)) {
        this.clear(); this.onLost('管理会话已失效，请重新登录；现有账本数据不受影响。');
      }
      throw error;
    }
  }

  /**
   * Changes this administrator’s own account password.
   *
   * The current password is proved the same way the ledger app proves it — a fresh OPAQUE
   * login — because that is the only thing that answers “does the person at this keyboard
   * know the current password right now”. The console’s own session cannot answer it: it
   * only proves somebody signed in on this browser, possibly a long time ago.
   *
   * The proof gets a throwaway token session, never the console’s cookie: a login overwrites
   * that cookie, so a mistyped current password would silently sign the operator out. The proof
   * session authorizes the change and is discarded either way; the change itself revokes every
   * session of the account, this console’s included, so the caller ends up signed out.
   *
   * The second factor guards console login, not this operation: an administrator’s ledger login
   * deliberately skips it, and this proof is a ledger-shaped login. Asking for a code here would
   * mean one server operation had two different rules depending on which page called it.
   */
  async changePassword(currentPassword: string, nextPassword: string): Promise<void> {
    const generation = this.generation;
    if (!currentPassword) throw new AdminError(400, 'PASSWORD_REQUIRED', '请输入当前账号密码。');
    if (nextPassword.length < 8) throw new AdminError(400, 'PASSWORD_TOO_SHORT', '新账号密码至少八位。');
    if (currentPassword === nextPassword) throw new AdminError(400, 'PASSWORD_UNCHANGED', '新账号密码不能与当前账号密码相同。');
    const username = this.session?.session.username;
    if (!username) throw new AdminError(401, 'ADMIN_REQUIRED', '管理会话已失效，请重新登录。');
    const health = await this.health();
    this.current(generation);
    const identity = { expectedServerId: health.serverId, expectedServerPublicKey: health.serverPublicKey };
    const verified = await loginAccount(this.baseUrl, username, currentPassword, {
      ...identity, deviceName: 'Zichan · 修改管理密码', sessionTransport: 'token',
    });
    this.current(generation);
    try {
      const authorized = await fetch(`${this.baseUrl}/api/auth/password-change/authorize`, {
        method: 'POST', cache: 'no-store', redirect: 'error', signal: this.controller.signal,
        headers: { Authorization: 'Bearer ' + verified.accessToken },
      });
      this.current(generation);
      const body = await readAdminJson<{ code?: string; error?: string }>(authorized);
      if (!authorized.ok || !body.code) throw new AdminError(authorized.status, body.code ?? '', body.error ?? `无法授权本次密码变更（HTTP ${authorized.status}）`);
      await registerAccount(this.baseUrl, username, nextPassword, { ...identity, passwordResetCode: body.code });
      this.current(generation);
    } finally {
      // The change already revoked this session; a failed attempt must not leave an extra live one.
      await fetch(`${this.baseUrl}/api/auth/logout`, {
        method: 'POST', cache: 'no-store', redirect: 'error',
        headers: { Authorization: 'Bearer ' + verified.accessToken },
      }).catch(() => undefined);
    }
    // Every session of this account is gone now, this console’s included.
    this.clear();
    this.channel?.postMessage('session-changed');
  }

  /** Controlled export: the server decides which fields are safe to leave the console. */
  async download(path: string): Promise<string> {
    const generation = this.generation;
    if (!this.session || Date.parse(this.session.accessExpiresAt) < Date.now() + 30_000) await this.refresh();
    this.current(generation);
    const response = await fetch(`${this.baseUrl}/api/admin${path}`, {
      cache: 'no-store', redirect: 'error', signal: this.controller.signal,
      headers: { Authorization: `Bearer ${this.session!.accessToken}` },
    });
    this.current(generation);
    if (!response.ok) throw new AdminError(response.status, '', `导出失败（HTTP ${response.status}）`);
    return response.text();
  }

  /**
   * Fetch decrypted bytes, such as one attachment of a previewed ledger.
   *
   * Separate from `request` because that one parses JSON, and a user's file is not JSON. The
   * server names the file in `Content-Disposition`, so the browser saves it under the name the
   * ledger recorded rather than one this page invented.
   */
  async fetchBytes(path: string): Promise<{ blob: Blob; fileName: string }> {
    const generation = this.generation;
    if (!this.session || Date.parse(this.session.accessExpiresAt) < Date.now() + 30_000) await this.refresh();
    this.current(generation);
    const response = await fetch(`${this.baseUrl}/api/admin${path}`, {
      cache: 'no-store', redirect: 'error', signal: this.controller.signal,
      headers: { Authorization: `Bearer ${this.session?.accessToken ?? ''}` },
    });
    this.current(generation);
    if (!response.ok) {
      // The route answers with a JSON error body even for a binary request, so the operator gets
      // the server's own words ("服务器上没有这份附件的正文") rather than a bare status code.
      const body = await response.json().catch(() => ({})) as { code?: string; error?: string };
      throw new AdminError(response.status, body.code ?? '', body.error ?? `下载失败（HTTP ${response.status}）`);
    }
    const blob = await response.blob();
    this.current(generation);
    return {
      blob,
      fileName: fileNameFromDisposition(response.headers.get('content-disposition')),
    };
  }

  /**
   * Send a method that is neither a read nor a JSON write.
   *
   * `request` decides between GET and POST from whether a body was passed, which cannot express
   * DELETE — and a DELETE sent as a GET does not fail, it silently does nothing. That is exactly
   * how "exit preview" came to leave the server holding a decrypted ledger: the button navigated
   * away while the session stayed open. Naming the method explicitly is the fix.
   */
  async send(method: 'DELETE', path: string): Promise<void> {
    const generation = this.generation;
    if (!this.session || Date.parse(this.session.accessExpiresAt) < Date.now() + 30_000) await this.refresh();
    this.current(generation);
    const response = await fetch(`${this.baseUrl}/api/admin${path}`, {
      method, cache: 'no-store', redirect: 'error', signal: this.controller.signal,
      headers: { Authorization: `Bearer ${this.session?.accessToken ?? ''}` },
    });
    this.current(generation);
    if (!response.ok) {
      const body = await response.json().catch(() => ({})) as { code?: string; error?: string };
      throw new AdminError(response.status, body.code ?? '', body.error ?? `请求失败（HTTP ${response.status}）`);
    }
  }

  async logout(): Promise<void> {
    const token = this.session?.accessToken;
    this.clear();
    this.channel?.postMessage('session-changed');
    // Local data is cleared immediately even if revocation fails while offline.
    await timedRequest(`${this.baseUrl}/api/auth/logout`, {
      method: 'POST', credentials: 'same-origin', redirect: 'error', cache: 'no-store',
      headers: { 'X-Zichan-Session': 'admin-cookie', Authorization: `Bearer ${token ?? ''}` },
    }, async (res) => {
      if (!res.ok && res.status !== 401) throw new Error('本页已退出，但服务器会话撤销未确认；请联网后重试退出。');
    });
  }
}
