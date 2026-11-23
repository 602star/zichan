import type { AdminClient } from './client.js';
import { Loading, Panel, Stat, muted, usePolling, useResource } from './ui.js';

const LIMITS = [100, 250, 500, 1_000, 2_000, 5_000, 10_000, 30_000, 60_000, 120_000, 300_000, 600_000];
const LABELS: Record<string, string> = {
  total: '账本打开总耗时',
  cache_total: '本机授权快速打开总耗时', 'local.cacheOpen': '本机授权打开（自访问起）',
  'failure.total': '未完成打开的等待耗时',
  'account.sessionRestore': '恢复在线会话', 'account.login': '账号登录',
  'local.trustedDevice': '读取本机授权', 'local.dataReady': '本机数据准备就绪（自访问起）',
  'remote.snapshotDownload': '快照下载与校验总计（含准备等待）', 'remote.snapshotDecode': '快照解密与验证',
  'local.installSnapshot': '快照本机持久化',
  'account.restoreFailed': '会话恢复失败', 'account.protectionFailed': '账本保护解锁失败', 'remote.restoreFailed': '账本恢复失败',
  'background.complete': '本机后台整理完成（自访问起）', 'background.syncCaughtUp': '后台增量追平（自访问起）',
  'background.rememberDevice': '准备本机快速授权', 'background.prepareOfflinePassword': '准备密码离线访问',
  'background.recoverAttachmentOperations': '后台恢复附件操作', 'background.maintenance': '后台资料维护',
  'background.scheduledTransactions': '后台计划交易', 'background.reconcileAttachments': '后台附件目录核对',
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

export function StartupTimingPanel({ client, range, windowQuery = `range=${range}`, paused = false }: { client: AdminClient; range: '7d' | '30d' | '90d'; windowQuery?: string; paused?: boolean }) {
  const resource = useResource(() => client.request<{ buckets: Bucket[]; fromDay: string; untilDay: string }>(`/startup-timing?${windowQuery}`), [windowQuery]);
  usePolling(resource.reload, 30_000, !paused);
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
    cumulative = 0;
    const p50 = [...buckets].sort((a, b) => a.latencyBucket - b.latencyBucket).find(bucket => {
      cumulative += bucket.samples; return cumulative >= Math.ceil(samples * .5);
    })?.latencyBucket ?? 0;
    return { stage, samples, average, p50: p50 >= LIMITS.length ? '超过 10 分钟' : `≤ ${elapsed(LIMITS[p50]!)}`,
      p95: p95 >= LIMITS.length ? '超过 10 分钟' : `≤ ${elapsed(LIMITS[p95]!)}` };
  }).sort((a, b) => a.stage === 'total' ? -1 : b.stage === 'total' ? 1
    : a.stage === 'first_restore_total' ? -1 : b.stage === 'first_restore_total' ? 1 : b.average - a.average);
  return <Panel title="浏览器账本打开耗时" note={`${resource.data ? `${resource.data.fromDay} 至 ${resource.data.untilDay}（结束日不含）` : '正在读取日期范围'}；按 UTC 整天匿名汇总。新版总耗时从访问页面到界面可记账，包含登录页停留时间；旧版样本起点不同。失败样本在后续登录后补报，离线及未返回的访问可能缺失。P50/P95 为分桶上界近似值；阶段重叠，不能相加。`}>
    <Loading loading={resource.loading} error={resource.error} stale={resource.stale} loadedAt={resource.loadedAt} />
    <div className="zc-admin-monitor-mini-stats">
      <Stat label="成功打开样本" value={String(grouped.get('total')?.reduce((sum, item) => sum + item.samples, 0) ?? 0)} />
      <Stat label="其中首次恢复" value={String(grouped.get('first_restore_total')?.reduce((sum, item) => sum + item.samples, 0) ?? 0)} />
      <Stat label="其中本机快速打开" value={String(grouped.get('cache_total')?.reduce((sum, item) => sum + item.samples, 0) ?? 0)} />
      <Stat label="失败样本" value={String(grouped.get('failure.total')?.reduce((sum, item) => sum + item.samples, 0) ?? 0)} />
    </div>
    {rows.length ? <div style={{ overflowX: 'auto' }}><table style={{ width: '100%', minWidth: 680, textAlign: 'left' }}>
      <thead><tr><th>阶段</th><th>样本</th><th>平均耗时</th><th>近似 P50</th><th>近似 P95</th></tr></thead>
      <tbody>{rows.map((row) => <tr key={row.stage}><td>{LABELS[row.stage] ?? row.stage}</td><td>{row.samples}</td><td>{elapsed(row.average)}</td><td>{row.p50}</td><td>{row.p95}</td></tr>)}</tbody>
    </table></div> : <p style={muted}>该时间范围内尚无浏览器账本打开遥测。</p>}
  </Panel>;
}
