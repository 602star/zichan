import { describeAudit } from './audit-description.js';
import type { SqlDriver, SqlParam } from '@zichan/db';
import { createHash, randomUUID } from 'node:crypto';
import { isIP } from 'node:net';
import { safeLogValue, logRequestContext } from './log-context.js';

export const LOG_CATEGORIES = ['system', 'access', 'login', 'operations', 'tasks', 'containers'] as const;
export type LogCategory = typeof LOG_CATEGORIES[number];
export interface WorkspaceLog { id: string; at: string; [field: string]: unknown }

export const LOG_WORKSPACE_SCHEMA = `
CREATE TABLE IF NOT EXISTS obs_login_events (id TEXT PRIMARY KEY, at TEXT NOT NULL, record_json TEXT NOT NULL);
CREATE INDEX IF NOT EXISTS obs_login_at ON obs_login_events(at DESC, id DESC);
CREATE INDEX IF NOT EXISTS obs_login_ip ON obs_login_events(json_extract(record_json, '$.ip'), at DESC);
CREATE INDEX IF NOT EXISTS obs_login_result ON obs_login_events(json_extract(record_json, '$.result'), at DESC);
CREATE TABLE IF NOT EXISTS obs_record_context (kind TEXT NOT NULL, record_id TEXT NOT NULL, payload TEXT NOT NULL, PRIMARY KEY(kind,record_id));
`;

export const AUTH_EVENTS: Record<string, { event: string; result: string; reason?: string }> = {
  login_success: { event: 'login.success', result: 'success' },
  federated_login_success: { event: 'login.success', result: 'success' },
  login_failed: { event: 'login.failure', result: 'failure', reason: 'BAD_CREDENTIALS' },
  login_disabled: { event: 'login.blocked', result: 'blocked', reason: 'ACCOUNT_DISABLED' },
  login_mfa_enrollment_required: { event: 'login.blocked', result: 'blocked', reason: 'MFA_ENROLLMENT_REQUIRED' },
  login_mfa_challenge: { event: 'mfa.challenge', result: 'challenge' },
  login_mfa_failed: { event: 'mfa.challenge_failed', result: 'failure', reason: 'MFA_INVALID' },
  logout: { event: 'logout', result: 'logout' },
  device_revoked: { event: 'session.revoked', result: 'revoked' },
  sessions_revoked: { event: 'session.revoked', result: 'revoked' },
  auth_rate_limited: { event: 'login.blocked', result: 'blocked', reason: 'RATE_LIMITED' },
};

export async function captureLogContext(driver: SqlDriver, kind: string, id: string, extra: Record<string, unknown> = {}, inherit = true): Promise<void> {
  const context = inherit ? logRequestContext.getStore() : undefined;
  const previous = await driver.get<{ payload: string }>('SELECT payload FROM obs_record_context WHERE kind=? AND record_id=?', [kind, id]);
  const payload = { ...(previous ? JSON.parse(previous.payload) as Record<string, unknown> : {}), ...context, ...extra };
  if (!Object.keys(payload).length) return;
  await driver.run('INSERT OR REPLACE INTO obs_record_context VALUES(?,?,?)', [kind, id, JSON.stringify(safeLogValue(payload))]);
}

