import type { AdminClient } from './client.js';
import { Loading, Panel, Stat, muted, useResource } from './ui.js';

const LIMITS = [100, 250, 500, 1_000, 2_000, 5_000, 10_000, 30_000, 60_000, 120_000, 300_000, 600_000];
const LABELS: Record<string, string> = {
  total: '账本打开总耗时',
  first_restore_total: '新设备首次恢复总耗时',
  'account.protectionRequest': '查询账号保护', 'account.unlockLedgerKey': '解锁账本密钥',
  'account.unlockDeviceStorage': '解锁本机存储', 'local.inspectStorage': '检查本机存储',
  'local.openDatabase': '打开本机数据库', 'local.initializeStore': '初始化本机账本',
  'local.inspectLedger': '检查本机账本', 'remote.authenticate': '远端认证',
  'remote.checkReplica': '检查远端副本', 'remote.fetchKeyEnvelope': '获取密钥封装',
  'remote.unlockLedgerKey': '解锁远端账本密钥', 'remote.openTemporaryStore': '准备临时数据库',
  'remote.commit.total': '提交同步与验证', 'remote.commit.connect': '连接同步服务',
  'remote.commit.pull': '拉取提交', 'remote.commit.apply': '应用提交',
  'remote.commit.push': '推送提交', 'remote.commit.verify': '验证提交',
  'remote.consistency': '一致性检查', 'remote.export': '导出恢复数据',
  'remote.importPreflight': '导入预检查', 'remote.exportDeviceState': '准备设备状态',
  'local.importLedger': '导入本机账本', 'local.ensureBackupKey': '准备备份密钥',
  'local.recoverAttachmentOperations': '恢复附件操作', 'local.maintenance': '本机维护',
  'local.scheduledTransactions': '处理计划交易', 'local.finalSync': '最后同步',
};

interface Bucket { stage: string; latencyBucket: number; samples: number; durationSumMs: number }
const elapsed = (ms: number) => ms >= 1_000 ? `${(ms / 1_000).toFixed(1)} 秒` : `${Math.round(ms)} 毫秒`;

export function StartupTimingPanel({ client, range }: { client: AdminClient; range: '7d' | '30d' | '90d' }) {
  const resource = useResource(() => client.request<{ buckets: Bucket[] }>(`/startup-timing?range=${range}`), [range]);
  const grouped = new Map<string, Bucket[]>();
  for (const bucket of resource.data?.buckets ?? []) grouped.set(bucket.stage, [...(grouped.get(bucket.stage) ?? []), bucket]);
  const rows = [...grouped].map(([stage, buckets]) => {
    const samples = buckets.reduce((sum, bucket) => sum + bucket.samples, 0);
    const average = buckets.reduce((sum, bucket) => sum + bucket.durationSumMs, 0) / samples;
    let cumulative = 0;
    const p95 = [...buckets].sort((a, b) => a.latencyBucket - b.latencyBucket).find((bucket) => {
      cumulative += bucket.samples;
      return cumulative >= Math.ceil(samples * .95);
    })?.latencyBucket ?? 0;
    return { stage, samples, average, p95: p95 >= LIMITS.length ? '超过 10 分钟' : `≤ ${elapsed(LIMITS[p95]!)}` };
  }).sort((a, b) => a.stage === 'total' ? -1 : b.stage === 'total' ? 1
    : a.stage === 'first_restore_total' ? -1 : b.stage === 'first_restore_total' ? 1 : b.average - a.average);
  return <Panel title="浏览器账本打开耗时" note={`近 ${range}；按天汇总，因此最短查看 7 天。浏览器完成打开后上报；服务端仅保存匿名日汇总。P95 是耗时分桶上界的近似值；阶段可能重叠，不能相加为总耗时。`}>
    <Loading loading={resource.loading} error={resource.error} stale={resource.stale} loadedAt={resource.loadedAt} />
    <div className="zc-admin-monitor-mini-stats">
      <Stat label="成功打开样本" value={String(grouped.get('total')?.reduce((sum, item) => sum + item.samples, 0) ?? 0)} />
      <Stat label="其中首次恢复" value={String(grouped.get('first_restore_total')?.reduce((sum, item) => sum + item.samples, 0) ?? 0)} />
    </div>
    {rows.length ? <div style={{ overflowX: 'auto' }}><table style={{ width: '100%', textAlign: 'left' }}>
      <thead><tr><th>阶段</th><th>样本</th><th>平均耗时</th><th>近似 P95</th></tr></thead>
      <tbody>{rows.map((row) => <tr key={row.stage}><td>{LABELS[row.stage] ?? row.stage}</td><td>{row.samples}</td><td>{elapsed(row.average)}</td><td>{row.p95}</td></tr>)}</tbody>
    </table></div> : <p style={muted}>该时间范围内尚无浏览器账本打开遥测。</p>}
  </Panel>;
}
