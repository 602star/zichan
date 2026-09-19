/**
 * Management API.
 *
 * Every route here is administrative: the role checks in `handle` gate the whole
 * surface, target-scoped authorization stays on the server, and no route can read
 * plaintext ledger data or call something that must stop this process first.
 */
import { createHash } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { EncryptedBlobStore } from './blob-store.js';
import { ADMIN_BODY_BYTES, pathParts, readBody, send, sendText } from './http-util.js';
import { isJobType, jobOutcome, jobParamsFor, type JobRunner } from './jobs.js';
import { importMaintenanceRecords } from './maintenance-records.js';
import { redactForExport, redactText } from './log-redaction.js';
import type { MetricsService } from './metrics.js';
import { SETTING_FIELDS, type SettingsFacade } from './settings.js';
import {
  ServerStoreError,
  type AccountRole,
  type AdminAlert,
  type AdminJob,
  type AdminJobType,
  type JsonRecord,
  type RegistrationMode,
  type ServerLog,
  type SyncServerStore,
} from './store.js';
import type { MfaService } from './mfa.js';

/** Task types that only the server owner may create, re-run or cancel. */
const JOB_OWNER_ONLY: AdminJobType[] = ['backup.verify', 'restore.drill'];

export interface AdminRouterDeps {
  store: SyncServerStore;
  blobStore: EncryptedBlobStore;
  settings: SettingsFacade;
  metrics: MetricsService;
  mfa: MfaService;
  jobs: JobRunner;
  log: (level: ServerLog['level'], action: string, message: string, meta?: Omit<ServerLog, 'id' | 'at' | 'level' | 'action' | 'message'>) => Promise<void>;
  dataDir: string;
  databaseFile: string;
  serverId: string;
  version: string;
  enableSync: boolean;
  enableWeb: boolean;
  basePath: string;
  defaultProtection: string;
  custodyEnabled: boolean;
  allowInsecureHttp: boolean;
  accessTokenMinutes: number;
  sessionDays: number;
}

interface AdminAuth {
  user: { username: string; accountId: string; disabled: boolean };
  session: { id: string; createdAt: string; expiresAt: string; kind: string };
  role: AccountRole;
}

const AUDIT_ACTIONS = [
  'role', 'state', 'commit-quota', 'blob-quota', 'registration', 'revoke-session',
  'invite-create', 'invite-state', 'password-reset-issue', 'password-reset-revoke', 'password-reset-complete',
  'password-change-authorize', 'owner-recovery-local', 'settings-save', 'settings-update', 'sessions-revoke-all',
  'alert-acknowledge', 'alert-silence', 'alert-unsilence',
  'mfa-enroll', 'mfa-disable', 'mfa-recovery-codes',
];

const SYNC_EVENT_CATEGORIES = ['session-invalid', 'quota-exceeded', 'protocol-incompatible', 'ledger-mismatch', 'server-storage-error', 'other'];

function bytes(value: number): string {
  const units = ['B', 'KiB', 'MiB', 'GiB', 'TiB'];
  let amount = Math.abs(value);
  let unit = 0;
  while (amount >= 1024 && unit < units.length - 1) { amount /= 1024; unit += 1; }
  return `${Number(amount.toFixed(unit === 0 ? 0 : 1))} ${units[unit]}`;
}

function dateOnly(value: string): string {
  return value.replace('T', ' ').slice(0, 19);
}

function optionalIso(value: string | null, name: string): string | undefined {
  if (value === null || value === '') return undefined;
  if (!Number.isFinite(Date.parse(value))) throw new ServerStoreError('INVALID_RANGE', 400, `${name} 不是有效时间`);
  return value;
}

/** Human-readable sentence first; raw fields stay available in the detail view. */
export function describeAudit(
  entry: { action: string; before: unknown; after: unknown; reason?: string | null },
  actor: string,
  target: string,
): string {
  const before = (entry.before ?? {}) as JsonRecord;
  const after = (entry.after ?? {}) as JsonRecord;
  const roleName = (role: unknown) => role === 'owner' ? '所有者' : role === 'admin' ? '管理员' : role === 'viewer' ? '只读运维' : '普通用户';
  const reason = typeof entry.reason === 'string' && entry.reason.trim() ? ` 原因：${entry.reason.trim()}。` : '';
  const prefix = target && target !== actor ? `管理员 ${actor} 将用户 ${target}` : `管理员 ${actor}`;
  switch (entry.action) {
    case 'role':
      return `${prefix} 的角色从 ${roleName(before['role'])} 调整为 ${roleName(after['role'])}，并撤销了该账号的现有会话。${reason}`;
    case 'state':
      return `${prefix}的账号状态改为${after['disabled'] ? '已禁用（同时撤销全部会话）' : '正常'}。${reason}`;
    case 'commit-quota':
      return `${prefix}的提交配额调整为 ${after['bytes'] === null ? '服务器默认值' : bytes(Number(after['bytes']))}。${reason}`;
    case 'blob-quota':
      return `${prefix}的附件配额调整为 ${after['bytes'] === null ? '服务器默认值' : bytes(Number(after['bytes']))}。${reason}`;
    case 'revoke-session':
      return `${prefix}的一个设备会话被撤销。${reason}`;
    case 'sessions-revoke-all':
      return `${prefix}的全部可管理会话被撤销（${String(after['revoked'] ?? 0)} 个）。${reason}`;
    case 'registration':
      return `管理员 ${actor} 将注册策略从 ${String(before['value'] ?? before['mode'] ?? '未知')} 改为 ${String(after['mode'])}。${reason}`;
    case 'invite-create':
      return `管理员 ${actor} 创建了一个单次邀请码（有效期至 ${after['expiresAt'] ? dateOnly(String(after['expiresAt'])) : '未设置'}）。${reason}`;
    case 'invite-state':
      return `管理员 ${actor} 将一个邀请码${after['disabled'] ? '撤销' : '重新启用'}。${reason}`;
    case 'password-reset-issue':
      return `${prefix}发放了一次性密码重置码（有效期至 ${after['expiresAt'] ? dateOnly(String(after['expiresAt'])) : '未记录'}）。${reason}`;
    case 'password-reset-revoke':
      return `${prefix}撤销了未使用的密码重置码。${reason}`;
    case 'password-reset-complete':
      return `${target || actor} 完成了账号密码重置，旧会话已撤销。${reason}`;
    case 'password-change-authorize':
      return `${actor} 授权了本人账号的密码变更。${reason}`;
    case 'owner-recovery-local':
      return `部署侧为本机所有者发放了恢复凭据。${reason}`;
    case 'settings-save':
    case 'settings-update':
      return `管理员 ${actor} 修改了系统设置：${Object.keys(after).join('、') || '无变化'}。${reason}`;
    case 'alert-acknowledge':
      return `管理员 ${actor} 确认了告警 ${String(after['key'] ?? '')}。${reason}`;
    case 'alert-silence':
      return `管理员 ${actor} 将告警 ${String(after['key'] ?? '')} 静默 ${String(after['hours'] ?? '')} 小时（至 ${after['silencedUntil'] ? dateOnly(String(after['silencedUntil'])) : '未记录'}），期间不发送外部通知。${reason}`;
    case 'alert-unsilence':
      return `管理员 ${actor} 取消了对告警 ${String(after['key'] ?? '')} 的静默。${reason}`;
    default:
      return `管理员 ${actor} 执行了 ${entry.action}。${reason}`;
  }
}

