import { useState } from 'react';
import {
  buildDcaReport,
  daysBetween,
  localToday,
  nextUnhandledDcaOccurrence,
  type DcaExecution,
  type DcaPlan,
} from '@zichan/core';
import { useSnapshot } from '../db/snapshot.js';
import { useStore } from '../db/store.js';
import { assetForm, dcaPlanForm } from '../forms.js';
import { num } from '../format.js';
import { EntityFormModal } from '../ui/EntityFormModal.js';
import { Card, CardEmpty, CardFact } from '../ui/Card.js';
import { MobilePageHeader } from '../ui/MobilePage.js';
import { AddConversionModal } from './AddConversionModal.js';

const FREQUENCY_LABEL: Record<DcaPlan['frequency'], string> = {
  daily: '每日',
  weekly: '每周',
  monthly: '每月',
  manual: '手动',
};

const STATUS_LABEL: Record<DcaPlan['status'], string> = {
  active: '启用',
  paused: '暂停',
  ended: '已结束',
};

function nextScheduleText(plan: DcaPlan, executions: DcaExecution[], today: string): string {
  if (plan.status === 'ended') return '已结束';
  if (plan.status === 'paused') return '已暂停';
  if (plan.frequency === 'manual') return '手动执行';
  const next = nextUnhandledDcaOccurrence(plan, executions);
  if (!next) return '暂无待执行期次';
  const days = daysBetween(today, next.date);
  if (days < 0) return `已逾期 ${Math.abs(days)} 天（${next.date}）`;
  if (days === 0) return `今日到期（${next.date}）`;
  if (days <= (plan.reminderDaysBefore ?? 3)) return `${days} 天后（${next.date}）`;
  return next.date;
}

