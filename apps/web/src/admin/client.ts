import { fetchAuthMe, loginAccount, refreshAccountSession, registerAccount, type SyncAuthMe, type SyncAuthSession } from '@zichan/db';

export interface AdminHealth {
  serverId: string;
  serverPublicKey: string;
  claimed: boolean;
  capabilities: string[];
}

export class AdminError extends Error {
  constructor(readonly status: number, readonly code: string, message: string) { super(message); }
}

async function readAdminJson<T>(res: Response): Promise<T> {
  try { return await res.json() as T; }
  catch {
    throw new AdminError(res.status, 'INVALID_API_RESPONSE', '管理 API 未返回有效 JSON，可能连接到了前端页面或开发代理未启动。请运行 npm run start:all 后重试，或使用服务器的 /admin/ 地址（默认 http://127.0.0.1:8787/admin/）。');
  }
}

export function adminBaseUrl(location: Pick<Location, 'origin' | 'pathname'>): string | undefined {
  const match = /^(.*)\/admin(?:\/.*)?$/.exec(location.pathname);
  return match ? `${location.origin}${match[1]}` : undefined;
}

/** Management sessions never enter ledger stores, localStorage or sessionStorage. */
export class AdminClient {
  private session?: SyncAuthSession;
  private identity?: AdminHealth;
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
    this.refreshing = undefined;
  }

  dispose(): void { this.clear(); this.channel?.close(); }

  private current(generation: number): void {
    if (generation !== this.generation) throw new DOMException('旧管理请求已取消', 'AbortError');
  }

  async health(): Promise<AdminHealth> {
    const generation = this.generation;
    const res = await fetch(`${this.baseUrl}/api/health`, { cache: 'no-store', redirect: 'error', signal: this.controller.signal });
    if (!res.ok) throw new AdminError(res.status, '', `无法连接管理 API（HTTP ${res.status}）。请确认服务器已启动；开发模式使用 npm run start:all，启动后刷新页面重试。`);
    const body = await readAdminJson<AdminHealth>(res);
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
      await registerAccount(this.baseUrl, username, password, { initializeOwner: true, expectedServerId: health.serverId, expectedServerPublicKey: health.serverPublicKey });
      this.current(generation);
      onInitialized?.();
    }
    const session = await loginAccount(this.baseUrl, username, password, { sessionTransport: 'cookie', sessionContext: 'admin', deviceName: 'Zichan · 服务器管理后台', expectedServerId: health.serverId, expectedServerPublicKey: health.serverPublicKey });
    this.current(generation);
    this.session = session;
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
        const session = await refreshAccountSession(this.baseUrl, '', 'cookie', 'admin');
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

  async me(): Promise<SyncAuthMe> {
    const generation = this.generation;
    const result = await fetchAuthMe(this.baseUrl, this.session?.accessToken ?? '');
    this.current(generation);
    return result;
  }

  async request<T>(path: string, body?: unknown): Promise<T> {
    const generation = this.generation;
    try {
      if (!this.session || Date.parse(this.session.accessExpiresAt) < Date.now() + 30_000) await this.refresh();
      this.current(generation);
      const res = await fetch(`${this.baseUrl}/api/admin${path}`, {
        method: body === undefined ? 'GET' : 'POST', cache: 'no-store', redirect: 'error', signal: this.controller.signal,
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${this.session!.accessToken}` },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
      const result = await readAdminJson<{ code?: string; error?: string }>(res);
      this.current(generation);
      if (!res.ok) throw new AdminError(res.status, result.code ?? '', result.error ?? `HTTP ${res.status}`);
      return result as T;
    } catch (error) {
      this.current(generation);
      if (error instanceof AdminError && (error.status === 401 || error.code === 'ADMIN_REQUIRED')
        || error instanceof Error && /HTTP 401/.test(error.message)) {
        this.clear(); this.onLost('管理会话已失效，请重新登录；现有账本数据不受影响。');
      }
      throw error;
    }
  }

  async logout(): Promise<void> {
    const token = this.session?.accessToken;
    this.clear();
    this.channel?.postMessage('session-changed');
    // Local data is cleared immediately even if revocation fails while offline.
    const res = await fetch(`${this.baseUrl}/api/auth/logout`, {
      method: 'POST', credentials: 'same-origin', redirect: 'error', cache: 'no-store',
      headers: { 'X-Zichan-Session': 'admin-cookie', Authorization: `Bearer ${token ?? ''}` },
    });
    if (!res.ok && res.status !== 401) throw new Error('本页已退出，但服务器会话撤销未确认；请联网后重试退出。');
  }
}
