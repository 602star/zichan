import { D, FIXED_OPERATING_LABELS, fixedMeterStates, parseFixedOperatingCost } from '@zichan/core';
import type { FixedCardVM } from '../selectors/fixed.js';
import type { FixedItemActions } from './FixedItemDetail.js';
import { amount, money } from '../format.js';
import { CardEmpty, CardFact, CardGroup } from './Card.js';

export function FixedOperatingCosts({ item, actions, onViewHistory, onViewUnpriced }: { item: FixedCardVM; actions: FixedItemActions; onViewHistory: () => void; onViewUnpriced: () => void }) {
  const records = item.timeline.filter((row) => row.kind === 'event' && row.raw && 'type' in row.raw && row.raw.type === 'operating_cost');
  const meters = fixedMeterStates(records.map((row) => row.raw).filter((row): row is import('@zichan/core').FixedAssetEvent => 'type' in row));
  const units = new Map<string, string>();
  let unpriced = 0;
  for (const row of records) {
    const data = parseFixedOperatingCost('operatingCostJson' in row.raw ? row.raw.operatingCostJson : undefined)!;
    if (data.mode === 'estimate') continue;
    if (data.quantity !== undefined) units.set(data.unit, D(units.get(data.unit)).plus(data.quantity).toString());
    if (data.quantity !== undefined && D(data.quantity).gt(0) && !data.costKnown) unpriced++;
  }
  const cash = (value: string) => money(value, item.currencySymbol);
  return <CardGroup>
    <div className="zc-fixed-toolbar"><h3>使用费用</h3><div className="zc-fixed-actions"><button type="button" className="zc-btn zc-btn--primary" onClick={() => actions.onOperating(item.id)}>记录使用费用</button><button type="button" className="zc-btn" onClick={() => actions.onOperating(item.id, { mode: 'fee', service: true })}>订阅与服务费用</button><button type="button" className="zc-btn" onClick={() => actions.onOperating(item.id, { mode: 'start' })}>添加计量项目</button></div></div>
    <p className="zc-caption">电费、充电费、软件／云服务、保险延保与耗材分开记录。支持设备统计、外接电能表或手动账单；未计量期间不会自动补零。同一段用量的账单和抄表费用请选一种登记。</p>
    <div className="zc-fixed-facts"><CardFact label="已登记使用费用" value={cash(item.operatingCost)} /><CardFact label="估算参考费用" value={`${cash(item.estimatedOperatingCost)}（未计入净投入）`} />{[...units].map(([unit, quantity]) => <CardFact key={unit} label={`已记录用量 · ${unit}`} value={amount(quantity, 4)} />)}{unpriced > 0 && <CardFact label="待补费用" value={`${unpriced} 笔用量未定价，不按零费用展示`} />}</div>
    {meters.map((meter) => <div className="zc-fixed-location-row" key={meter.id}><div><span>{meter.name} · {meter.active ? '计量中' : '已暂停 · 后续未计量'}</span><small>最近读数 {amount(meter.reading, 4)} {meter.unit} · {meter.last.date} · 已测用量 {amount(meter.quantity, 4)} {meter.unit}</small></div><div className="zc-fixed-actions">
      {meter.active ? <><button type="button" className="zc-btn" onClick={() => actions.onOperating(item.id, { mode: 'reading', meterId: meter.id })}>抄表计费</button><button type="button" className="zc-btn" onClick={() => actions.onOperating(item.id, { mode: 'pause', meterId: meter.id })}>暂停计量</button></> : <button type="button" className="zc-btn" onClick={() => actions.onOperating(item.id, { mode: 'resume', meterId: meter.id })}>设置起点并恢复</button>}
      <button type="button" className="zc-btn" onClick={() => actions.onOperating(item.id, { mode: 'reset', meterId: meter.id })}>换表／归零</button>
    </div></div>)}
    {!records.length && <CardEmpty>可直接记一笔充电费，或登记电表起点后按读数计费。</CardEmpty>}
    {records.length > 0 && <h4>最近 3 条使用费用记录</h4>}
    <div className="zc-fixed-operating-recent">{records.slice(0, 3).map((entry) => {
      const data = parseFixedOperatingCost('operatingCostJson' in entry.raw ? entry.raw.operatingCostJson : undefined)!;
      return <button type="button" className="zc-fixed-record-row" key={entry.id} onClick={() => actions.onTimeline(item, entry)}><span>{entry.date}</span><span>{data.name} · {data.service ? '订阅与服务' : FIXED_OPERATING_LABELS[data.mode]}<small>{entry.detail}</small></span><span>{data.costKnown ? `${data.mode === 'estimate' ? '参考 ' : ''}${cash('amountBase' in entry.raw ? entry.raw.amountBase : '0')}` : data.quantity !== undefined ? '费用待补' : '查看'}</span></button>;
    })}</div>
    {records.length > 0 && <div className="zc-fixed-actions"><button type="button" className="zc-btn" onClick={onViewHistory}>查看全部使用费用（{records.length} 条）</button>{unpriced > 0 && <button type="button" className="zc-btn" onClick={onViewUnpriced}>处理待补费用（{unpriced} 笔）</button>}</div>}
  </CardGroup>;
}
