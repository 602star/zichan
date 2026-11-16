import { readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { safeLogValue } from './log-context.js';
import { containerLogCursor, filterContainerLogs, type LogQuery, type WorkspaceLog } from './log-workspace.js';

/** The application reads one bounded host-produced file, never a user-selected path or socket. */
export async function readContainerLogs(dataDir: string, query: LogQuery, exportLimit?: number) {
  const file = join(dataDir, 'container-logs.json');
  let raw: unknown;
  try {
    if ((await stat(file)).size > 6 * 1024 * 1024) throw new Error('snapshot_too_large');
    const content = await readFile(file, 'utf8');
    if (Buffer.byteLength(content) > 6 * 1024 * 1024) throw new Error('snapshot_too_large');
    raw = JSON.parse(content);
  } catch (error) {
    const missing = error instanceof Error && 'code' in error && error.code === 'ENOENT';
    return { entries: [] as WorkspaceLog[], nextCursor: null, hasMore: false, sampledAt: null,
      sourceState: missing ? 'unconfigured' : 'error', containers: [] as string[], warnings: [missing ? '未配置宿主机容器日志桥接。' : '宿主机日志快照不可读或格式无效，请检查采集器。'] };
  }
  const value = (raw && typeof raw === 'object' ? raw : {}) as { sampledAt?: unknown; containers?: unknown; entries?: unknown; errors?: unknown };
  if (typeof value.sampledAt !== 'string' || !Number.isFinite(Date.parse(value.sampledAt)) || !Array.isArray(value.containers) || !Array.isArray(value.entries)) return {
    entries: [] as WorkspaceLog[], nextCursor: null, hasMore: false, sampledAt: null, sourceState: 'error', containers: [] as string[], warnings: ['宿主机日志快照格式无效，请检查采集器。'],
  };
  const containers = value.containers.filter((name): name is string => typeof name === 'string' && /^[A-Za-z0-9][A-Za-z0-9_.-]{0,100}$/.test(name)).slice(0, 6);
  if (query.filters.container && !containers.includes(query.filters.container)) return { entries: [] as WorkspaceLog[], nextCursor: null, hasMore: false, sampledAt: value.sampledAt, sourceState: 'available', containers, warnings: ['所选容器不在宿主机配置的白名单中。'] };
  const valid: WorkspaceLog[] = [];
  for (const entry of value.entries.slice(0, 5000)) {
    if (!entry || typeof entry !== 'object') continue;
    const row = entry as Record<string, unknown>;
    if (typeof row['id'] !== 'string' || typeof row['at'] !== 'string' || !Number.isFinite(Date.parse(row['at'])) || typeof row['container'] !== 'string' || !containers.includes(row['container']) || !['stdout', 'stderr'].includes(String(row['stream'])) || typeof row['message'] !== 'string') continue;
    valid.push(safeLogValue({ id: row['id'].slice(0, 160), at: new Date(row['at']).toISOString(), container: row['container'], stream: row['stream'], message: row['message'].slice(0, 16000) }) as WorkspaceLog);
  }
  const rows = filterContainerLogs(valid, query); const limit = exportLimit ?? query.limit;
  const entries = rows.slice(0, limit); const last = entries.at(-1);
  return { entries, nextCursor: rows.length > limit && last ? containerLogCursor(last, query) : null, hasMore: rows.length > limit,
    sampledAt: value.sampledAt, sourceState: Date.now() - Date.parse(value.sampledAt) > 180000 ? 'stale' : 'available', containers,
    warnings: ['宿主机定时快照仅保留白名单各容器最近 200 行（近 24 小时），不是 Docker 全量历史。', ...(Array.isArray(value.errors) && value.errors.length ? ['部分容器读取失败，请查看宿主机采集日志。'] : [])] };
}
