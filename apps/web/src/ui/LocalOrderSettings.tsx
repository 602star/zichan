import { useState } from 'react';
import { ConfirmDialog } from './ConfirmDialog.js';
import { deleteLocalOrderDatabase } from '../db/local-order-private.js';
import { useStore } from '../db/store.js';

export function LocalOrderSettings() {
  const { preview } = useStore();
  const [confirm, setConfirm] = useState(false), [status, setStatus] = useState('');
  if (preview) return null;
  return <section style={{ marginBlock: 20 }} aria-label="本机订单隐私设置"><h3 className="zc-section-title">本机订单与物流信息</h3>
    <p className="zc-caption">识别时可选择仅在此设备保留号码。它们使用独立加密存储，不参与同步、审计或普通备份；脱敏附件按普通附件保存。</p>
    <button type="button" className="zc-btn" onClick={() => setConfirm(true)}>清理本机订单与物流信息</button>
    {status && <p role="status" className="zc-meta">{status}</p>}
    {confirm && <ConfirmDialog title="清理本机订单与物流信息" confirmLabel="确认清理本机私密信息" cancelLabel="保留信息" tone="danger" onCancel={() => setConfirm(false)} onConfirm={async () => {
      await deleteLocalOrderDatabase(); setConfirm(false); setStatus('本机订单与物流信息及草稿已清理；流水、脱敏附件与识别资源不受影响。');
    }}><p>将删除此账号在本机保留的订单号、物流单号和私密草稿。此操作无法撤销，普通备份也不能恢复这些信息。</p></ConfirmDialog>}
  </section>;
}
