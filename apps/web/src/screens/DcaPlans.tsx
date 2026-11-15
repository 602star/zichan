import { useState } from 'react';
import type { DcaPlan } from '@zichan/core';
import { useSnapshot } from '../db/snapshot.js';
import { useStore } from '../db/store.js';
import { dcaPlanForm } from '../forms.js';
import { num } from '../format.js';
import { EntityFormModal } from '../ui/EntityFormModal.js';
import { Card, CardEmpty, CardFact } from '../ui/Card.js';
import { MobilePageHeader } from '../ui/MobilePage.js';
import { AddConversionModal } from './AddConversionModal.js';

export function DcaPlans() {
  const snap = useSnapshot('manage');
  const { store, bump } = useStore();
  const [editing, setEditing] = useState<DcaPlan | 'new' | null>(null);
  const [detailId, setDetailId] = useState('');
  const [recording, setRecording] = useState('');
  if (!snap) return <p role="status">正在读取定投计划…</p>;
  const plans = snap.dcaPlans.filter((plan) => !plan.isDeleted);
  const detail = plans.find((plan) => plan.id === detailId);
  const code = (id: string) => snap.assets.find((asset) => asset.id === id)?.code ?? id;
  const frequency = (plan: DcaPlan) => ({ daily: '每日', weekly: '每周', monthly: '每月', manual: '手动' })[plan.frequency];
  const value = (plan: DcaPlan) => `${num(plan.plannedAmount, snap.assets.find((asset) => asset.id === plan.baseCurrencyAssetId)?.decimals ?? 8)} ${code(plan.baseCurrencyAssetId)}`;
  return <div className="zc-mobile-task-page">
    {detail ? <>
      <MobilePageHeader title={detail.name} onBack={() => setDetailId('')} backLabel="返回定投计划" />
      <Card title="投资安排" note="计划金额与实际买入分别记录">
        <CardFact label="每期计划投入" value={value(detail)} />
        <CardFact label="目标资产" value={code(detail.targetAssetId)} />
        <CardFact label="频率" value={frequency(detail)} />
        <CardFact label="计划起点" value={detail.anchorDate ?? '未设置'} />
        <CardFact label="状态" value={detail.status === 'active' ? '启用' : detail.status === 'paused' ? '暂停' : '已结束'} />
      </Card>
      <div className="zc-record-expansion-actions"><button type="button" className="zc-btn zc-btn--primary" onClick={() => setRecording(detail.id)}>登记本次买入</button><button type="button" className="zc-btn" onClick={() => setEditing(detail)}>编辑计划</button></div>
    </> : <>
      <div className="zc-section-head"><div><h2 className="zc-section-title">定投计划</h2><p className="zc-caption">按计划安排投入，实际买入进入转换记录核对。</p></div><button type="button" className="zc-btn zc-btn--primary" onClick={() => setEditing('new')}>新增定投计划</button></div>
      <Card variant="flush"><div className="zc-scroll-x"><table className="zc-workspace-table"><thead><tr><th>计划</th><th>每期投入</th><th>目标资产</th><th>频率</th><th>状态</th></tr></thead><tbody>{plans.map((plan) => <tr key={plan.id}><td><button type="button" className="zc-workspace-link" onClick={() => setDetailId(plan.id)}>{plan.name}</button></td><td className="is-numeric">{value(plan)}</td><td>{code(plan.targetAssetId)}</td><td>{plan.frequency}</td><td>{plan.status === 'active' ? '启用' : plan.status === 'paused' ? '暂停' : '已结束'}</td></tr>)}</tbody></table></div>{!plans.length && <CardEmpty>还没有定投计划。先在资产资料中启用投资标的，再安排每期投入。</CardEmpty>}</Card>
    </>}
    {editing && <EntityFormModal spec={dcaPlanForm(snap)} initial={editing === 'new' ? undefined : editing} onSave={async (plan) => {
      await store.runInAuditBatch('保存定投计划', (transactionStore) => transactionStore.dcaPlans.put(plan));
      bump();
    }} onClose={() => setEditing(null)} />}
    {recording && <AddConversionModal preset={{ dcaPlanId: recording }} onClose={() => setRecording('')} />}
  </div>;
}
