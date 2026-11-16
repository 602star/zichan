import { fixedEventLabel, type FixedEventType } from '@zichan/core';
import type { FixedCardVM } from '../selectors/fixed.js';
import type { FixedItemActions } from './FixedItemDetail.js';
import { ActionSheet, type SheetAction } from './ActionSheet.js';

/** Route each task to its existing transaction; buying a part is not an extra host expense. */
export function FixedEventActions({ item, actions, onClose }: { item: FixedCardVM; actions: FixedItemActions; onClose: () => void }) {
  const choose = (action: () => void) => () => { onClose(); action(); };
  const event = (type: FixedEventType, note?: string): SheetAction => ({ label: fixedEventLabel(type, item.isComponent), note, onSelect: choose(() => actions.onEvent(item.id, type)) });
  const live = !item.sold && ['active', 'stored'].includes(item.raw.status);
  const groups: { title: string; entries: SheetAction[] }[] = [
    { title: '配件与耗材', entries: [
      ...(live ? item.isComponent ? [{ label: item.installedIn ? '拆下或转装配件' : '安装配件', note: '不新增购买费用，历史投入继续归属整机', onSelect: choose(() => actions.onPlacement(item.id)) }]
        : [{ label: '购入配件', note: '新电池、桨叶等单独建档，费用归属整机', onSelect: choose(() => actions.onAddComponent(item.id, false)) },
          { label: '登记原配件', note: '整机原价已包含的配件，不重复增加投入', onSelect: choose(() => actions.onAddComponent(item.id, true)) }] : []),
      ...(live ? [{ label: '登记耗材', note: '滤芯、刷头等按寿命更换；需要单独追踪时用配件', onSelect: choose(() => actions.onConsumable(item.id)) }] : []),
    ] },
    { title: '使用与维护', entries: [
      ...(live ? [item.raw.status === 'stored' ? event('activate', '从闲置恢复使用') : event('store', '保留物品，暂停使用；仍计入持有日均'), event('maintenance', '清洁、校准、例行保养，可登记费用'), event('repair', '维修或修复费用'), event('upgrade', '不单独追踪的升级改造支出')] : []),
      { label: '使用费用', note: '电费、充电、燃油或其他实际费用', onSelect: choose(() => actions.onOperating(item.id)) },
      { label: '软件／云服务订阅', note: '监控云存储、软件授权及续费，记录服务期间', onSelect: choose(() => actions.onOperating(item.id, { mode: 'fee', service: true, name: '云服务订阅' })) },
      { label: '保险／延保服务', note: '设备保险、保障计划或延保费用', onSelect: choose(() => actions.onOperating(item.id, { mode: 'fee', service: true, name: '保险／延保' })) },
    ] },
    { title: '价值与处置', entries: live ? [event('residual_update', '仅作参考，不冲减真实投入'), event('sale', '有实际回款，记录售出金额'), event('scrap', '电池损坏、桨叶破损等；历史费用保留'), event('gift', '无偿赠出，不虚构收入'), event('retire', '其他退出持有的情况，请备注原因'), ...(!item.isComponent ? [event('part_sale', '仅适用于没有单独建档的旧配件')] : [])] : [] },
  ];
  return <ActionSheet title="记录物品事件" className="zc-fixed-event-sheet" description="使用中、闲置表示使用状态；售出、报废、赠出、清退合称已处置。归档只隐藏档案，保留状态和账目。" actions={[]} onClose={onClose}>
    <div className="zc-fixed-event-groups">{groups.filter((group) => group.entries.length).map((group) => <section key={group.title}><h3>{group.title}</h3><div className="zc-action-sheet-actions">{group.entries.map((entry) => <button type="button" key={entry.label} onClick={entry.onSelect}><span><span className="zc-action-sheet-label">{entry.label}</span><span className="zc-action-sheet-note">{entry.note}</span></span></button>)}</div></section>)}</div>
  </ActionSheet>;
}
