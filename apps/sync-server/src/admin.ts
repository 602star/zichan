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
import { isJobType, jobParamsFor, type JobRunner } from './jobs.js';
import { importMaintenanceRecords } from './maintenance-records.js';
import type { MetricsService } from './metrics.js';
import { SETTING_FIELDS, type SettingsFacade } from './settings.js';
import {
  ServerStoreError,
  type AccountRole,
  type AdminAlert,
  type JsonRecord,
  type RegistrationMode,
  type ServerLog,
  type SyncServerStore,
} from './store.js';

export interface AdminRouterDeps {
  store: SyncServerStore;
  blobStore: EncryptedBlobStore;
  settings: SettingsFacade;
  metrics: MetricsService;
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
  'password-change-authorize', 'owner-recovery-local', 'settings-save', 'settings-update', 'sessions-revoke-all', 'alert-acknowledge',
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
  const roleName = (role: unknown) => role === 'owner' ? '所有者' : role === 'admin' ? '管理员' : '普通用户';
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

  /** Write routes accept an optional idempotency key so a timeout cannot duplicate work. */
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
    const existing = await store.idempotentResult(key);
    if (existing) {
      if (existing.fingerprint !== fingerprint) {
        send(res, 409, { code: 'IDEMPOTENCY_KEY_REUSED', error: '该幂等键曾用于不同的请求参数，已拒绝' });
        return;
      }
      send(res, existing.status, { ...existing.body, replayed: true });
      return;
    }
    const result = await run();
    await store.storeIdempotentResult(key, fingerprint, result.status, result.body);
    send(res, result.status, result.body);
  };

  const handle = async (req: IncomingMessage, res: ServerResponse, apiPath: string, auth: AdminAuth, requestId: string): Promise<void> => {
    let suffix = apiPath.slice('/api/admin'.length) || '/';
    let parts = pathParts(suffix);
    const search = new URL(req.url ?? '/', 'http://localhost').searchParams;

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
        if (body.role !== 'admin' && body.role !== 'member') return send(res, 400, { error: 'invalid role' });
        return void await withIdempotency(req, res, `role:${target.accountId}`, body, async () => {
          await store.mutateAdmin(auth.session.id, { action: 'role', accountId: target.accountId, role: body.role as 'admin' | 'member' }, { reason: typeof body.reason === 'string' ? body.reason.slice(0, 200) : undefined, requestId, expectedVersion: Number.isSafeInteger(body.expectedVersion) ? Number(body.expectedVersion) : undefined });
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
        capabilities: { sessionsPagination: true, jobs: true, metrics: true, syncDiagnostics: true, alerts: true },
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
        observedSince: buckets[0]?.bucketAt ?? null,
        note: '指标从本次上线开始积累；尚未采集的时间范围内没有数据，不等同于零。',
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
      return send(res, 200, await store.listJobs({
        limit,
        ...(status ? { status } : {}),
        ...(search.get('type') ? { type: search.get('type')! } : {}),
        ...(search.get('cursor') ? { cursor: search.get('cursor')! } : {}),
      }));
    }

    if (req.method === 'POST' && suffix === '/jobs') {
      const body = await readBody(req, ADMIN_BODY_BYTES);
      const type = body.type;
      if (!isJobType(type)) return send(res, 400, { code: 'JOB_TYPE_INVALID', error: '不支持的任务类型' });
      if (type === 'backup.verify' || type === 'restore.drill') {
        if (auth.role !== 'owner') return send(res, 403, { code: 'OWNER_REQUIRED', error: '该任务需要所有者权限' });
      }
      const accountId = typeof body.accountId === 'string' ? body.accountId : undefined;
      // Validate the closed parameter set first so a malformed value is a client error,
      // not an account lookup miss.
      const params = jobParamsFor(type, body);
      let targetAccount: Awaited<ReturnType<typeof store.userByAccountId>>;
      if (accountId) {
        targetAccount = await store.userByAccountId(accountId);
        if (!targetAccount) return send(res, 404, { error: 'account not found' });
        if (auth.role !== 'owner' && await store.roleForUser(targetAccount.username) !== 'member') {
          return send(res, 403, { code: 'PROTECTED_ACCOUNT', error: 'cannot manage this privileged account' });
        }
      }
      return void await withIdempotency(req, res, `jobs:${type}:${accountId ?? ''}`, body, async () => {
        const job = await store.createJob({
          type,
          params: { ...params, ...(accountId ? { accountId } : {}) },
          createdBy: auth.user.username,
          ...(accountId ? { targetAccountId: accountId } : {}),
        });
        await log('info', 'job_created', 'Maintenance job queued', { username: auth.user.username, detail: { jobId: job.jobId, type: job.type } });
        jobs.kick();
        return { status: 202, body: { job } };
      });
    }

    if (parts[0] === 'jobs' && parts[1]) {
      const jobId = parts[1];
      if (req.method === 'GET' && parts.length === 2) {
        const job = await store.getJob(jobId);
        if (!job) return send(res, 404, { error: 'job not found' });
        return send(res, 200, { job, events: await store.listJobEvents(jobId, 50) });
      }
      if (req.method === 'POST' && parts[2] === 'cancel') {
        const job = await store.requestJobCancel(jobId);
        if (!job) return send(res, 404, { error: 'job not found' });
        if (job.status === 'queued') jobs.kick();
        await log('info', 'job_cancel_requested', 'Maintenance job cancellation requested', { username: auth.user.username, detail: { jobId } });
        return send(res, 200, { job });
      }
      if (req.method === 'POST' && parts[2] === 'retry') {
        const job = await store.getJob(jobId);
        if (!job) return send(res, 404, { error: 'job not found' });
        if (job.status === 'running' || job.status === 'queued') return send(res, 409, { code: 'JOB_ACTIVE', error: '任务仍在执行，不能重新执行' });
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
          return { status: 202, body: { job: created } };
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

    if (req.method === 'GET' && suffix === '/alerts') {
      const state = search.get('state') ?? '';
      if (state && !['pending', 'active', 'resolved'].includes(state)) return send(res, 400, { error: 'invalid state' });
      return send(res, 200, { alerts: await store.listAlerts({ ...(state ? { state } : {}) }) });
    }

    if (req.method === 'POST' && parts[0] === 'alerts' && parts[2] === 'acknowledge') {
      const key = parts[1] ?? '';
      const alert = await store.acknowledgeAlert(key, auth.user.accountId);
      if (!alert) return send(res, 404, { error: 'alert not found' });
      await log('info', 'alert_acknowledged', 'Alert acknowledged', { username: auth.user.username, detail: { key } });
      return send(res, 200, { alert });
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

    if (req.method === 'GET' && suffix === '/status') {
      const snapshot = await metrics.current();
      const probe = await store.probe();
      return send(res, 200, {
        ok: true,
        serverId: deps.serverId,
        syncEnabled: deps.enableSync,
        webEnabled: deps.enableWeb,
        basePath: deps.basePath,
        dataDir: deps.dataDir,
        databaseFile: deps.databaseFile,
        claimed: await store.ownerUsername() !== undefined,
        registrationMode: await store.registrationMode(),
        userCount: snapshot.counts.userCount,
        disabledUserCount: snapshot.counts.disabledUserCount,
        inviteCount: snapshot.counts.inviteCount,
        commitCount: snapshot.counts.commitCount,
        commitBytes: snapshot.counts.commitBytes,
        activeSessionCount: snapshot.counts.activeSessionCount,
        journalMode: probe.journalMode,
        tempStore: probe.tempStore,
        schemaVersion: probe.schemaVersion,
        sampledAt: snapshot.sampledAt,
      });
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
        return { status: 202, body: { job } };
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
      return void await withIdempotency(req, res, `blobs.verify:${accountId ?? 'all'}`, body, async () => {
        const job = await store.createJob({
          type: 'blobs.verify',
          params: accountId ? { accountId } : {},
          createdBy: auth.user.username,
          ...(accountId ? { targetAccountId: accountId } : {}),
        });
        jobs.kick();
        return { status: 202, body: { job } };
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

    if (req.method === 'GET' && suffix === '/logs') {
      const limit = Math.min(Math.max(Number(search.get('limit') ?? 100), 1), 5_000);
      if (!Number.isSafeInteger(limit)) return send(res, 400, { error: 'invalid limit' });
      return send(res, 200, await store.listLogs({
        limit,
        ...(search.get('level') ? { level: search.get('level')! } : {}),
        ...(search.get('from') ? { from: search.get('from')! } : {}),
        ...(search.get('until') ? { until: search.get('until')! } : {}),
        ...(search.get('cursor') ? { cursor: search.get('cursor')! } : {}),
        ...(search.get('requestId') ? { requestId: search.get('requestId')! } : {}),
      }));
    }

    if (req.method === 'GET' && suffix === '/users') {
      const limit = Math.min(Math.max(Number(search.get('limit') ?? 100), 1), 500);
      if (!Number.isSafeInteger(limit)) return send(res, 400, { error: 'invalid limit' });
      const role = search.get('role') ?? '';
      const state = search.get('state') ?? '';
      const protection = search.get('protection') ?? '';
      const quota = search.get('quota') ?? '';
      if (!['', 'owner', 'admin', 'member'].includes(role) || !['', 'enabled', 'disabled'].includes(state)) return send(res, 400, { error: 'invalid filter' });
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