const SOURCES: Record<Exclude<LogCategory, 'containers'>, string> = {
  system: `SELECT l.id, l.at, json_object('id',l.id,'at',l.at,'level',l.level,'action',l.action,'message',l.message,
    'ip',l.ip,'username',l.username,'status',l.status,'component',json_extract(l.detail_json,'$.component'),
    'requestId',json_extract(l.detail_json,'$.requestId'),'instanceId',json_extract(l.detail_json,'$.instanceId'),
    'serviceId',json_extract(l.detail_json,'$.serviceId'),'environment',json_extract(l.detail_json,'$.environment'),
    'stack',COALESCE(json_extract(l.detail_json,'$.stack'),json_extract(l.detail_json,'$.error.stack')),
    'detail',json(COALESCE(l.detail_json,'{}'))) AS record_json FROM server_logs l`,
  access: `SELECT e.id, e.at, json_object('id',e.id,'at',e.at,'method',e.method,'route',e.route,'status',e.status,
    'durationMs',e.duration_ms,'ip',e.source_ip,'requestId',e.request_id,
    'instanceId',json_extract(c.payload,'$.instanceId'),'userAgent',json_extract(c.payload,'$.userAgent'),
    'origin',json_extract(c.payload,'$.origin'),'ttfbMs',json_extract(c.payload,'$.ttfbMs')) AS record_json
    FROM obs_http_events e LEFT JOIN obs_record_context c ON c.kind='access' AND c.record_id=e.id`,
  login: 'SELECT id,at,record_json FROM obs_login_events',
  operations: `SELECT 'audit-'||a.id AS id,a.at,json_object('id','audit-'||a.id,'at',a.at,'actor',COALESCE(i.username,a.actor_account_id),
    'actorId',a.actor_account_id,'role',json_extract(c.payload,'$.role'),'ip',json_extract(c.payload,'$.ip'),
    'target',COALESCE(t.username,a.target_account_id,CASE WHEN a.action LIKE 'invite-%' THEN 'invitation' WHEN a.action LIKE 'alert-%' THEN 'alert' ELSE 'server' END),
    'targetId',a.target_account_id,'action',a.action,'result','success','requestId',COALESCE(a.request_id,json_extract(c.payload,'$.requestId')),
    'reason',a.reason,'before',json(a.before_json),'after',json(a.after_json)) AS record_json
    FROM server_admin_audit a LEFT JOIN sync_account_identities i ON i.account_id=a.actor_account_id
    LEFT JOIN sync_account_identities t ON t.account_id=a.target_account_id
    LEFT JOIN obs_record_context c ON c.kind='audit' AND c.record_id=CAST(a.id AS TEXT)
    UNION ALL SELECT 'failure-'||f.id,f.at,json_object('id','failure-'||f.id,'at',f.at,'actor',COALESCE(i.username,f.actor_account_id),
    'actorId',f.actor_account_id,'role',json_extract(c.payload,'$.role'),'ip',json_extract(c.payload,'$.ip'),
    'target',COALESCE(t.username,f.target_account_id,'server'),'targetId',f.target_account_id,'action',f.action,'result','failure',
    'requestId',f.request_id,'reason',f.reason,'reasonCode',f.code,'message',f.message)
    FROM admin_audit_failures f LEFT JOIN sync_account_identities i ON i.account_id=f.actor_account_id
    LEFT JOIN sync_account_identities t ON t.account_id=f.target_account_id
    LEFT JOIN obs_record_context c ON c.kind='failure' AND c.record_id=CAST(f.id AS TEXT)`,
  tasks: `SELECT j.job_id AS id,j.created_at AS at,json_object('id',j.job_id,'at',j.created_at,'jobId',j.job_id,'jobName',j.type,
    'createdBy',j.created_by,'result',j.status,'startedAt',j.started_at,'finishedAt',j.finished_at,
    'durationMs',CASE WHEN j.started_at IS NOT NULL AND j.finished_at IS NOT NULL THEN MAX(0,ROUND((julianday(j.finished_at)-julianday(j.started_at))*86400000)) ELSE NULL END,
    'attempt',(WITH RECURSIVE parents(id,parent,n) AS (SELECT j.job_id,j.retry_of,1 UNION ALL SELECT p.job_id,p.retry_of,r.n+1 FROM parents r JOIN admin_jobs p ON p.job_id=r.parent WHERE r.n<100) SELECT MAX(n) FROM parents),
    'instanceId',json_extract(c.payload,'$.instanceId'),'requestId',json_extract(c.payload,'$.requestId'),
    'retryOf',j.retry_of,'phase',j.phase,'processed',j.processed,'total',j.total,'reasonCode',j.error_code,'message',j.error_message,
    'outcome',json_extract(j.result_json,'$.outcome'),'detail',json(COALESCE(j.result_json,'{}'))) AS record_json
    FROM admin_jobs j LEFT JOIN obs_record_context c ON c.kind='task' AND c.record_id=j.job_id`,
};

export const LOG_FILTER_KEYS: Record<LogCategory, string[]> = {
  system: ['level', 'component', 'requestId', 'username', 'instanceId', 'action', 'ip'],
  access: ['method', 'route', 'status', 'ip', 'requestId', 'instanceId', 'minDuration', 'maxDuration'],
  login: ['result', 'username', 'ip', 'authMethod', 'action', 'requestId'],
  operations: ['actor', 'target', 'action', 'result', 'ip', 'requestId'],
  tasks: ['jobName', 'result', 'instanceId', 'requestId', 'jobId'],
  containers: ['container', 'stream'],
};

