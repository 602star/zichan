import type { AdminClient } from './client.js';
import { MetricLineChart } from './chart.js';
import { DataTable, Loading, Panel, Stat, muted, useResource } from './ui.js';

interface Traffic {
  from: string; until: string; granularity: 'minute' | 'hour' | 'day';
  pv: number; uv: number; observedSince: string | null; countryAvailable: boolean; note: string;
  buckets: { bucketAt: string; pv: number; uv: number }[];
  countries: { country: string | null; pv: number; uv: number }[];
  pages: { page: string; pv: number; uv: number }[];
}

function countryName(code: string | null): string {
  if (!code) return '未知地区';
  try { return new Intl.DisplayNames(['zh-CN'], { type: 'region' }).of(code) ?? code; }
  catch { return code; }
}

export function TrafficPanel({ client, range }: { client: AdminClient; range: string }) {
  const resource = useResource(() => client.request<Traffic>(`/traffic?range=${range}`), [range]);
  const data = resource.data;
  return <section className="zc-admin-monitor-section">
    <h2>访问统计</h2>
    <p style={muted}>统计本站网页入口和管理页面切换。浏览器标识只用于去重；清除站点数据后会重新计算为一个浏览器。</p>
    <Loading loading={resource.loading} error={resource.error} stale={resource.stale} loadedAt={resource.loadedAt} />
    <Panel title="页面访问" note={data?.note ?? '等待首次上报'} action={<button type="button" onClick={resource.reload}>刷新</button>}>
      <div className="zc-admin-monitor-mini-stats">
        <Stat label="PV · 页面访问" value={data ? String(data.pv) : '暂无数据'} />
        <Stat label="UV · 去重浏览器" value={data ? String(data.uv) : '暂无数据'} />
        <Stat label="地区覆盖" value={data ? data.countryAvailable ? `${data.countries.filter((row) => row.country).reduce((sum, row) => sum + row.pv, 0)} 次有来源` : '未配置' : '暂无数据'} />
      </div>
      {data?.pv === 0 ? <p style={muted}>选定时间范围内还没有网页访问上报。</p> : null}
    </Panel>
    <div className="zc-admin-monitor-grid">
      <Panel title="访问趋势" note="每个分桶的 UV 单独去重，不能相加得到整个时间范围的 UV。">
        <MetricLineChart label={`访问趋势，近 ${range}`} bucketMs={data?.granularity === 'minute' ? 60_000 : data?.granularity === 'hour' ? 3_600_000 : 86_400_000}
          formatValue={(value) => value.toFixed(0)} series={[
            { label: 'PV', color: 'var(--accent)', points: (data?.buckets ?? []).map((row) => ({ at: row.bucketAt, value: row.pv })) },
            { label: 'UV', color: 'var(--warning)', points: (data?.buckets ?? []).map((row) => ({ at: row.bucketAt, value: row.uv })) },
          ]} />
      </Panel>
      <Panel title="地区分布" note={data?.countryAvailable ? '仅使用可信代理覆盖的国家代码；缺失的访问列为未知。' : '需要在部署侧设置 TRAFFIC_COUNTRY_HEADER，并由可信代理覆盖该字段。'}>
        <DataTable rows={data?.countries ?? []} rowKey={(row) => row.country ?? 'unknown'} empty="暂无地区数据"
          columns={[
            { key: 'country', header: '国家或地区', render: (row: Traffic['countries'][number]) => countryName(row.country) },
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
