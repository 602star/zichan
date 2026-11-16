import { useEffect, useRef, useState } from 'react';
import type { AdminClient } from './client.js';
import { LogWorkspaceNav } from './LogWorkspaceNav.js';
import { LOG_DEFINITIONS, logFieldText, type LogCategory, type LogField } from './log-workspace-schema.js';
import { TimeRangeFilter } from './filters.js';
import { useFocusBoundary } from './focus-boundary.js';
import { useBodyScrollLock } from '../ui/body-scroll-lock.js';
import { SecurityEventsPage } from './SecurityEventsPage.js';
import { Badge, Button, CopyValue, Field, FilterBar, Loading, Notice, PageHeader, Panel, Select, TextInput, usePolling, useResource, when } from './ui.js';

interface LogRecord { id: string; at: string; [key: string]: unknown }
interface LogPage {
  entries: LogRecord[]; nextCursor: string | null; hasMore: boolean;
  meta: { source: string; sourceState: string; dataAsOf: string | null; generatedAt: string; from: string; until: string; warnings: string[]; containers: string[] };
}
const navType = { system: 'logs', access: 'access-logs', login: 'security-events', operations: 'audit', tasks: 'task-logs', containers: 'container-logs' } as const;

export function LogWorkspacePage({ client, category, query, navigate }: { client: AdminClient; category: LogCategory; query: URLSearchParams; navigate: (to: string) => void }) {
  const definition = LOG_DEFINITIONS[category];
  const filterFields = definition.fields.filter((field) => field.filter);
  const signature = query.toString();
  const [draft, setDraft] = useState<Record<string, string>>({});
  const [following, setFollowing] = useState(false);
  const [selected, setSelected] = useState<LogRecord>();
  const [trail, setTrail] = useState<string[]>([]);
  const [exporting, setExporting] = useState(false);
  const [notice, setNotice] = useState('');
  const filtersRef = useRef<HTMLDetailsElement>(null);
  useEffect(() => {
    setDraft(Object.fromEntries([...filterFields.map((field) => [field.key, query.get(field.key) ?? '']), ['search', query.get('search') ?? '']]));
    setSelected(undefined);
    if (query.get('cursor') || query.get('until')) setFollowing(false);
  }, [category, signature]); // eslint-disable-line react-hooks/exhaustive-deps
  const resource = useResource(() => client.request<LogPage>(`/log-workspace/${category}?${query}`), [category, signature]);
  usePolling(resource.reload, 5000, following && !query.get('cursor') && !query.get('until') && !selected);
  const rows = resource.data?.entries ?? [];
  const meta = resource.data?.meta;
  const columns = definition.fields.filter((field) => field.column);
  const filterControl = (field: LogField) => <Field label={field.label} key={field.key}>
    {field.options || (category === 'containers' && field.key === 'container' && meta?.containers.length) ? <Select value={draft[field.key] ?? ''} onChange={(event) => setDraft({ ...draft, [field.key]: event.target.value })}>
      <option value="">全部</option>{(field.options ?? (meta?.containers ?? []).map((name): [string, string] => [name, name])).map(([value, label]) => <option key={value} value={value}>{label}</option>)}
    </Select> : <TextInput type={field.key.endsWith('Duration') ? 'number' : 'text'} min={field.key.endsWith('Duration') ? 0 : undefined} value={draft[field.key] ?? ''} onChange={(event) => setDraft({ ...draft, [field.key]: event.target.value })} placeholder={field.placeholder} maxLength={160} />}
  </Field>;
  const update = (patch: Record<string, string>, paging = false) => {
    const next = new URLSearchParams(query);
    if (!paging) for (const [key, value] of Object.entries(draft)) { if (value) next.set(key, value); else next.delete(key); }
    for (const [key, value] of Object.entries(patch)) { if (value) next.set(key, value); else next.delete(key); }
    if (!paging) { next.delete('cursor'); setTrail([]); }
    navigate(`${definition.path}${next.size ? `?${next}` : ''}`);
  };
  async function download(format: 'csv' | 'json') {
    setExporting(true); setNotice('');
    let truncated = false;
    try {
      const params = new URLSearchParams(query); params.delete('cursor'); params.set('format', format);
      const blob = await client.download(`/log-workspace/${category}/export?${params}`, (result) => { truncated = result.truncated; });
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement('a'); anchor.href = url; anchor.download = `${category}-logs.${format}`;
      document.body.append(anchor); anchor.click(); anchor.remove(); setTimeout(() => URL.revokeObjectURL(url), 1000);
      setNotice(truncated ? '已导出前 5,000 条，结果已截断。请缩小时间或筛选范围后继续导出。' : `已导出 ${definition.title} ${format.toUpperCase()}，采用当前筛选并已记录导出审计。`);
    } catch (error) { setNotice(error instanceof Error ? error.message : String(error)); }
    finally { setExporting(false); }
  }
  return <>
    <PageHeader title={definition.title} description={definition.description} actions={<>
      <Button onClick={resource.reload}>刷新</Button>
      <Button disabled={exporting || !rows.length} onClick={() => void download('json')}>导出 JSON</Button>
      <Button disabled={exporting || !rows.length} onClick={() => void download('csv')}>导出 CSV</Button>
    </>} />
    <LogWorkspaceNav current={navType[category]} query={query} navigate={navigate} />
    <Loading loading={resource.loading} error={resource.error} stale={resource.stale} />
    <div className="zc-admin-log-provenance" role="status">
      <Badge tone={resource.error || resource.stale || meta?.sourceState !== 'available' ? 'warn' : 'muted'}>{resource.error ? resource.stale ? '读取失败 · 旧数据' : '读取失败' : meta?.sourceState === 'stale' ? '宿主机快照过期' : meta?.sourceState === 'unconfigured' ? '未配置采集' : meta?.sourceState === 'error' ? '采集失败' : meta ? '查询已更新' : '等待读取'}</Badge>
      <span>来源：{category === 'containers' ? '宿主机 Docker 快照' : category === 'login' ? 'SQLite 认证审计' : category === 'operations' ? 'SQLite 管理审计' : category === 'tasks' ? 'SQLite 任务记录' : category === 'access' ? 'SQLite 错误与慢请求' : 'SQLite 系统日志'}</span>
      <span>更新：{meta?.dataAsOf ? new Date(meta.dataAsOf).toLocaleTimeString('zh-CN', { hour12: false }) : '未采集'}</span>
      <span>{query.get('from') || query.get('until') ? '自定义时间' : ({ '1h': '近 1 小时', '24h': '近 24 小时', '7d': '近 7 天', '30d': '近 30 天', '90d': '近 90 天' }[query.get('range') ?? '24h'])}</span>
      <details><summary>来源与范围详情</summary><div><p>更新时间：{when(meta?.dataAsOf)} · 时区：{Intl.DateTimeFormat().resolvedOptions().timeZone}</p>{meta ? <p>{when(meta.from)} 至 {when(meta.until)}</p> : null}{meta?.warnings.map((warning) => <p key={warning}>{warning}</p>)}</div></details>
    </div>
    {meta?.sourceState === 'unconfigured' ? <Notice tone="warn">请在宿主机启用容器日志白名单采集，将 container-logs.json 通过数据卷提供给应用。</Notice> : meta?.sourceState === 'error' ? <Notice tone="bad">宿主机日志快照读取失败，请检查采集器后刷新重试。</Notice> : null}
    <FilterBar>
      <form onSubmit={(event) => { event.preventDefault(); update(draft); }}>
        <div className="zc-admin-log-quick-query">
          <TextInput aria-label="关键词" value={draft['search'] ?? ''} onChange={(event) => setDraft({ ...draft, search: event.target.value })} maxLength={128} placeholder={category === 'containers' ? '搜索容器输出' : '搜索消息、事件或上下文'} />
          <Select aria-label="日志时间范围" value={query.get('from') || query.get('until') ? 'custom' : query.get('range') ?? '24h'} onChange={(event) => { if (event.target.value === 'custom') { if (filtersRef.current) filtersRef.current.open = true; } else update({ range: event.target.value, from: '', until: '' }); }}>
            <option value="1h">近 1 小时</option><option value="24h">近 24 小时</option><option value="7d">近 7 天</option><option value="30d">近 30 天</option><option value="90d">近 90 天</option><option value="custom">自定义时间…</option>
          </Select>
          <Button type="submit">查询日志</Button>
        </div>
        <details ref={filtersRef} className="zc-admin-log-extra-filters"><summary>筛选条件{filterFields.some((field) => Boolean(query.get(field.key))) ? ` · ${filterFields.filter((field) => Boolean(query.get(field.key))).length} 项已启用` : ' · 按字段与时间'}</summary>
          <div className="zc-admin-log-filters">{filterFields.map(filterControl)}</div>
          <TimeRangeFilter from={query.get('from') ?? ''} until={query.get('until') ?? ''} onApply={(range) => update({ from: range.from ?? '', until: range.until ?? '' })} />
          <div className="zc-admin-ops-toolbar"><Button type="submit">应用筛选</Button><Button onClick={() => { setTrail([]); navigate(definition.path); }}>清除筛选</Button>
            <Button aria-pressed={following} disabled={Boolean(query.get('cursor') || query.get('until'))} onClick={() => setFollowing(!following)}>{following ? '暂停追踪' : '追踪新日志'}</Button>
            <Field label="每页条数"><Select value={query.get('limit') ?? '50'} onChange={(event) => update({ limit: event.target.value })}>{[25,50,100,200].map((n) => <option key={n} value={n}>{n} 条</option>)}</Select></Field>
          </div>
          <p className="zc-admin-log-source-note">筛选在服务端执行；时间范围最多 90 天。导出遵循当前筛选，最多 5,000 条，并进行脱敏和 CSV 公式保护。</p>
        </details>
      </form>
    </FilterBar>
    {notice ? <Notice>{notice}</Notice> : null}
    <Panel title={`${definition.title}记录`}>
      <div className="zc-admin-table zc-admin-log-table" data-category={category}><table>
        <thead><tr>{columns.map((field) => <th scope="col" key={field.key}>{field.label}</th>)}<th scope="col">详情</th></tr></thead>
        <tbody>{rows.map((row) => <tr key={row.id}>{columns.map((field) => <td key={field.key} data-column={field.key} data-label={field.label}><LogCell field={field} value={row[field.key]} />{field.supporting?.map((key) => { const secondary = definition.fields.find((f) => f.key === key); return secondary ? <small key={key}>{secondary.label}：{logFieldText(secondary, row[key])}</small> : null; })}</td>)}<td data-column="actions" data-label="详情"><Button onClick={() => { setNotice(''); setSelected(row); }}>查看详情</Button></td></tr>)}
          {!rows.length ? <tr><td colSpan={columns.length + 1}>{resource.loading ? '正在读取日志…' : resource.error ? '读取失败，请点击刷新重试。' : '当前筛选范围内没有记录。可清除筛选或扩大时间范围。'}</td></tr> : null}
        </tbody>
      </table></div>
      <div className="zc-admin-log-pager"><span>本页 {rows.length} 条</span>
        <Button disabled={!query.get('cursor')} onClick={() => { const previous = [...trail]; const cursor = previous.pop() ?? ''; setTrail(previous); update({ cursor }, true); }}>上一页</Button>
        <Button disabled={!resource.data?.nextCursor} onClick={() => { setTrail([...trail, query.get('cursor') ?? '']); setFollowing(false); update({ cursor: resource.data!.nextCursor! }, true); }}>下一页</Button>
      </div>
    </Panel>
    {category === 'login' ? <details className="zc-admin-log-security-summary"><summary>失败来源与限流汇总</summary><SecurityEventsPage client={client} query={query} navigate={navigate} embedded /></details> : null}
    {selected ? <LogDetailDrawer client={client} category={category} entry={selected} query={query} navigate={navigate} onClose={() => setSelected(undefined)} /> : null}
  </>;
}