export class LogQueryError extends Error { readonly code = 'LOG_QUERY_INVALID'; }
export interface LogQuery { category: LogCategory; from: string; until: string; limit: number; search: string; filters: Record<string, string>; cursor?: string; signature: string; id?: string }
export function parseLogQuery(category: string, search: URLSearchParams): LogQuery {
  if (!(LOG_CATEGORIES as readonly string[]).includes(category)) throw new LogQueryError('未知日志类别');
  const type = category as LogCategory;
  const now = new Date();
  const range = search.get('range') ?? '24h';
  const spans: Record<string, number> = { '1h': 3600000, '24h': 86400000, '7d': 604800000, '30d': 2592000000, '90d': 7776000000 };
  if (!spans[range]) throw new LogQueryError('不支持的时间范围');
  const from = search.get('from') || new Date(now.getTime() - spans[range]!).toISOString();
  const until = search.get('until') || now.toISOString();
  if (![from, until].every((s) => /^\d{4}-\d\d-\d\dT/.test(s) && Number.isFinite(Date.parse(s)))) throw new LogQueryError('时间必须为有效 ISO 日期');
  if (Date.parse(from) >= Date.parse(until) || Date.parse(until) - Date.parse(from) > 90 * 86400000) throw new LogQueryError('查询窗口须大于零且不超过 90 天');
  const limit = Number(search.get('limit') ?? 50);
  if (!Number.isInteger(limit) || limit < 1 || limit > 200) throw new LogQueryError('每页条数须为 1–200');
  const term = (search.get('search') ?? '').trim();
  if (term.length > 128) throw new LogQueryError('关键词不能超过 128 字符');
  const filters: Record<string, string> = {};
  for (const key of LOG_FILTER_KEYS[type]) {
    const value = search.get(key)?.trim();
    if (value && value.length > 160) throw new LogQueryError('筛选值过长');
    if (value) filters[key] = value;
  }
  if (filters.ip && !isIP(filters.ip)) throw new LogQueryError('来源 IP 格式无效');
  if (filters.status && !/^[1-5]\d\d$/.test(filters.status)) throw new LogQueryError('HTTP 状态码须为 100–599');
  const enumerations: Record<string, string[]> = { level: ['info','warn','error'], method: ['GET','POST','PUT','PATCH','DELETE','HEAD','OPTIONS','OTHER'], stream: ['stdout','stderr'], authMethod: ['opaque','totp','recovery_code','federated','session'] };
  if (type === 'login') enumerations.result = ['success','failure','blocked','challenge','logout','revoked'];
  if (type === 'operations') enumerations.result = ['success','failure'];
  if (type === 'tasks') enumerations.result = ['queued','running','succeeded','failed','cancelled','interrupted'];
  for (const [key, options] of Object.entries(enumerations)) if (filters[key] && !options.includes(filters[key]!)) throw new LogQueryError(`${key} 筛选值无效`);
  for (const key of ['minDuration', 'maxDuration']) if (filters[key] && (!Number.isFinite(Number(filters[key])) || Number(filters[key]) < 0)) throw new LogQueryError('耗时必须为非负毫秒数');
  if (filters.minDuration && filters.maxDuration && Number(filters.minDuration) > Number(filters.maxDuration)) throw new LogQueryError('最小耗时不能大于最大耗时');
  const signature = createHash('sha256').update(JSON.stringify({ category, term, filters, from: search.get('from'), until: search.get('until'), range })).digest('hex').slice(0, 16);
  return { category: type, from: new Date(from).toISOString(), until: new Date(until).toISOString(), limit, search: term, filters,
    signature, ...(search.get('cursor') ? { cursor: search.get('cursor')! } : {}), ...(search.get('id') ? { id: search.get('id')!.slice(0, 160) } : {}) };
}

function readLogCursor(query: LogQuery): { at: string; id: string } | undefined {
  if (!query.cursor) return;
  try {
    if (query.cursor.length > 1024) throw new Error();
    const parsed = JSON.parse(Buffer.from(query.cursor, 'base64url').toString('utf8')) as { at: string; id: string; signature: string };
    if (parsed.signature !== query.signature || typeof parsed.id !== 'string' || !Number.isFinite(Date.parse(parsed.at))) throw new Error();
    return parsed;
  } catch { throw new LogQueryError('分页游标无效或不属于当前筛选，请返回首页'); }
}

export class LogWorkspaceStore {
  readonly instanceId = randomUUID();
  constructor(private readonly driver: SqlDriver) {}

