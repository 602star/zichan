import type { AdminClient } from './client.js';
import { MetricLineChart } from './chart.js';
import { Button, DataTable, Loading, Panel, Stat, muted, usePolling, useResource, when } from './ui.js';

interface Traffic {
  from: string; until: string; granularity: 'minute' | 'hour' | 'day';
  pv: number; uv: number; observedSince: string | null; countryAvailable: boolean; note: string;
  sessions: number; activeVisitors5m: number; activeVisitors30m: number; geoUnknownRatio: number | null;
  dataAsOf: string | null; generatedAt: string; source: string;
  buckets: { bucketAt: string; pv: number; uv: number }[];
  countries: { country: string | null; pv: number; uv: number }[];
  pages: { page: string; pv: number; uv: number }[];
}

function countryName(code: string | null): string {
  if (!code) return '未知地区';
  try { return new Intl.DisplayNames(['zh-CN'], { type: 'region' }).of(code) ?? code; }
  catch { return code; }
}

export function TrafficPanel({ client, range, windowQuery = `range=${range}`, paused = false, country = '', onCountry }: { client: AdminClient; range: string; windowQuery?: string; paused?: boolean; country?: string; onCountry?: (country: string) => void }) {
  const resource = useResource(() => client.request<Traffic>(`/traffic?${windowQuery}&country=${encodeURIComponent(country)}`), [windowQuery, country]);
  usePolling(resource.reload, 30000, !paused);
  const data = resource.data;
  return <section className="zc-admin-monitor-section">
    <p style={muted}>统计本站网页入口和管理页面切换。浏览器标识只用于去重；清除站点数据后会重新计算为一个浏览器。</p>
    <Loading loading={resource.loading} error={resource.error} stale={resource.stale} loadedAt={resource.loadedAt} />
    <div className="zc-admin-ops-provenance"><span>来源：{data?.source ?? '等待采集'}</span><span>最后页面事件：{data?.dataAsOf ? when(data.dataAsOf) : '未采集'}</span><span>统计更新：{data ? when(data.generatedAt) : '等待响应'}</span>{country ? <Button onClick={() => onCountry?.('')}>清除地区：{countryName(country === 'unknown' ? null : country)}</Button> : null}</div>
    <Panel title="页面访问" note={data?.note ?? '等待首次上报'} action={<button type="button" onClick={resource.reload}>刷新</button>}>
      <div className="zc-admin-ops-band">
        <Stat label="PV · 页面访问" value={data ? String(data.pv) : '暂无数据'} />
        <Stat label="UV · 去重浏览器" value={data ? String(data.uv) : '暂无数据'} />
        <Stat label={range === 'custom' ? '区间结束前 5 分钟活跃' : '近 5 分钟活跃'} value={data ? String(data.activeVisitors5m) : '未采集'} hint="以统计区间结束时刻为基准" />
        <Stat label="会话" value={data ? String(data.sessions) : '未采集'} hint="空闲至少 30 分钟后重新计数" />
      </div>
      <p style={muted}>{range === 'custom' ? '区间结束前' : '近'} 30 分钟活跃 {data?.activeVisitors30m ?? '—'}。活跃基于页面浏览估算，停留阅读不会持续上报；此数不等于实时在线人数。UV 按浏览器标识去重，清除存储或跨设备可能重复。</p>
      <p style={muted}>已排除常见 Bot User-Agent 和健康探针，无法识别所有机器人。时间范围：{data ? `${when(data.from)} 至 ${when(data.until)}` : '等待统计'}。</p>
      {data?.pv === 0 ? <p style={muted}>选定时间范围内还没有网页访问上报。</p> : null}
    </Panel>
    <div className="zc-admin-monitor-grid">
      <Panel title="访问趋势" note="每个分桶的 UV 单独去重，不能相加得到整个时间范围的 UV。">
        <MetricLineChart label={range === 'custom' ? '访问趋势，自定义区间' : `访问趋势，近 ${range}`} bucketMs={data?.granularity === 'minute' ? 60_000 : data?.granularity === 'hour' ? 3_600_000 : 86_400_000}
          formatValue={(value) => value.toFixed(0)} series={[
            { label: 'PV', color: 'var(--accent)', points: (data?.buckets ?? []).map((row) => ({ at: row.bucketAt, value: row.pv })) },
            { label: 'UV', color: 'var(--warning)', points: (data?.buckets ?? []).map((row) => ({ at: row.bucketAt, value: row.uv })) },
          ]} />
      </Panel>
      <Panel title="地区分布" note={data?.countryAvailable ? `仅使用可信代理覆盖的国家代码；未知比例 ${data.geoUnknownRatio == null ? '—' : `${(data.geoUnknownRatio * 100).toFixed(1)}%`}。` : '未配置地区数据源。需要在部署侧设置 TRAFFIC_COUNTRY_HEADER，并由可信代理覆盖该字段。'}>
        <DataTable rows={data?.countries ?? []} rowKey={(row) => row.country ?? 'unknown'} empty="暂无地区数据"
          columns={[
            { key: 'country', header: '国家或地区', render: (row: Traffic['countries'][number]) => onCountry ? <button className="zc-admin-inline-link" onClick={() => onCountry(row.country ?? 'unknown')}>{countryName(row.country)}</button> : countryName(row.country) },
            { key: 'pv', header: 'PV', render: (row: Traffic['countries'][number]) => String(row.pv) },
            { key: 'uv', header: 'UV', render: (row: Traffic['countries'][number]) => String(row.uv) },
          ]} />
      </Panel>
    </div>
    <Panel title="访问页面" note="页面路径只保留一级模块，不记录查询参数。">
      <DataTable rows={data?.pages ?? []} rowKey={(row) => row.page} empty="暂无访问页面"
        columns={[
          { key: 'page', header: '页面', render: (row: Traffic['pages'][number]) => row.page },
          { key: 'pv', header: 'PV', render: (row: Traffic['pages'][number]) => String(row.pv) },
          { key: 'uv', header: 'UV', render: (row: Traffic['pages'][number]) => String(row.uv) },
        ]} />
    </Panel>
  </section>;
}
