import { useStore } from '../db/store.js';
import { useLocalOrders } from '../use-local-orders.js';
import { useState } from 'react';

export function LocalOrderDetails({ transactionId }: { transactionId: string }) {
  const { store, preview } = useStore();
  const local = useLocalOrders(store, '', transactionId, !preview);
  const [removing, setRemoving] = useState(''), [error, setError] = useState('');
  const hasRows = local.records.length > 0;
  if (preview || (!hasRows && !local.error)) return null;
  return <details style={{ gridColumn: '1 / -1', minWidth: 0, paddingBlock: 12 }}><summary>本机订单与物流信息{hasRows ? ` · ${local.records.length} 条` : ''}</summary>
    <p className="zc-meta">仅此设备可见，不同步，也不包含在普通备份中。作废流水时隐藏，恢复流水后可再次查看。</p>
    {local.error && <p role="status" className="zc-caption">{local.error}<button type="button" className="zc-btn" onClick={() => void local.refresh()}>重试读取</button></p>}
    {local.records.map((row) => <div key={row.captureId} style={{ paddingBlock: 10, borderBottom: '1px solid var(--border)', overflowWrap: 'anywhere' }}>
      {row.orderNumber && <p>订单号：{row.orderNumber}</p>}{row.trackingNumbers?.map((number) => <p key={number}>物流单号：{number}</p>)}
      <button type="button" className="zc-btn" onClick={() => setRemoving(row.captureId)}>清除这条本机订单信息</button>
      {removing === row.captureId && <div><p className="zc-caption">将永久清除此设备保留的号码，普通备份无法恢复。</p><button type="button" className="zc-btn" onClick={() => void local.remove(row.captureId).then(() => setRemoving('')).catch(() => setError('清理失败，请重试。'))}>确认清除这条信息</button><button type="button" className="zc-btn" onClick={() => setRemoving('')}>保留信息</button></div>}
    </div>)}
    {error && <p role="alert">{error}</p>}
  </details>;
}
