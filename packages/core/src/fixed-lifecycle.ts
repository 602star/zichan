import type { FixedAssetStatus, FixedEventType } from './types.js';

export const FIXED_STATUS_LABELS: Record<FixedAssetStatus, string> = {
  active: '使用中', stored: '闲置', sold: '已售出', scrapped: '已报废', retired: '已清退', gifted: '已赠出',
};
export const FIXED_EVENT_LABELS: Record<FixedEventType, string> = {
  purchase: '购入物品', activate: '启用', store: '转为闲置', repair: '维修', maintenance: '保养', upgrade: '升级改造',
  operating_cost: '使用费用', part_sale: '售出未建档配件', install: '安装／转装配件', detach: '拆下配件',
  residual_update: '更新参考现值', warranty_expire: '保修到期', sale: '售出物品', scrap: '报废物品', retire: '清退物品', gift: '赠出物品',
};
export function fixedEventLabel(type: FixedEventType, component = false): string {
  return component && ['purchase', 'sale', 'scrap', 'retire', 'gift'].includes(type)
    ? FIXED_EVENT_LABELS[type].replace('物品', '配件') : FIXED_EVENT_LABELS[type];
}