export function createAdminRouter(deps: AdminRouterDeps) {
  const { store, blobStore, settings, metrics, jobs, log } = deps;

  const accountLabel = async (accountId: string | null | undefined, cache: Map<string, string>): Promise<string> => {
    if (!accountId) return '';
    const cached = cache.get(accountId);
    if (cached) return cached;
    const user = await store.userByAccountId(accountId);
    const label = user ? user.username : accountId;
    cache.set(accountId, label);
    return label;
  };

  const handleRoute = async (req: IncomingMessage, res: ServerResponse, apiPath: string, auth: AdminAuth, requestId: string): Promise<void> => {
    let suffix = apiPath.slice('/api/admin'.length) || '/';
    let parts = pathParts(suffix);
    const search = new URL(req.url ?? '/', 'http://localhost').searchParams;

    /**
     * Write routes accept an optional idempotency key so a timeout cannot duplicate work.
     *
     * The key is claimed *before* the work runs and keeps the requesting operator: two
     * concurrent requests with the same key can no longer both execute it, and a request that
     * arrives while the first one is still running is told to verify the outcome instead of
     * silently repeating the work.
     */
    const withIdempotency = async (
      req: IncomingMessage,
      res: ServerResponse,
      action: string,
      payload: unknown,
      run: () => Promise<{ status: number; body: JsonRecord }>,
    ): Promise<void> => {
      const rawKey = req.headers['idempotency-key'];
      const key = Array.isArray(rawKey) ? rawKey[0] : rawKey;
      if (!key) {
        const result = await run();
        send(res, result.status, result.body);
        return;
      }
      if (!/^[A-Za-z0-9._:-]{8,128}$/.test(key)) {
        send(res, 400, { code: 'INVALID_IDEMPOTENCY_KEY', error: '幂等键格式无效' });
        return;
      }
      const fingerprint = createHash('sha256').update(`${action}:${JSON.stringify(payload ?? {})}`).digest('hex');
      const claim = await store.claimIdempotency(key, fingerprint, auth.user.accountId);
      if (claim.state === 'mismatch') {
        send(res, 409, { code: 'IDEMPOTENCY_KEY_REUSED', error: '该幂等键曾用于不同的请求参数，已拒绝' });
        return;
      }
      if (claim.state === 'actor-mismatch') {
        send(res, 409, { code: 'IDEMPOTENCY_ACTOR_MISMATCH', error: '该幂等键已由另一个管理账号占用；请为本账号生成新的幂等键' });
        return;
      }
      if (claim.state === 'in-progress') {
        send(res, 409, { code: 'IDEMPOTENCY_IN_PROGRESS', error: '同一幂等键的请求仍在处理中；请刷新核实结果，不要重复提交' });
        return;
      }
      if (claim.state === 'replay') {
        send(res, claim.status, { ...claim.body, replayed: true });
        return;
      }
      try {
        const result = await run();
        await store.completeIdempotency(key, result.status, result.body);
        send(res, result.status, result.body);
      } catch (error) {
        // Work that produced no result must not block a later attempt with the same key.
        await store.releaseIdempotency(key).catch(() => undefined);
        throw error;
      }
    };

    /**
     * Enrolling or removing a second factor is a security change: it needs a fresh login, the
     * same window as role changes and session revocation.
     */
    const assertRecentLogin = async (): Promise<void> => {
      if (Date.now() - Date.parse(auth.session.createdAt) > 5 * 60_000) {
        throw new ServerStoreError('RECENT_LOGIN_REQUIRED', 403, '此敏感操作需要最近 5 分钟内的登录，请退出管理后台并重新登录');
      }
    };

    const assertManageTarget = async (username: string, quota = false) => {
      const target = await store.getUser(username);
      if (!target) throw new ServerStoreError('NOT_FOUND', 404, 'account not found');
      const role = await store.roleForUser(target.username);
      if ((!quota && role === 'owner') || auth.role !== 'owner' && role !== 'member') throw new ServerStoreError('PROTECTED_ACCOUNT', 403, 'cannot manage this privileged account');
      return target;
    };

    /**
     * Creating, re-running and cancelling a task share one rule, evaluated against the
     * *current* operator: re-running an old task must not bypass an owner-only type or the
     * protection around a privileged target account.
     */
    const assertJobAuthorized = async (type: AdminJobType, accountId?: string) => {
      // A read-only operator can watch tasks but not change the server through one.
      if (auth.role === 'viewer') throw new ServerStoreError('READ_ONLY_ROLE', 403, '只读运维角色不能创建、重试或取消任务');
      if (JOB_OWNER_ONLY.includes(type) && auth.role !== 'owner') {
        throw new ServerStoreError('OWNER_REQUIRED', 403, '该任务需要所有者权限');
      }
      if (!accountId) return undefined;
      const target = await store.userByAccountId(accountId);
      if (!target) throw new ServerStoreError('NOT_FOUND', 404, 'account not found');
      if (auth.role !== 'owner' && await store.roleForUser(target.username) !== 'member') {
        throw new ServerStoreError('PROTECTED_ACCOUNT', 403, 'cannot manage this privileged account');
      }
      return target;
    };

    /** The console shows "finished" and "found problems" separately. */
    const withOutcome = (job: AdminJob) => ({ ...job, outcome: jobOutcome(job) });

    // New management URLs use immutable IDs. Legacy URLs below keep the same guards.
    if (parts[0] === 'accounts' && parts.length === 3) {
      const target = await store.userByAccountId(parts[1]!);
      if (!target) return send(res, 404, { error: 'account not found' });
      if (req.method === 'POST' && parts[2] === 'password-reset') {
        const body = await readBody(req, ADMIN_BODY_BYTES);
        const reason = typeof body.reason === 'string' ? body.reason.trim().slice(0, 200) : '';
        const code = (await import('node:crypto')).randomBytes(32).toString('base64url');
        const expiresAt = new Date(Date.now() + 15 * 60_000).toISOString();
        await store.mutateAdmin(auth.session.id, { action: 'password-reset-issue', accountId: target.accountId, codeHash: createHash('sha256').update(code).digest('hex'), expiresAt }, { reason, requestId });
        res.setHeader('Cache-Control', 'no-store');
        return send(res, 200, { code, expiresAt, username: target.username });
      }

      if (req.method === 'POST' && parts[2] === 'role') {
        const body = await readBody(req, ADMIN_BODY_BYTES);
        if (body.role !== 'admin' && body.role !== 'member' && body.role !== 'viewer') return send(res, 400, { error: 'invalid role' });
        return void await withIdempotency(req, res, `role:${target.accountId}`, body, async () => {
          await store.mutateAdmin(auth.session.id, { action: 'role', accountId: target.accountId, role: body.role as 'admin' | 'viewer' | 'member' }, { reason: typeof body.reason === 'string' ? body.reason.slice(0, 200) : undefined, requestId, expectedVersion: Number.isSafeInteger(body.expectedVersion) ? Number(body.expectedVersion) : undefined });
          return { status: 200, body: { ok: true } };
        });
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

    if (req.method === 'POST' && parts[0] === 'accounts' && parts[2] === 'password-reset' && parts[3] === 'revoke') {
      const target = await store.userByAccountId(parts[1]!);
      if (!target) return send(res, 404, { error: 'account not found' });
      const body = await readBody(req, ADMIN_BODY_BYTES);
      const reason = typeof body.reason === 'string' ? body.reason.trim().slice(0, 200) : '';
      const { revoked } = await store.mutateAdmin(auth.session.id, { action: 'password-reset-revoke', accountId: target.accountId }, { reason, requestId });
      await log('info', 'password_reset_revoked', 'Revoked an unused password reset code', { username: target.username, detail: { changedBy: auth.user.username } });
      return send(res, 200, { ok: true, revoked });
    }

    if (req.method === 'GET' && suffix === '/overview') {
      const snapshot = await metrics.current();
      const jobs_ = await store.listJobs({ limit: 5 });
      const pending = await store.listAdminFailures(5);
      return send(res, 200, {
        serverId: deps.serverId,
        version: deps.version,
        snapshot,
        alerts: snapshot.alerts.items,
        recentJobs: jobs_.jobs,
        recentFailures: pending,
        capabilities: { sessionsPagination: true, jobs: true, metrics: true, syncDiagnostics: true, alerts: true, resources: true, databaseStats: true },
      });
    }

    /**
     * Resource and database diagnostics.
     *
     * `tables=1` adds the per-table page breakdown, which is the one expensive read here
     * (`dbstat` walks the whole file, ~250 ms on a 125 MiB database). It is opt-in so the
     * page can poll cheaply and ask for the breakdown only when someone wants it.
     */
    if (req.method === 'GET' && suffix === '/resources') {
      const snapshot = await metrics.current();
      const wantTables = search.get('tables') === '1';
      const tables = wantTables ? await store.databaseTableUsage() : null;
      // A fresh reading on demand: an operator opening the page should not see a 30-second-old
      // number and wonder whether it is current.
      const reading = wantTables ? undefined : metrics.runtime.sample();
      const identity = metrics.runtime.identity();
      return send(res, 200, {
        serverId: deps.serverId,
        version: deps.version,
        uptimeSeconds: snapshot.uptimeSeconds,
        sampledAt: snapshot.sampledAt,
        stale: snapshot.stale,
        process: reading
          ? {
            ...snapshot.process,
            rssBytes: reading.rssBytes,
            heapTotalBytes: reading.heapTotalBytes,
            heapUsedBytes: reading.heapUsedBytes,
            externalBytes: reading.externalBytes,
            arrayBuffersBytes: reading.arrayBuffersBytes,
            cpuPercent: reading.cpuPercent,
            eventLoopMeanMs: reading.eventLoopMeanMs,
            eventLoopMaxMs: reading.eventLoopMaxMs,
            eventLoopP99Ms: reading.eventLoopP99Ms,
            available: true,
          }
          : snapshot.process,
        database: snapshot.database,
        storage: {
          databaseBytes: snapshot.storage.databaseBytes,
          walBytes: snapshot.storage.walBytes,
          shmBytes: snapshot.storage.shmBytes,
          diskTotalBytes: snapshot.storage.diskTotalBytes,
          diskFreeBytes: snapshot.storage.diskFreeBytes,
        },
        tables,
        identity,
        thresholds: {
          memoryWarnBytes: Number(settings.settings.effective('memoryWarnBytes')) * 1024 * 1024,
          eventLoopLagWarnMs: Number(settings.settings.effective('eventLoopLagWarnMs')),
          cpuWarnPercent: Number(settings.settings.effective('cpuWarnPercent')),
        },
        // Stated on the page rather than left to the reader: this process is the server, and
        // in the desktop build the shell around it is not counted here.
        note: '这里只统计同步服务器进程本身；桌面外壳、浏览器渲染进程与 SQLite 页缓存之外的系统占用不在此列。',
      });
    }

    if (req.method === 'GET' && suffix === '/database/stats') {
      const snapshot = await metrics.current();
      return send(res, 200, {
        database: snapshot.database,
        storage: {
          databaseBytes: snapshot.storage.databaseBytes,
          walBytes: snapshot.storage.walBytes,
          shmBytes: snapshot.storage.shmBytes,
        },
        verification: snapshot.verification.database ?? null,
        analyze: await store.maintenanceState('verification:analyze') ?? null,
        note: '结构读数全部来自常量时间的 PRAGMA；表级占用需要单独扫描整库，见「表与索引占用」。',
      });
    }

    if (req.method === 'POST' && suffix === '/database/analyze') {
      // Same authorization path as every other task type, so the read-only rule cannot drift.
      await assertJobAuthorized('database.analyze');
      return void await withIdempotency(req, res, 'database.analyze', {}, async () => {
        const job = await store.createJob({ type: 'database.analyze', params: {}, createdBy: auth.user.username });
        jobs.kick();
        return { status: 202, body: { job: withOutcome(job) } };
      });
    }

    if (req.method === 'GET' && suffix === '/metrics') {
      const range = search.get('range') ?? '24h';
      if (!['1h', '24h', '7d'].includes(range)) return send(res, 400, { error: 'range must be 1h, 24h or 7d' });
      const spanMs = range === '1h' ? 3_600_000 : range === '24h' ? 86_400_000 : 7 * 86_400_000;
      const granularity = range === '1h' ? 'minute' : range === '7d' ? 'hour' : 'hour';
      const until = new Date();
      const from = new Date(until.getTime() - spanMs);
      const buckets = granularity === 'minute'
        ? await store.listMetricBuckets('minute', from.toISOString(), until.toISOString())
        : await store.listMetricBuckets('hour', from.toISOString(), until.toISOString());
      const totals = buckets.reduce((accumulator, bucket) => ({
        requests: accumulator.requests + bucket.requests,
        errors: accumulator.errors + bucket.errors,
        slowRequests: accumulator.slowRequests + bucket.slowRequests,
        durationMs: accumulator.durationMs + bucket.durationMs,
        syncPushOk: accumulator.syncPushOk + bucket.syncPushOk,
        syncPushFailed: accumulator.syncPushFailed + bucket.syncPushFailed,
        syncPullOk: accumulator.syncPullOk + bucket.syncPullOk,
        blobOk: accumulator.blobOk + bucket.blobOk,
        blobFailed: accumulator.blobFailed + bucket.blobFailed,
      }), { requests: 0, errors: 0, slowRequests: 0, durationMs: 0, syncPushOk: 0, syncPushFailed: 0, syncPullOk: 0, blobOk: 0, blobFailed: 0 });
      // Resource readings are peaks, not counters: the range summary reports the maximum seen
      // and the last bucket's level, never a sum that would be meaningless.
      const resourcePeak = buckets.reduce((accumulator, bucket) => ({
        rssBytes: Math.max(accumulator.rssBytes, bucket.rssBytes),
        heapUsedBytes: Math.max(accumulator.heapUsedBytes, bucket.heapUsedBytes),
        externalBytes: Math.max(accumulator.externalBytes, bucket.externalBytes),
        cpuPercent: Math.max(accumulator.cpuPercent, bucket.cpuPercent),
        eventLoopMaxMs: Math.max(accumulator.eventLoopMaxMs, bucket.eventLoopMaxMs),
      }), { rssBytes: 0, heapUsedBytes: 0, externalBytes: 0, cpuPercent: 0, eventLoopMaxMs: 0 });
      return send(res, 200, {
        range,
        granularity,
        from: from.toISOString(),
        until: until.toISOString(),
        buckets,
        totals: {
          ...totals,
          errorRate: totals.requests ? Number((totals.errors / totals.requests).toFixed(4)) : null,
          averageMs: totals.requests ? Math.round(totals.durationMs / totals.requests) : null,
        },
        resourcePeak,
        observedSince: buckets[0]?.bucketAt ?? null,
        note: '指标从本次上线开始积累；尚未采集的时间范围内没有数据，不等同于零。资源读数为该分桶内的峰值，不是累加值。',
      });
    }

    if (req.method === 'GET' && parts[0] === 'accounts' && parts.length === 2) {
      const detail = await store.accountDetail(parts[1]!);
      if (!detail) return send(res, 404, { error: 'account not found' });
      const username = String((detail['account'] as JsonRecord)['username']);
      const usage = await blobStore.usage(username);
      return send(res, 200, {
        ...detail,
        capacity: {
          ...(detail['capacity'] as JsonRecord),
          blobUsedBytes: usage.usedBytes,
          blobQuotaBytes: usage.quotaBytes,
          blobObjectCount: usage.objectCount,
          blobTrashBytes: usage.trashBytes,
          blobStagingBytes: usage.stagingBytes,
          quotaNote: '提交、有效附件、回收站与暂存上传都计入各自配额；降低上限不会删除已有数据，只限制后续上传。',
        },
      });
    }

    if (req.method === 'GET' && suffix === '/sessions') {
      const limit = Number(search.get('limit') ?? 25);
      if (!Number.isSafeInteger(limit) || limit < 1 || limit > 200) return send(res, 400, { error: 'limit must be between 1 and 200' });
      const state = search.get('state') ?? '';
      const kind = search.get('kind') ?? '';
      const searchTerm = search.get('search') ?? '';
      if (!['', 'active', 'revoked', 'expired'].includes(state) || !['', 'ledger', 'admin'].includes(kind)) return send(res, 400, { error: 'invalid session filter' });
      if (searchTerm.length > 128) return send(res, 400, { error: 'search must not exceed 128 characters' });
      const page = await store.listSessionsPage({
        limit,
        ...(search.get('cursor') ? { cursor: search.get('cursor')! } : {}),
        ...(searchTerm ? { search: searchTerm } : {}),
        ...(state ? { state } : {}),
        ...(kind ? { kind } : {}),
        memberOnly: auth.role !== 'owner',
      });
      return send(res, 200, {
        ...page,
        paginationUnit: 'session',
        note: '设备名与客户端信息由客户端上报；不通过 IP 推断地理位置。',
      });
    }

    if (req.method === 'POST' && parts[0] === 'accounts' && parts[2] === 'sessions' && parts[3] === 'revoke') {
      const target = await store.userByAccountId(parts[1]!);
      if (!target) return send(res, 404, { error: 'account not found' });
      const body = await readBody(req, ADMIN_BODY_BYTES);
      // Revoking the actor's own sessions keeps the current one: it ends through logout, so the
      // operator never lands in an unclear state halfway through the request.
      const isSelf = target.accountId === auth.user.accountId;
      const { revokedSessions } = await store.mutateAdmin(
        auth.session.id,
        { action: 'sessions-revoke-all', accountId: target.accountId, ...(isSelf ? { keepSessionId: auth.session.id } : {}) },
        { requestId },
      );
      await log('info', 'sessions_revoked', 'Revoked every manageable session of an account', {
        username: target.username,
        detail: { revoked: revokedSessions, changedBy: auth.user.username, note: typeof body.note === 'string' ? body.note.slice(0, 200) : undefined },
      });
      return send(res, 200, { ok: true, revoked: revokedSessions });
    }

    if (req.method === 'GET' && suffix === '/sync-events') {
      const limit = Number(search.get('limit') ?? 50);
      if (!Number.isSafeInteger(limit) || limit < 1 || limit > 200) return send(res, 400, { error: 'limit must be between 1 and 200' });
      const category = search.get('category') ?? '';
      const outcome = search.get('outcome') ?? '';
      if (category && !SYNC_EVENT_CATEGORIES.includes(category)) return send(res, 400, { error: 'invalid category' });
      if (outcome && !['ok', 'error'].includes(outcome)) return send(res, 400, { error: 'invalid outcome' });
      const from = optionalIso(search.get('from'), 'from');
      const until = optionalIso(search.get('until'), 'until');
      const accountId = search.get('accountId') ?? undefined;
      const page = await store.listSyncEvents({
        limit,
        ...(search.get('cursor') ? { cursor: search.get('cursor')! } : {}),
        ...(accountId ? { accountId } : {}),
        ...(search.get('username') ? { username: search.get('username')! } : {}),
        ...(category ? { category } : {}),
        ...(outcome ? { outcome } : {}),
        ...(from ? { from } : {}),
        ...(until ? { until } : {}),
      });
      return send(res, 200, {
        ...page,
        coverage: '仅覆盖服务端可见的同步结果；客户端离线期间的失败需要客户端诊断上报后才会出现。长时间没有同步不代表故障。',
      });
    }

    if (req.method === 'GET' && suffix === '/jobs') {
      const limit = Number(search.get('limit') ?? 25);
      if (!Number.isSafeInteger(limit) || limit < 1 || limit > 200) return send(res, 400, { error: 'limit must be between 1 and 200' });
      const status = search.get('status') ?? '';
      if (status && !['queued', 'running', 'succeeded', 'failed', 'cancelled', 'interrupted'].includes(status)) return send(res, 400, { error: 'invalid status' });
      const page = await store.listJobs({
        limit,
        ...(status ? { status } : {}),
        ...(search.get('type') ? { type: search.get('type')! } : {}),
        ...(search.get('accountId') ? { accountId: search.get('accountId')! } : {}),
        ...(search.get('cursor') ? { cursor: search.get('cursor')! } : {}),
      });
      return send(res, 200, { ...page, jobs: page.jobs.map(withOutcome) });
    }

    if (req.method === 'POST' && suffix === '/jobs') {
      const body = await readBody(req, ADMIN_BODY_BYTES);
      const type = body.type;
      if (!isJobType(type)) return send(res, 400, { code: 'JOB_TYPE_INVALID', error: '不支持的任务类型' });
      const accountId = typeof body.accountId === 'string' ? body.accountId : undefined;
      // Validate the closed parameter set first so a malformed value is a client error,
      // not an account lookup miss.
      const params = jobParamsFor(type, body);
      await assertJobAuthorized(type, accountId);
      return void await withIdempotency(req, res, `jobs:${type}:${accountId ?? ''}`, body, async () => {
        const job = await store.createJob({
          type,
          params: { ...params, ...(accountId ? { accountId } : {}) },
          createdBy: auth.user.username,
          ...(accountId ? { targetAccountId: accountId } : {}),
        });
        await log('info', 'job_created', 'Maintenance job queued', { username: auth.user.username, detail: { jobId: job.jobId, type: job.type } });
        jobs.kick();
        return { status: 202, body: { job: withOutcome(job) } };
      });
    }

    if (parts[0] === 'jobs' && parts[1]) {
      const jobId = parts[1];
      if (req.method === 'GET' && parts.length === 2) {
        const job = await store.getJob(jobId);
        if (!job) return send(res, 404, { error: 'job not found' });
        return send(res, 200, { job: withOutcome(job), events: await store.listJobEvents(jobId, 50) });
      }
      if (req.method === 'POST' && parts[2] === 'cancel') {
        const job = await store.getJob(jobId);
        if (!job) return send(res, 404, { error: 'job not found' });
        await assertJobAuthorized(job.type, job.targetAccountId);
        const cancelled = await store.requestJobCancel(jobId);
        if (!cancelled) return send(res, 404, { error: 'job not found' });
        if (cancelled.status === 'queued') jobs.kick();
        await log('info', 'job_cancel_requested', 'Maintenance job cancellation requested', { username: auth.user.username, detail: { jobId } });
        return send(res, 200, { job: withOutcome(cancelled) });
      }
      if (req.method === 'POST' && parts[2] === 'retry') {
        const job = await store.getJob(jobId);
        if (!job) return send(res, 404, { error: 'job not found' });
        if (job.status === 'running' || job.status === 'queued') return send(res, 409, { code: 'JOB_ACTIVE', error: '任务仍在执行，不能重新执行' });
        // Re-authorize from the stored task, not from whoever created it back then.
        await assertJobAuthorized(job.type, job.targetAccountId);
        return void await withIdempotency(req, res, `job-retry:${jobId}`, {}, async () => {
          const created = await store.createJob({
            type: job.type,
            params: job.params,
            createdBy: auth.user.username,
            ...(job.targetAccountId ? { targetAccountId: job.targetAccountId } : {}),
            retryOf: jobId,
          });
          await store.appendJobEvent(created.jobId, 'info', `由 ${jobId} 重新执行`);
          jobs.kick();
          return { status: 202, body: { job: withOutcome(created) } };
        });
      }
      return send(res, 404, { error: 'not found' });
    }

    if (req.method === 'GET' && suffix === '/backups') {
      await importMaintenanceRecords(store, deps.dataDir);
      return send(res, 200, {
        backups: await store.listBackupRecords(50),
        note: '备份与恢复由部署侧维护程序在服务停止时执行，后台只登记与展示结果；不提供浏览器下载整套服务器备份。',
      });
    }

    /**
     * Failed authentication attempts, grouped by source address.
     *
     * This is its own view rather than a filter on the run log: the log is capped and shows
     * one line per attempt, so "is one address trying many accounts" cannot be read off it.
     * Readable by the read-only operator — it is diagnostic, not a change.
     */
    if (req.method === 'GET' && suffix === '/auth-failures') {
      const from = optionalIso(search.get('from'), 'from');
      const until = optionalIso(search.get('until'), 'until');
      const minFailures = Number(search.get('minFailures') ?? 1);
      if (!Number.isSafeInteger(minFailures) || minFailures < 1 || minFailures > 10_000) return send(res, 400, { error: 'minFailures must be between 1 and 10000' });
      const result = await store.failedLoginsBySource({
        ...(from ? { from } : {}),
        ...(until ? { until } : {}),
        minFailures,
        limit: 200,
      });
      // Whether an address is currently throttled comes from the limiter, not from the failure
      // count: the two answer different questions and guessing one from the other would be wrong.
      const limits = await store.listRateLimits({ limit: 1_000 });
      const blocked = new Set(limits.buckets.filter((bucket) => bucket.blockedUntil && bucket.source).map((bucket) => bucket.source));
      return send(res, 200, {
        ...result,
        sources: result.sources.map((source) => ({ ...source, throttled: blocked.has(source.source) })),
        note: '只统计服务端记录到的登录失败：账号被禁用、第二因子被拒，以及到达服务端的密码校验失败。来源 IP 取自连接或可信代理头，没有来源地址的记录不计入；客户端在本地就判定为密码错误、因而根本没有发出请求的尝试不会出现在这里。',
      });
    }

    /** Rate-limit buckets: what is being throttled right now, and what has been seen recently. */
    if (req.method === 'GET' && suffix === '/rate-limits') {
      const activeOnly = search.get('active') === '1';
      return send(res, 200, {
        ...await store.listRateLimits({ activeOnly }),
        note: '限流桶在每次受限请求时写入，超过上限的地址在窗口结束前被拒绝；这里只读展示，不提供手动解封。',
      });
    }

    if (req.method === 'GET' && suffix === '/alerts') {
      const state = search.get('state') ?? '';
      if (state && !['pending', 'active', 'resolved'].includes(state)) return send(res, 400, { error: 'invalid state' });
      return send(res, 200, { alerts: await store.listAlerts({ ...(state ? { state } : {}) }) });
    }

    if (req.method === 'POST' && parts[0] === 'alerts' && parts[2] === 'acknowledge') {
      const key = parts[1] ?? '';
      const body = await readBody(req, ADMIN_BODY_BYTES);
      const reason = typeof body.reason === 'string' ? body.reason.trim().slice(0, 200) : '';
      // Acknowledgement is a management act: it shares the audited transaction.
      await store.mutateAdmin(auth.session.id, { action: 'alert-acknowledge', key }, { reason, requestId });
      const alert = await store.getAlert(key);
      if (!alert) return send(res, 404, { error: 'alert not found' });
      await log('info', 'alert_acknowledged', 'Alert acknowledged', { username: auth.user.username, detail: { key } });
      return send(res, 200, { alert });
    }

    if (req.method === 'POST' && parts[0] === 'alerts' && parts[2] === 'silence') {
      const key = parts[1] ?? '';
      const body = await readBody(req, ADMIN_BODY_BYTES);
      const hours = body.hours === undefined ? 24 : Number(body.hours);
      if (!Number.isSafeInteger(hours) || hours < 1 || hours > 720) return send(res, 400, { code: 'INVALID_SILENCE', error: '静默时长必须是 1–720 小时' });
      const reason = typeof body.reason === 'string' ? body.reason.trim().slice(0, 200) : '';
      // Silence is a recorded decision with an end time, not a deleted alert:
      // the rule keeps evaluating and the history stays visible.
      await store.mutateAdmin(auth.session.id, { action: 'alert-silence', key, hours }, { reason, requestId });
      await log('info', 'alert_silenced', 'Alert silenced', { username: auth.user.username, detail: { key, hours } });
      const alert = await store.getAlert(key);
      if (!alert) return send(res, 404, { error: 'alert not found' });
      return send(res, 200, { alert });
    }

    if (req.method === 'POST' && parts[0] === 'alerts' && parts[2] === 'unsilence') {
      const key = parts[1] ?? '';
      const body = await readBody(req, ADMIN_BODY_BYTES);
      const reason = typeof body.reason === 'string' ? body.reason.trim().slice(0, 200) : '';
      await store.mutateAdmin(auth.session.id, { action: 'alert-unsilence', key }, { reason, requestId });
      await log('info', 'alert_unsilenced', 'Alert silence cleared', { username: auth.user.username, detail: { key } });
      const alert = await store.getAlert(key);
      if (!alert) return send(res, 404, { error: 'alert not found' });
      return send(res, 200, { alert });
    }

    if (req.method === 'GET' && suffix === '/mfa') {
      const status = await deps.mfa.status(auth.user.username);
      const missing = await deps.mfa.administratorsWithoutMfa();
      return send(res, 200, {
        ...status,
        // Visibility for the policy: an operator can see who would be locked out before
        // switching the requirement on.
        required: String(settings.settings.effective('requireAdminMfa')) === 'on',
        administratorsWithoutMfa: missing,
        note: '两步验证保护的是管理后台登录：同一账号在本机记账端的登录不受影响。本地维护程序（所有者恢复）不要求验证码，那是需要服务器物理/文件系统访问权限的应急路径。',
      });
    }

    if (req.method === 'POST' && parts[0] === 'mfa' && parts[1] === 'enroll') {
      await assertRecentLogin();
      const existing = await deps.mfa.status(auth.user.username);
      if (existing.enabled) {
        return send(res, 409, { code: 'MFA_ALREADY_ENABLED', error: '两步验证已启用；如需重新绑定请先关闭' });
      }
      const enrollment = await deps.mfa.beginEnrollment(auth.user.username, auth.user.username);
      await log('info', 'mfa_enroll_started', 'Second factor enrollment started', { username: auth.user.username });
      // The secret is returned once, to the account that is enrolling it.
      return send(res, 200, enrollment);
    }

    if (req.method === 'POST' && parts[0] === 'mfa' && parts[1] === 'confirm') {
      await assertRecentLogin();
      const body = await readBody(req, ADMIN_BODY_BYTES);
      const result = await deps.mfa.confirmEnrollment(auth.user.username, typeof body.code === 'string' ? body.code : '');
      if (!result.ok) {
        await log('warn', 'mfa_enroll_failed', 'Second factor confirmation failed', { username: auth.user.username, status: 400, detail: { reason: result.reason } });
        return send(res, 400, {
          code: result.reason === 'not-enrolled' ? 'MFA_NOT_ENROLLED' : 'MFA_CODE_INVALID',
          error: result.reason === 'not-enrolled' ? '请先开始绑定，再输入验证码' : '验证码不正确；请确认设备时间准确后重试',
        });
      }
      await store.mutateAdmin(auth.session.id, { action: 'mfa-enroll', accountId: auth.user.accountId }, { requestId: body.requestId as string | undefined });
      await log('info', 'mfa_enrolled', 'Second factor enabled for an administrator', { username: auth.user.username });
      // Recovery codes are shown exactly once, at the moment they are created.
      return send(res, 200, { ok: true, recoveryCodes: result.recoveryCodes });
    }

    if (req.method === 'POST' && parts[0] === 'mfa' && parts[1] === 'recovery-codes') {
      await assertRecentLogin();
      const body = await readBody(req, ADMIN_BODY_BYTES);
      const result = await deps.mfa.regenerateRecoveryCodes(auth.user.username, typeof body.code === 'string' ? body.code : '');
      if (!result.ok) {
        await log('warn', 'mfa_recovery_regenerate_failed', 'Recovery code regeneration refused', { username: auth.user.username, status: 400 });
        return send(res, 400, { code: 'MFA_CODE_INVALID', error: '需要当前的验证码或一个未使用的恢复码才能重新生成' });
      }
      await store.mutateAdmin(auth.session.id, { action: 'mfa-recovery-codes', accountId: auth.user.accountId }, { requestId: body.requestId as string | undefined });
      await log('info', 'mfa_recovery_regenerated', 'Recovery codes regenerated', { username: auth.user.username });
      return send(res, 200, { ok: true, recoveryCodes: result.recoveryCodes });
    }

    if (req.method === 'POST' && parts[0] === 'mfa' && parts[1] === 'disable') {
      await assertRecentLogin();
      const body = await readBody(req, ADMIN_BODY_BYTES);
      const policy = String(settings.settings.effective('requireAdminMfa')) === 'on';
      if (policy) {
        // With the policy on, disabling would immediately lock this administrator out; the
        // requirement has to be lifted first, which the owner can do from settings.
        return send(res, 409, { code: 'MFA_REQUIRED_BY_POLICY', error: '服务器要求管理员启用两步验证；请先由所有者关闭该要求' });
      }
      const result = await deps.mfa.disable(auth.user.username, typeof body.code === 'string' ? body.code : '');
      if (!result.ok) {
        await log('warn', 'mfa_disable_failed', 'Second factor disable refused', { username: auth.user.username, status: 400 });
        return send(res, 400, { code: 'MFA_CODE_INVALID', error: '关闭两步验证需要当前验证码或一个未使用的恢复码' });
      }
      await store.mutateAdmin(auth.session.id, { action: 'mfa-disable', accountId: auth.user.accountId }, { requestId: body.requestId as string | undefined });
      await log('info', 'mfa_disabled', 'Second factor disabled', { username: auth.user.username });
      return send(res, 200, { ok: true });
    }

    if (req.method === 'GET' && suffix === '/storage') {
      const composition = await blobStore.storageComposition();
      const diskFree = composition.diskFreeBytes;
      const diskTotal = composition.diskTotalBytes;
      return send(res, 200, {
        ...composition,
        cleanup: blobStore.cleanupStatus(),
        // Reported from the deployment record; the console never selects a backup path.
        backupDirectory: (await store.listBackupRecords(1))[0]?.outputPath ?? null,
        note: '逻辑配额占用与物理磁盘占用分开显示；备份目录不在 Web 静态服务范围内。',
        diskFreeRatio: diskFree !== null && diskTotal ? Number((diskFree / diskTotal).toFixed(4)) : null,
      });
    }

    if (req.method === 'GET' && suffix === '/settings') {
      const stored: Record<string, number | string> = {};
      for (const field of SETTING_FIELDS) {
        const raw = await store.maintenanceState(`setting:${field.name}`);
        if (raw && raw['value'] !== undefined) stored[field.name] = raw['value'] as number | string;
      }
      return send(res, 200, {
        settings: SETTING_FIELDS.map((field) => settings.settings.resolve(field)),
        stored,
        environment: {
          registrationMode: await store.registrationMode(),
          accountProtection: deps.defaultProtection,
          custodyEnabled: deps.custodyEnabled,
          syncEnabled: deps.enableSync,
          webEnabled: deps.enableWeb,
          basePath: deps.basePath,
          httpsRequired: !deps.allowInsecureHttp,
          dataDir: deps.dataDir,
          databaseFile: deps.databaseFile,
        },
        secrets: {
          syncSecret: 'configured',
          ownerSetupToken: 'configured',
          custodyKey: deps.custodyEnabled ? 'configured' : 'not-configured',
        },
        version: { server: deps.version, schema: (await store.status()).schemaVersion },
        security: { accessTokenMinutes: deps.accessTokenMinutes, sessionDays: deps.sessionDays },
      });
    }

    if (req.method === 'POST' && suffix === '/settings') {
      if (auth.role !== 'owner') return send(res, 403, { code: 'OWNER_REQUIRED', error: '仅服务器所有者可以修改系统设置' });
      const body = await readBody(req, ADMIN_BODY_BYTES);
      const updates = body.settings;
      if (typeof updates !== 'object' || updates === null || Array.isArray(updates)) return send(res, 400, { code: 'INVALID_SETTINGS', error: 'settings 必须是一个对象' });
      // Requiring a second factor is only safe if every administrator already has one: with the
      // policy on and a missing factor, that account can no longer sign in at all.
      if ((updates as JsonRecord)['requireAdminMfa'] === 'on') {
        const missing = await deps.mfa.administratorsWithoutMfa();
        if (missing.length) {
          return send(res, 409, {
            code: 'MFA_ENROLLMENT_INCOMPLETE',
            error: `启用前请先让这些管理员完成两步验证绑定：${missing.join('、')}`,
          });
        }
      }
      return void await withIdempotency(req, res, 'settings', updates, async () => {
        const saved = await settings.settings.save(updates as Record<string, unknown>);
        await store.mutateAdmin(auth.session.id, { action: 'settings-save', keys: Object.keys(updates as JsonRecord) }, { requestId });
        await log('info', 'settings_updated', 'Runtime settings updated', { username: auth.user.username, detail: { keys: Object.keys(updates as JsonRecord) } });
        return { status: 200, body: { settings: saved } };
      });
    }

    if (req.method === 'GET' && suffix === '/audit') {
      const before = Number(search.get('cursor') ?? Number.MAX_SAFE_INTEGER);
      if (!Number.isSafeInteger(before) || before < 1) return send(res, 400, { error: 'invalid cursor' });
      const term = search.get('search')?.trim() ?? '';
      if (term.length > 128) return send(res, 400, { error: 'search must not exceed 128 characters' });
      const action = search.get('action') ?? '';
      if (action && !AUDIT_ACTIONS.includes(action)) return send(res, 400, { error: 'invalid action' });
      const from = optionalIso(search.get('from'), 'from');
      const until = optionalIso(search.get('until'), 'until');
      const page = await store.listAdminAudit({
        before,
        limit: 50,
        ...(term ? { search: term } : {}),
        ...(action ? { action } : {}),
        ...(search.get('actor') ? { actorAccountId: search.get('actor')! } : {}),
        ...(search.get('target') ? { targetAccountId: search.get('target')! } : {}),
        ...(from ? { from } : {}),
        ...(until ? { until } : {}),
      });
      const cache = new Map<string, string>();
      const entries = await Promise.all(page.entries.map(async (entry) => {
        const actor = await accountLabel(entry['actorAccountId'] as string, cache);
        const target = await accountLabel(entry['targetAccountId'] as string | null, cache);
        return {
          ...entry,
          actorName: actor,
          targetName: target,
          summary: describeAudit({ action: String(entry['action']), before: entry['before'], after: entry['after'], reason: entry['reason'] as string | null }, actor, target),
        };
      }));
      return send(res, 200, { entries, actions: AUDIT_ACTIONS, ...(page.nextCursor ? { nextCursor: page.nextCursor } : {}) });
    }

    if (req.method === 'GET' && suffix === '/audit/export') {
      const format = search.get('format') ?? 'json';
      if (format !== 'json' && format !== 'csv') return send(res, 400, { error: 'format must be json or csv' });
      const action = search.get('action') ?? '';
      if (action && !AUDIT_ACTIONS.includes(action)) return send(res, 400, { error: 'invalid action' });
      const term = search.get('search')?.trim() ?? '';
      if (term.length > 128) return send(res, 400, { error: 'search must not exceed 128 characters' });
      const from = optionalIso(search.get('from'), 'from');
      const until = optionalIso(search.get('until'), 'until');
      const cache = new Map<string, string>();
      const collected: Record<string, unknown>[] = [];
      let cursor = Number.MAX_SAFE_INTEGER;
      for (let page = 0; page < 20 && collected.length < 5_000; page += 1) {
        const chunk = await store.listAdminAudit({
          before: cursor,
          limit: 200,
          ...(action ? { action } : {}),
          ...(term ? { search: term } : {}),
          ...(search.get('actor') ? { actorAccountId: search.get('actor')! } : {}),
          ...(search.get('target') ? { targetAccountId: search.get('target')! } : {}),
          ...(from ? { from } : {}),
          ...(until ? { until } : {}),
        });
        for (const entry of chunk.entries) {
          const actor = await accountLabel(entry['actorAccountId'] as string, cache);
          const target = await accountLabel(entry['targetAccountId'] as string | null, cache);
          collected.push({
            at: entry['at'], action: entry['action'], actorAccountId: entry['actorAccountId'],
            actorName: actor, targetAccountId: entry['targetAccountId'] ?? '', targetName: target,
            reason: entry['reason'] ?? '', requestId: entry['requestId'] ?? '',
            before: JSON.stringify(entry['before']), after: JSON.stringify(entry['after']),
            summary: describeAudit({ action: String(entry['action']), before: entry['before'], after: entry['after'], reason: entry['reason'] as string | null }, actor, target),
          });
        }
        if (!chunk.nextCursor) break;
        cursor = Number(chunk.nextCursor);
      }
      await log('info', 'audit_exported', 'Management audit exported', {
        username: auth.user.username,
        detail: { format, rows: collected.length, action: action || 'all' },
      });
      if (format === 'json') return sendText(res, 200, 'application/json; charset=utf-8', `${JSON.stringify({ exportedAt: new Date().toISOString(), rows: collected }, null, 2)}\n`, 'management-audit.json');
      const headers = ['at', 'action', 'actorAccountId', 'actorName', 'targetAccountId', 'targetName', 'reason', 'requestId', 'summary'];
      const escapeCsv = (value: unknown) => `"${String(value ?? '').replace(/"/g, '""')}"`;
      const csv = [headers.join(','), ...collected.map((row) => headers.map((header) => escapeCsv(row[header])).join(','))].join('\n');
      return sendText(res, 200, 'text/csv; charset=utf-8', `${csv}\n`, 'management-audit.csv');
    }

    if (req.method === 'GET' && suffix === '/audit/failures') {
      return send(res, 200, { failures: await store.listAdminFailures(50), note: '失败尝试单独记录，不与已回滚的事务审计混在一起。' });
    }

    if (req.method === 'GET' && suffix === '/database/verify') {
      const recorded = await store.maintenanceState('verification:database');
      return send(res, 200, {
        verification: recorded ?? { ok: null, result: 'not-run', note: '尚未执行深度校验，请在任务中心创建数据库完整性校验任务。' },
        mode: 'recorded',
      });
    }

    if (req.method === 'POST' && suffix === '/database/verify') {
      return void await withIdempotency(req, res, 'database.verify', {}, async () => {
        const job = await store.createJob({ type: 'database.integrity-check', params: {}, createdBy: auth.user.username });
        jobs.kick();
        return { status: 202, body: { job: withOutcome(job) } };
      });
    }

    if (req.method === 'GET' && suffix === '/quotas') {
      const limit = Number(search.get('limit') ?? 100);
      if (!Number.isSafeInteger(limit) || limit < 1 || limit > 500) return send(res, 400, { error: 'limit must be between 1 and 500' });
      const { users, nextCursor } = await store.listUsers(search.get('cursor') ?? '', limit);
      return send(res, 200, {
        users: await Promise.all(users.map(async (user) => ({
          username: user['username'],
          ...await blobStore.usage(String(user['username'])),
        }))),
        dataDir: deps.dataDir,
        nextCursor,
      });
    }

    if (req.method === 'POST' && suffix === '/quotas/blobs/verify') {
      const body = await readBody(req, ADMIN_BODY_BYTES).catch(() => ({}) as JsonRecord);
      const accountId = typeof body.accountId === 'string' ? body.accountId : undefined;
      await assertJobAuthorized('blobs.verify', accountId);
      return void await withIdempotency(req, res, `blobs.verify:${accountId ?? 'all'}`, body, async () => {
        const job = await store.createJob({
          type: 'blobs.verify',
          params: accountId ? { accountId } : {},
          createdBy: auth.user.username,
          ...(accountId ? { targetAccountId: accountId } : {}),
        });
        jobs.kick();
        return { status: 202, body: { job: withOutcome(job) } };
      });
    }

    if (req.method === 'POST' && parts[0] === 'quotas' && parts[2] === 'blobs') {
      const username = parts[1] ?? '';
      const target = await assertManageTarget(username, true);
      const body = await readBody(req, ADMIN_BODY_BYTES);
      if (body.quotaBytes !== null && (!Number.isSafeInteger(body.quotaBytes)
        || Number(body.quotaBytes) < 1024 * 1024 || Number(body.quotaBytes) > 1024 ** 4)) {
        return send(res, 400, { error: 'invalid quotaBytes' });
      }
      return void await withIdempotency(req, res, `blob-quota:${target.accountId}`, body, async () => {
        await store.mutateAdmin(
          auth.session.id,
          { action: 'blob-quota', accountId: target.accountId, bytes: body.quotaBytes === null ? null : Number(body.quotaBytes) },
          { reason: typeof body.reason === 'string' ? body.reason.slice(0, 200) : undefined, requestId, expectedVersion: Number.isSafeInteger(body.expectedVersion) ? Number(body.expectedVersion) : undefined },
        );
        const usage = await blobStore.usage(username);
        await log('info', 'blob_quota_changed', 'Attachment quota changed', {
          username,
          detail: { quotaBytes: usage.quotaBytes, changedBy: auth.user.username },
        });
        return { status: 200, body: { username, usage } };
      });
    }

    if (req.method === 'POST' && parts[0] === 'quotas' && parts[2] === 'commits') {
      const username = parts[1] ?? '';
      const target = await assertManageTarget(username, true);
      const body = await readBody(req, ADMIN_BODY_BYTES);
      if (body.commitQuotaBytes !== null && (!Number.isSafeInteger(body.commitQuotaBytes)
        || Number(body.commitQuotaBytes) < 1024 * 1024 || Number(body.commitQuotaBytes) > 1024 ** 4)) {
        return send(res, 400, { error: 'invalid commitQuotaBytes' });
      }
      return void await withIdempotency(req, res, `commit-quota:${target.accountId}`, body, async () => {
        await store.mutateAdmin(
          auth.session.id,
          { action: 'commit-quota', accountId: target.accountId, bytes: body.commitQuotaBytes === null ? null : Number(body.commitQuotaBytes) },
          { reason: typeof body.reason === 'string' ? body.reason.slice(0, 200) : undefined, requestId, expectedVersion: Number.isSafeInteger(body.expectedVersion) ? Number(body.expectedVersion) : undefined },
        );
        await log('info', 'commit_quota_changed', 'Encrypted commit quota changed', {
          username,
          detail: { commitQuotaBytes: body.commitQuotaBytes, changedBy: auth.user.username },
        });
        return { status: 200, body: { ok: true } };
      });
    }

    /**
     * Run log export.
     *
     * The audit could be exported and the run log could not, so handing a failure to someone
     * else meant a screenshot. This mirrors the audit export — same formats, same filters, same
     * cap — and adds the redaction the audit export relies on being unnecessary: log detail is
     * free-form, so secrets are removed by key name *and* by value shape rather than by trusting
     * every current log call site.
     */
    if (req.method === 'GET' && suffix === '/logs/export') {
      const format = search.get('format') ?? 'json';
      if (format !== 'json' && format !== 'csv') return send(res, 400, { error: 'format must be json or csv' });
      const from = optionalIso(search.get('from'), 'from');
      const until = optionalIso(search.get('until'), 'until');
      const level = search.get('level') ?? '';
      if (level && !['debug', 'info', 'warn', 'error'].includes(level)) return send(res, 400, { error: 'invalid level' });
      const term = (search.get('search') ?? '').trim();
      if (term.length > 128) return send(res, 400, { error: 'search must not exceed 128 characters' });
      const username = (search.get('username') ?? '').trim();
      if (username.length > 64) return send(res, 400, { error: 'username must not exceed 64 characters' });
      const requestId = (search.get('requestId') ?? '').trim();
      if (requestId.length > 64) return send(res, 400, { error: 'requestId must not exceed 64 characters' });
      const action = (search.get('action') ?? '').trim();
      if (action.length > 64) return send(res, 400, { error: 'action must not exceed 64 characters' });

      const collected: Record<string, unknown>[] = [];
      let cursor: string | undefined;
      // Same ceiling as the audit export. An export is a deliberate act, so it is capped to
      // keep one request from reading the whole retained log.
      for (let page = 0; page < 50 && collected.length < 5_000; page += 1) {
        const chunk = await store.listLogs({
          limit: 200,
          ...(level ? { level } : {}),
          ...(from ? { from } : {}),
          ...(until ? { until } : {}),
          ...(term ? { requestId: term } : {}),
          ...(requestId ? { requestId } : {}),
          ...(username ? { username } : {}),
          ...(action ? { action } : {}),
          ...(cursor ? { cursor } : {}),
        });        for (const entry of chunk.logs) {
          // The request id is carried inside the detail record, the same place the console reads
          // it from; it is pulled out into its own column so the export can be filtered and
          // sorted on it without parsing JSON.
          const detailRequestId = typeof entry.detail?.['requestId'] === 'string' ? entry.detail['requestId'] : '';
          collected.push({
            at: entry.at,
            level: entry.level,
            action: entry.action,
            message: redactText(entry.message),
            ip: entry.ip ?? '',
            username: entry.username ?? '',
            status: entry.status ?? '',
            requestId: detailRequestId,
            detail: entry.detail ? JSON.stringify(redactForExport(entry.detail)) : '',
          });
        }
        if (!chunk.nextCursor) break;
        cursor = chunk.nextCursor;
      }

      await log('info', 'logs_exported', 'Run log exported', {
        username: auth.user.username,
        detail: { format, rows: collected.length, level: level || 'all', redacted: true },
      });
      const redaction = '导出的日志已按字段名与取值形态脱敏：令牌、密钥、邀请码与重置码不会出现在文件里；账号 ID、任务 ID 与请求 ID 保留，否则导出无法与后台对应。';
      if (format === 'json') {
        return sendText(res, 200, 'application/json; charset=utf-8', `${JSON.stringify({ exportedAt: new Date().toISOString(), redaction, rows: collected }, null, 2)}\n`, 'run-log.json');
      }
      const headers = ['at', 'level', 'action', 'message', 'ip', 'username', 'status', 'requestId', 'detail'];
      const escapeCsv = (value: unknown) => `"${String(value ?? '').replace(/"/g, '""')}"`;
      const csv = [headers.join(','), ...collected.map((row) => headers.map((header) => escapeCsv(row[header])).join(','))].join('\n');
      return sendText(res, 200, 'text/csv; charset=utf-8', `${csv}\n`, 'run-log.csv');
    }

    if (req.method === 'GET' && suffix === '/logs') {
      const limit = Math.min(Math.max(Number(search.get('limit') ?? 100), 1), 5_000);
      if (!Number.isSafeInteger(limit)) return send(res, 400, { error: 'invalid limit' });
      const from = optionalIso(search.get('from'), 'from');
      const until = optionalIso(search.get('until'), 'until');
      const username = (search.get('username') ?? '').trim();
      if (username.length > 64) return send(res, 400, { error: 'username must not exceed 64 characters' });
      const page = await store.listLogs({
        limit,
        ...(search.get('level') ? { level: search.get('level')! } : {}),
        ...(from ? { from } : {}),
        ...(until ? { until } : {}),
        ...(search.get('cursor') ? { cursor: search.get('cursor')! } : {}),
        ...(search.get('requestId') ? { requestId: search.get('requestId')! } : {}),
        ...(username ? { username } : {}),
        ...(search.get('action') ? { action: search.get('action')! } : {}),
      });
      // The action list comes from the table, so the filter stays correct as actions are added.
      return send(res, 200, { ...page, actions: await store.listLogActions() });
    }

    if (req.method === 'GET' && suffix === '/users') {
      const limit = Math.min(Math.max(Number(search.get('limit') ?? 100), 1), 500);
      if (!Number.isSafeInteger(limit)) return send(res, 400, { error: 'invalid limit' });
      const role = search.get('role') ?? '';
      const state = search.get('state') ?? '';
      const protection = search.get('protection') ?? '';
      const quota = search.get('quota') ?? '';
      if (!['', 'owner', 'admin', 'viewer', 'member'].includes(role) || !['', 'enabled', 'disabled'].includes(state)) return send(res, 400, { error: 'invalid filter' });
      if (!['', 'managed', 'private', 'relay', 'none'].includes(protection) || !['', 'ok', 'warning', 'over'].includes(quota)) return send(res, 400, { error: 'invalid filter' });
      return send(res, 200, await store.listUsers(search.get('cursor') ?? '', limit, { search: (search.get('search') ?? '').slice(0, 128), role, state, protection, quota }));
    }

    if (req.method === 'GET' && suffix === '/devices') {
      const limit = Number(search.get('limit') ?? 100);
      if (!Number.isSafeInteger(limit) || limit < 1 || limit > 500) return send(res, 400, { error: 'limit must be between 1 and 500' });
      const term = search.get('search') ?? '';
      if (term.length > 128) return send(res, 400, { error: 'search must not exceed 128 characters' });
      const { users, nextCursor } = await store.listUsers(search.get('cursor') ?? '', limit, { search: term, ...(auth.role === 'admin' ? { role: 'member' } : {}) });
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
      const sessionId = parts[1] ?? '';
      return void await withIdempotency(req, res, `revoke-session:${sessionId}`, {}, async () => {
        await store.mutateAdmin(auth.session.id, { action: 'revoke-session', sessionId }, { requestId });
        const targetSession = await store.getSession(sessionId);
        if (!targetSession) throw new ServerStoreError('NOT_FOUND', 404, 'session not found');
        await log('info', 'device_revoked', 'Revoked sync device session', {
          username: targetSession.username,
          detail: { sessionId: targetSession.id, deviceId: targetSession.deviceId, changedBy: auth.user.username },
        });
        return { status: 200, body: { device: publicSession(targetSession) } };
      });
    }

    if (req.method === 'POST' && parts[0] === 'users' && parts[2] === 'disable') {
      const username = parts[1] ?? '';
      if (username.toLocaleLowerCase() === auth.user.username.toLocaleLowerCase()) {
        return send(res, 409, { code: 'OWNER_CANNOT_BE_DISABLED', error: 'administrator cannot disable the current account' });
      }
      const body = await readBody(req, ADMIN_BODY_BYTES);
      if (typeof body.disabled !== 'boolean') return send(res, 400, { error: 'disabled must be a boolean' });
      const target = await assertManageTarget(username);
      return void await withIdempotency(req, res, `state:${target.accountId}:${String(body.disabled)}`, body, async () => {
        const affected = body.disabled ? await store.countActiveSessionsForAccount(target.accountId) : 0;
        await store.mutateAdmin(
          auth.session.id,
          { action: 'state', accountId: target.accountId, disabled: body.disabled as boolean },
          { reason: typeof body.reason === 'string' ? body.reason.slice(0, 200) : undefined, requestId, expectedVersion: Number.isSafeInteger(body.expectedVersion) ? Number(body.expectedVersion) : undefined },
        );
        const targetUser = (await store.getUser(username))!;
        await log('info', targetUser.disabled ? 'user_disabled' : 'user_enabled', targetUser.disabled ? 'Disabled sync user' : 'Enabled sync user', {
          username,
          detail: { changedBy: auth.user.username, revokedSessions: affected },
        });
        return {
          status: 200,
          body: {
            user: {
              username: targetUser.username,
              role: await store.roleForUser(targetUser.username),
              disabled: targetUser.disabled,
              createdAt: targetUser.createdAt,
              updatedAt: targetUser.updatedAt,
              lastLoginAt: targetUser.lastLoginAt ?? null,
            },
            revokedSessions: affected,
          },
        };
      });
    }

    if (req.method === 'GET' && suffix === '/invites') {
      const cursor = search.get('cursor') ?? '';
      const limit = Number(search.get('limit') ?? 25);
      const state = search.get('state') ?? '';
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
      const code = typeof body.code === 'string' && body.code.trim() ? body.code.trim() : (await import('node:crypto')).randomBytes(12).toString('base64url');
      const days = body.days === undefined ? 7 : Number(body.days);
      if (!Number.isInteger(days) || days < 1 || days > 30) return send(res, 400, { error: 'invite expiry must be 1–30 days' });
      return void await withIdempotency(req, res, 'invite-create', body, async () => {
        await store.mutateAdmin(
          auth.session.id,
          { action: 'invite-create', code, expiresAt: new Date(Date.now() + days * 86_400_000).toISOString() },
          { reason: typeof body.reason === 'string' ? body.reason.slice(0, 200) : undefined, requestId },
        );
        const invite = await store.getInvite(code);
        await log('info', 'invite_created', 'Created registration invite', { username: auth.user.username });
        return { status: 200, body: { invite } };
      });
    }

    if (req.method === 'POST' && parts[0] === 'invites' && parts[2] === 'disable') {
      const code = parts[1] ?? '';
      const body = await readBody(req, ADMIN_BODY_BYTES);
      if (typeof body.disabled !== 'boolean') return send(res, 400, { error: 'disabled must be a boolean' });
      return void await withIdempotency(req, res, `invite-state:${code}:${String(body.disabled)}`, body, async () => {
        await store.mutateAdmin(auth.session.id, { action: 'invite-state', code, disabled: body.disabled as boolean }, { requestId });
        const invite = await store.getInvite(code);
        if (!invite) throw new ServerStoreError('NOT_FOUND', 404, 'invite not found');
        await log('info', invite.disabled ? 'invite_disabled' : 'invite_enabled', invite.disabled ? 'Disabled invite' : 'Enabled invite', { username: auth.user.username });
        return { status: 200, body: { invite } };
      });
    }

    if (req.method === 'GET' && suffix === '/registration') return send(res, 200, { mode: await store.registrationMode() });
    if (req.method === 'POST' && suffix === '/registration') {
      const body = await readBody(req, ADMIN_BODY_BYTES);
      const mode = body.mode;
      if (mode !== 'open' && mode !== 'invite' && mode !== 'closed') return send(res, 400, { error: 'invalid registration mode' });
      return void await withIdempotency(req, res, 'registration', body, async () => {
        await store.mutateAdmin(auth.session.id, { action: 'registration', mode: mode as RegistrationMode }, { reason: typeof body.reason === 'string' ? body.reason.slice(0, 200) : undefined, requestId });
        await log('info', 'registration_mode_changed', 'Changed registration mode', { username: auth.user.username, detail: { mode } });
        return { status: 200, body: { mode } };
      });
    }

    return send(res, 404, { error: 'not found' });
  };

  /**
   * Records every refused or rolled-back management change before rethrowing.
   *
   * The table existed but nothing wrote to it, so the failure panels stayed empty and a
   * rejected attempt (read-only operator, protected account, stale version) left a log line at
   * most. Only requests that actually got past authentication are recorded, and the record is
   * best-effort: a diagnostic must never replace the real error.
   */
  const handle = async (req: IncomingMessage, res: ServerResponse, apiPath: string, auth: AdminAuth, requestId: string): Promise<void> => {
    const noteFailure = async (action: string, error: unknown, targetAccountId?: string): Promise<void> => {
      const code = error instanceof ServerStoreError ? error.code : 'INTERNAL_ERROR';
      const text = error instanceof Error ? error.message : String(error);
      await store.recordAdminFailure({
        actorAccountId: auth.user.accountId,
        ...(targetAccountId ? { targetAccountId } : {}),
        action,
        code,
        message: text,
        requestId,
        retention: Number(settings.settings.effective('auditFailureRetention')),
      });
    };

    if (req.method === 'GET' || req.method === 'HEAD') return handleRoute(req, res, apiPath, auth, requestId);
    try {
      return await handleRoute(req, res, apiPath, auth, requestId);
    } catch (error) {
      const suffix = apiPath.slice('/api/admin'.length) || '/';
      const parts = pathParts(suffix);
      // Prefer the account the change targeted: that is what an operator looks up.
      const target = parts[0] === 'accounts' && parts[1]
        ? (await store.userByAccountId(parts[1]).catch(() => undefined))?.accountId
        : undefined;
      await noteFailure(parts[0] ?? 'unknown', error, target).catch(() => undefined);
      throw error;
    }
  };

  return { handle };
}

function publicSession(session: Awaited<ReturnType<SyncServerStore['getSession']>>) {
  return session ? {
    id: session.id,
    username: session.username,
    deviceId: session.deviceId,
    deviceName: session.deviceName,
    kind: session.kind,
    createdAt: session.createdAt,
    updatedAt: session.updatedAt,
    expiresAt: session.expiresAt,
    lastSeenAt: session.lastSeenAt,
    lastIp: session.lastIp ?? null,
    revokedAt: session.revokedAt ?? null,
    active: !session.revokedAt && session.expiresAt > new Date().toISOString(),
  } : undefined;
}

export type AdminRouter = ReturnType<typeof createAdminRouter>;
export type { AdminAlert, AdminAuth };