  async recordLogin(log: { id: string; at: string; action: string; username?: string; ip?: string; detail?: Record<string, unknown> }, driver = this.driver): Promise<void> {
    const event = AUTH_EVENTS[log.action];
    if (!event) return;
    const context = logRequestContext.getStore();
    const detail = log.detail ?? {};
    const account = log.username ? await driver.get<{ account_id: string }>('SELECT account_id FROM sync_account_identities WHERE username=?', [log.username]) : undefined;
    const record = { id: log.id, at: log.at, action: event.event, result: event.result, username: log.username ?? null,
      accountId: detail['accountId'] ?? account?.account_id ?? null, identifierHash: detail['identifierHash'] ?? null,
      ip: log.ip ?? context?.ip ?? null, reasonCode: detail['reasonCode'] ?? event.reason ?? null, reason: detail['reason'] ?? null,
      authMethod: detail['authMethod'] ?? context?.authMethod ?? null, userAgent: detail['userAgent'] ?? context?.userAgent ?? null,
      device: detail['deviceName'] ?? null, deviceId: detail['deviceId'] ?? null,
      requestId: detail['requestId'] ?? context?.requestId ?? null, actorType: detail['actorType'] ?? (context?.role ? 'administrator' : null),
      instanceId: context?.instanceId ?? null, mfa: detail['mfa'] ?? (log.action.includes('mfa') ? true : null),
      detail: { ...detail, originalAction: log.action } };
    await driver.run('INSERT OR IGNORE INTO obs_login_events VALUES(?,?,?)', [log.id, log.at, JSON.stringify(safeLogValue(record))]);
  }

  async backfillLogins(): Promise<void> {
    const keys = Object.keys(AUTH_EVENTS);
    const rows = await this.driver.all<{ id: string; at: string; action: string; username?: string; ip?: string; detail_json?: string }>(
      `SELECT l.id,l.at,l.action,l.username,l.ip,l.detail_json FROM server_logs l LEFT JOIN obs_login_events e ON e.id=l.id WHERE e.id IS NULL AND l.action IN (${keys.map(() => '?').join(',')})`, keys);
    await this.driver.transaction(async (driver) => { for (const row of rows) await this.recordLogin({ ...row, detail: row.detail_json ? JSON.parse(row.detail_json) as Record<string, unknown> : {} }, driver); });
  }

  async query(query: LogQuery, exportLimit?: number) {
    if (query.category === 'containers') throw new LogQueryError('容器日志由宿主机只读桥接提供');
    const where = ['at>=?', 'at<?']; const params: SqlParam[] = [query.from, query.until];
    const cursor = readLogCursor(query);
    if (cursor) { where.push('(at < ? OR (at = ? AND id < ?))'); params.push(cursor.at, cursor.at, cursor.id); }
    if (query.id) { where.push('id = ?'); params.push(query.id); }
    for (const [key, value] of Object.entries(query.filters)) {
      if (key === 'minDuration' || key === 'maxDuration') { where.push(`CAST(json_extract(record_json,'$.durationMs') AS REAL) ${key === 'minDuration' ? '>=' : '<='} ?`); params.push(Number(value)); }
      else if (key === 'actor' || key === 'target') { where.push(`(json_extract(record_json,'$.${key}') = ? OR json_extract(record_json,'$.${key}Id') = ?)`); params.push(value, value); }
      else { where.push(`CAST(json_extract(record_json,'$.${key}') AS TEXT) = ?`); params.push(value); }
    }
    if (query.search) { where.push('instr(lower(record_json), lower(?)) > 0'); params.push(query.search); }
    const limit = exportLimit ?? query.limit;
    const rows = await this.driver.all<{ id: string; at: string; record_json: string }>(`WITH records AS (${SOURCES[query.category]}) SELECT * FROM records WHERE ${where.join(' AND ')} ORDER BY at DESC,id DESC LIMIT ?`, [...params, limit + 1]);
    const entries = rows.slice(0, limit).map((row) => safeLogValue(JSON.parse(row.record_json)) as WorkspaceLog);
    if (query.category === 'operations') for (const entry of entries) entry['summary'] = entry['result'] === 'success' ? safeLogValue(describeAudit({ action: String(entry['action']), before: entry['before'], after: entry['after'], reason: entry['reason'] as string | null }, String(entry['actor']), String(entry['target']))) : entry['message'];
    if (query.id && query.category === 'tasks' && entries[0]) entries[0]['events'] = (await this.driver.all<{ at: string; level: string; message: string; detail_json: string | null }>('SELECT at,level,message,detail_json FROM admin_job_events WHERE job_id=? ORDER BY id DESC LIMIT 100', [query.id])).map((r) => safeLogValue({ at: r.at, level: r.level, message: r.message, detail: r.detail_json ? JSON.parse(r.detail_json) as unknown : null }));
    const last = entries.at(-1);
    return { entries, hasMore: rows.length > limit, nextCursor: rows.length > limit && last ? Buffer.from(JSON.stringify({ at: last.at, id: last.id, signature: query.signature })).toString('base64url') : null };
  }