function LogCell({ field, value }: { field: LogField; value: unknown }) {
  const text = logFieldText(field, value);
  if (field.kind === 'result' || field.key === 'level' || field.key === 'status') return <Badge tone={['failure','failed','blocked','error','interrupted'].includes(String(value)) || (field.key === 'status' && Number(value) >= 500) ? 'bad' : ['warn','challenge','queued','running'].includes(String(value)) ? 'warn' : 'muted'}>{text}</Badge>;
  return <span className={['requestId','jobId','instanceId','ip','durationMs','attempt'].includes(field.key) ? 'zc-admin-log-identifier' : undefined}>{text}</span>;
}

function LogDetailDrawer({ client, category, entry, query, navigate, onClose }: { client: AdminClient; category: LogCategory; entry: LogRecord; query: URLSearchParams; navigate: (to: string) => void; onClose: () => void }) {
  const definition = LOG_DEFINITIONS[category];
  const ref = useRef<HTMLElement>(null);
  useFocusBoundary(ref, true); useBodyScrollLock(true);
  useEffect(() => { const listener = (event: KeyboardEvent) => { if (event.key === 'Escape') onClose(); }; window.addEventListener('keydown', listener); return () => window.removeEventListener('keydown', listener); }, [onClose]);
  const detail = useResource(() => { const params = new URLSearchParams(query); params.delete('cursor'); params.set('id', entry.id); return client.request<LogPage>(`/log-workspace/${category}?${params}`); }, [category, entry.id]);
  const full = detail.data?.entries.find((row) => row.id === entry.id) ?? entry;
  const related = (path: string) => { const params = new URLSearchParams(); params.set('requestId', String(full['requestId'])); for (const key of ['from','until','range']) { const value = query.get(key); if (value) params.set(key, value); } navigate(`${path}?${params}`); };
  return <><button className="zc-admin-request-scrim" type="button" tabIndex={-1} aria-label="关闭日志详情遮罩" onClick={onClose} />
    <aside className="zc-admin-request-drawer zc-admin-log-detail-drawer" ref={ref} tabIndex={-1} role="dialog" aria-modal="true" aria-label={`${definition.title}详情`}>
      <div className="zc-admin-panel-header"><h3>{definition.title}详情</h3><Button onClick={onClose}>关闭详情</Button></div>
      <Loading loading={detail.loading} error={detail.error} stale={detail.stale} />{detail.error ? <Button onClick={detail.reload}>重试详情</Button> : null}
      <dl className="zc-admin-ops-facts">{definition.fields.filter((field) => !['minDuration','maxDuration'].includes(field.key) && field.kind !== 'json' && field.key !== 'stack').map((field) => <div key={field.key}><dt>{field.label}</dt><dd><LogCell field={field} value={full[field.key]} /></dd></div>)}</dl>
      {full['requestId'] ? <div className="zc-admin-ops-toolbar"><CopyValue value={String(full['requestId'])} label="复制 Request ID" />{category !== 'system' ? <Button onClick={() => related('/logs')}>关联系统日志</Button> : null}{category !== 'access' ? <Button onClick={() => related('/access-logs')}>关联访问日志</Button> : null}</div> : null}
      {typeof full['ip'] === 'string' && full['ip'] ? <div className="zc-admin-ops-toolbar"><CopyValue value={full['ip']} label="复制 IP" /><Button onClick={() => { const next = new URLSearchParams(query); next.delete('cursor'); next.set('ip', String(full['ip'])); navigate(`${definition.path}?${next}`); }}>筛选此 IP</Button></div> : null}
      {category === 'tasks' ? <Button onClick={() => navigate(`/jobs?job=${encodeURIComponent(entry.id)}`)}>进入任务中心</Button> : null}
      {definition.fields.filter((field) => field.kind === 'json' || field.key === 'stack').map((field) => <details className="zc-admin-log-json" key={field.key} open={field.key === 'stack' && Boolean(full[field.key])}><summary>{field.label}</summary><pre>{logFieldText(field, full[field.key])}</pre></details>)}
      <details className="zc-admin-log-json"><summary>完整脱敏记录</summary><pre>{JSON.stringify(full, null, 2)}</pre></details>
    </aside>
  </>;
}