export function DcaPlans() {
  const snap = useSnapshot('convert');
  const { store, bump, preview } = useStore();
  const [editing, setEditing] = useState<DcaPlan | 'new' | null>(null);
  const [creatingAsset, setCreatingAsset] = useState(false);
  const [detailId, setDetailId] = useState('');
  const [recording, setRecording] = useState('');
  const [busyId, setBusyId] = useState('');
  const [err, setErr] = useState('');
  if (!snap) return <p role="status">正在读取定投计划…</p>;

  const today = snap.setting?.asOfDate || localToday();
  const plans = snap.dcaPlans.filter((plan) => !plan.isDeleted);
  const allExecutions = snap.dcaExecutions.filter((row) => !row.isDeleted);
  const detail = plans.find((plan) => plan.id === detailId);
  const assetOf = (id: string) => snap.assets.find((asset) => asset.id === id);
  const code = (id: string) => assetOf(id)?.code ?? id;
  const decimalsOf = (id: string) => assetOf(id)?.decimals ?? 8;
  const fmtAsset = (amount: string, assetId: string) => `${num(amount, decimalsOf(assetId))} ${code(assetId)}`;
  const executionsOf = (planId: string) => allExecutions
    .filter((row) => row.planId === planId)
    .sort((a, b) => b.date.localeCompare(a.date) || b.id.localeCompare(a.id));
  const reportOf = (plan: DcaPlan) => {
    const matched = allExecutions.filter((row) => row.planId === plan.id
      && row.baseCurrencyAssetId === plan.baseCurrencyAssetId
      && row.finalAssetId === plan.targetAssetId);
    return matched.length ? buildDcaReport(matched) : null;
  };

  const toggleStatus = async (plan: DcaPlan) => {
    if (preview || busyId) return;
    const nextStatus: DcaPlan['status'] = plan.status === 'active' ? 'paused' : 'active';
    setBusyId(plan.id);
    setErr('');
    try {
      await store.runInAuditBatch(
        nextStatus === 'paused' ? '暂停定投计划' : '恢复定投计划',
        (transactionStore) => transactionStore.dcaPlans.put({ ...plan, status: nextStatus }),
      );
      bump();
    } catch (cause) {
      setErr(cause instanceof Error ? cause.message : '更新状态失败，请重试');
    } finally {
      setBusyId('');
    }
  };

  const detailExecutions = detail ? executionsOf(detail.id) : [];
  const detailReport = detail ? reportOf(detail) : null;
  const detailReportById = new Map(detailReport?.rows.map((row) => [row.executionId, row]) ?? []);

  return <div className="zc-mobile-task-page">
    {err && <p role="alert" className="zc-entry-field-error">{err}</p>}
    {detail ? <>
      <MobilePageHeader title={detail.name} onBack={() => setDetailId('')} backLabel="返回定投计划" />
      <div className="zc-record-expansion-actions">
        <button type="button" className="zc-btn zc-btn--primary" disabled={!!preview} onClick={() => setRecording(detail.id)}>登记本次买入</button>
        {detail.status !== 'ended' && (
          <button type="button" className="zc-btn" disabled={!!preview || busyId === detail.id} onClick={() => void toggleStatus(detail)}>
            {detail.status === 'active' ? '暂停计划' : '恢复启用'}
          </button>
        )}
        <button type="button" className="zc-btn" disabled={!!preview} onClick={() => setEditing(detail)}>编辑计划</button>
      </div>
      <Card title="投资安排" note="计划金额与实际买入分别记录">
        <CardFact label="每期计划投入" value={fmtAsset(detail.plannedAmount, detail.baseCurrencyAssetId)} />
        <CardFact label="目标资产" value={code(detail.targetAssetId)} />
        <CardFact label="频率" value={FREQUENCY_LABEL[detail.frequency]} />
        <CardFact label="下一期计划" value={nextScheduleText(detail, allExecutions, today)} />
        <CardFact label="计划起点" value={detail.anchorDate ?? '未设置'} />
        <CardFact label="状态" value={STATUS_LABEL[detail.status]} />
        <CardFact label="累计执行" value={`${detailExecutions.length} 期`} />
        {detailReport && (
          <>
            <CardFact
              label="累计投入"
              value={detailReport.totalInvested !== null
                ? fmtAsset(detailReport.totalInvested, detail.baseCurrencyAssetId)
                : `${fmtAsset(detailReport.knownInvested, detail.baseCurrencyAssetId)}（含 ${detailReport.unknownExecutionCount} 笔未知成本）`}
            />
            <CardFact label="累计获得" value={fmtAsset(detailReport.totalAcquired, detail.targetAssetId)} />
            {detailReport.averageCost !== null && (
              <CardFact label="平均单价" value={`${num(detailReport.averageCost, Math.min(8, decimalsOf(detail.baseCurrencyAssetId) + 2))} ${code(detail.baseCurrencyAssetId)} / ${code(detail.targetAssetId)}`} />
            )}
          </>
        )}
        {detail.defaultPath && <CardFact label="默认路径" value={detail.defaultPath} />}
        {detail.note && <CardFact label="备注" value={detail.note} />}
      </Card>
      <Card title={`执行记录（${detailExecutions.length}）`} variant="flush">
        {detailExecutions.length > 0 ? (
          <div className="zc-scroll-x">
            <table className="zc-workspace-table">
              <thead>
                <tr>
                  <th>执行日期</th>
                  <th>实际投入</th>
                  <th>获得数量</th>
                  <th>单价成本</th>
                  <th>手续费</th>
                </tr>
              </thead>
              <tbody>
                {detailExecutions.map((row) => {
                  const stat = detailReportById.get(row.id);
                  return (
                    <tr key={row.id}>
                      <td className="is-numeric">{row.date}</td>
                      <td className="is-numeric">{row.actualBaseCost === null ? '未知成本' : fmtAsset(row.actualBaseCost, row.baseCurrencyAssetId)}</td>
                      <td className="is-numeric">{fmtAsset(row.finalAmount, row.finalAssetId)}</td>
                      <td className="is-numeric">{stat?.unitCost ? `${num(stat.unitCost, Math.min(8, decimalsOf(row.baseCurrencyAssetId) + 2))} ${code(row.baseCurrencyAssetId)}` : '—'}</td>
                      <td className="is-numeric">{fmtAsset(row.totalFeeInBase, row.baseCurrencyAssetId)}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        ) : (
          <CardEmpty>尚未登记买入记录。点击「登记本次买入」后会自动关联到资产转换与持仓成本。</CardEmpty>
        )}
      </Card>
    </> : <>
      <div className="zc-section-head">
        <div>
          <h2 className="zc-section-title">定投计划</h2>
          <p className="zc-caption">按计划安排投入，实际买入进入转换记录核对。</p>
        </div>
        <div className="zc-attachment-actions">
          <button type="button" className="zc-btn" disabled={!!preview} onClick={() => setCreatingAsset(true)}>新建资产</button>
          <button type="button" className="zc-btn zc-btn--primary" disabled={!!preview} onClick={() => setEditing('new')}>新增定投计划</button>
        </div>
      </div>
      <Card variant="flush">
        <div className="zc-scroll-x">
          <table className="zc-workspace-table">
            <thead>
              <tr>
                <th>计划</th>
                <th>每期投入</th>
                <th>目标资产</th>
                <th>频率</th>
                <th>下期与进度</th>
                <th>累计投入</th>
                <th>状态</th>
                <th>操作</th>
              </tr>
            </thead>
            <tbody>
              {plans.map((plan) => {
                const execs = executionsOf(plan.id);
                const report = reportOf(plan);
                return (
                  <tr key={plan.id}>
                    <td><button type="button" className="zc-workspace-link" onClick={() => setDetailId(plan.id)}>{plan.name}</button></td>
                    <td className="is-numeric">{fmtAsset(plan.plannedAmount, plan.baseCurrencyAssetId)}</td>
                    <td>{code(plan.targetAssetId)}</td>
                    <td>{FREQUENCY_LABEL[plan.frequency]}</td>
                    <td>
                      <div>{nextScheduleText(plan, allExecutions, today)}</div>
                      <span className="zc-meta">已执行 {execs.length} 期</span>
                    </td>
                    <td className="is-numeric">
                      {report
                        ? (report.totalInvested !== null ? fmtAsset(report.totalInvested, plan.baseCurrencyAssetId) : fmtAsset(report.knownInvested, plan.baseCurrencyAssetId))
                        : '—'}
                    </td>
                    <td>{STATUS_LABEL[plan.status]}</td>
                    <td>
                      <button
                        type="button"
                        className="zc-btn zc-btn--sm"
                        disabled={!!preview || plan.status === 'ended'}
                        onClick={() => setRecording(plan.id)}
                      >
                        登记买入
                      </button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
        {!plans.length && (
          <CardEmpty>还没有定投计划。点击「新增定投计划」可直接从常用资产预设选择标的，或先点「新建资产」添加基金／ETF 等自定义标的。</CardEmpty>
        )}
      </Card>
    </>}
    {editing && (
      <EntityFormModal
        spec={dcaPlanForm(snap)}
        initial={editing === 'new' ? undefined : editing}
        onSave={async (plan) => {
          await store.runInAuditBatch('保存定投计划', (transactionStore) => transactionStore.dcaPlans.put(plan));
          bump();
        }}
        onDelete={editing !== 'new' && executionsOf(editing.id).length === 0 ? async () => {
          await store.runInAuditBatch('删除定投计划', (transactionStore) => transactionStore.dcaPlans.remove(editing.id, editing.version));
          if (detailId === editing.id) setDetailId('');
          bump();
        } : undefined}
        onClose={() => setEditing(null)}
      />
    )}
    {creatingAsset && (
      <EntityFormModal
        spec={assetForm()}
        onSave={async (asset) => {
          await store.runInAuditBatch('新增资产', (transactionStore) => transactionStore.assets.put(asset));
          bump();
        }}
        onClose={() => setCreatingAsset(false)}
      />
    )}
    {recording && <AddConversionModal preset={{ dcaPlanId: recording }} onClose={() => setRecording('')} />}
  </div>;
}