  async recordReadAudit(actorId: string, action: string, detail: Record<string, unknown>): Promise<void> {
    const context = logRequestContext.getStore();
    await this.driver.transaction(async (driver) => {
      const result = await driver.run('INSERT INTO server_admin_audit(at,actor_account_id,action,before_json,after_json,request_id) VALUES(?,?,?,?,?,?)', [new Date().toISOString(), actorId, action, '{}', JSON.stringify(safeLogValue(detail)), context?.requestId ?? null]);
      await captureLogContext(driver, 'audit', String(result.lastInsertRowid));
    });
  }

  async prune(now = Date.now()): Promise<void> {
    await this.driver.run('DELETE FROM obs_login_events WHERE id IN (SELECT id FROM obs_login_events WHERE at < ? LIMIT 2000)', [new Date(now - 90 * 86400000).toISOString()]);
    await this.driver.run(`DELETE FROM obs_record_context WHERE rowid IN (SELECT c.rowid FROM obs_record_context c WHERE
      (kind='access' AND NOT EXISTS(SELECT 1 FROM obs_http_events e WHERE e.id=c.record_id)) OR
      (kind='task' AND NOT EXISTS(SELECT 1 FROM admin_jobs j WHERE j.job_id=c.record_id)) OR
      (kind='audit' AND NOT EXISTS(SELECT 1 FROM server_admin_audit a WHERE a.id=CAST(c.record_id AS INTEGER))) OR
      (kind='failure' AND NOT EXISTS(SELECT 1 FROM admin_audit_failures f WHERE f.id=CAST(c.record_id AS INTEGER))) LIMIT 2000)`);
  }
}

export function filterContainerLogs(entries: WorkspaceLog[], query: LogQuery) {
  const cursor = readLogCursor(query);
  return entries.filter((row) => row.at >= query.from && row.at < query.until && (!query.id || row.id === query.id)
    && (!cursor || row.at < cursor.at || (row.at === cursor.at && row.id < cursor.id))
    && Object.entries(query.filters).every(([key, value]) => row[key] === value)
    && (!query.search || JSON.stringify(row).toLowerCase().includes(query.search.toLowerCase())))
    .sort((a, b) => b.at.localeCompare(a.at) || b.id.localeCompare(a.id));
}

export function containerLogCursor(row: WorkspaceLog, query: LogQuery) {
  return Buffer.from(JSON.stringify({ at: row.at, id: row.id, signature: query.signature })).toString('base64url');
}

export const LOG_EXPORT_FIELDS: Record<LogCategory, string[]> = {
  system: ['at','level','component','message','action','requestId','ip','username','serviceId','environment','instanceId','stack','detail'],
  access: ['at','method','route','status','durationMs','ip','requestId','instanceId','origin','userAgent','ttfbMs'],
  login: ['at','username','accountId','identifierHash','action','result','ip','authMethod','device','deviceId','reasonCode','reason','mfa','requestId','userAgent','actorType'],
  operations: ['at','actor','actorId','role','target','targetId','action','result','ip','requestId','reasonCode','reason','message','summary','before','after'],
  tasks: ['jobName','jobId','at','startedAt','finishedAt','result','durationMs','attempt','instanceId','requestId','retryOf','phase','processed','total','reasonCode','message','outcome','detail'],
  containers: ['at','container','stream','message','id'],
};

export function logCsv(category: LogCategory, rows: WorkspaceLog[]): string {
  const fields = LOG_EXPORT_FIELDS[category];
  const quote = (value: unknown) => {
    let text = value == null ? '' : typeof value === 'object' ? JSON.stringify(safeLogValue(value)) : String(safeLogValue(value));
    if (/^[\s\u0000-\u001f]*[=+@-]/.test(text)) text = "'" + text;
    return '"' + text.replaceAll('"', '""') + '"';
  };
  return '\uFEFF' + [fields.map(quote).join(','), ...rows.map((row) => fields.map((key) => quote(row[key])).join(','))].join('\r\n');
}
