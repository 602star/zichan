import type { FixedAssetCategory } from '@zichan/core';

export type BuiltInFixedAssetCategory = Pick<
  FixedAssetCategory,
  'id' | 'name' | 'parentId' | 'sortOrder' | 'isHidden' | 'isActive'
>;

const parent = (id: string, name: string, sortOrder: number): BuiltInFixedAssetCategory => ({
  id, name, sortOrder, isHidden: false, isActive: true,
});

const child = (
  id: string,
  name: string,
  parentId: string,
  sortOrder: number,
  isHidden = false,
): BuiltInFixedAssetCategory => ({ id, name, parentId, sortOrder, isHidden, isActive: true });

export const DEFAULT_FIXED_ASSET_CATEGORIES: BuiltInFixedAssetCategory[] = [
  parent('fixed-electronics', '数码电子', 10),
  child('fixed-electronics-phone', '手机', 'fixed-electronics', 11),
  child('fixed-electronics-tablet', '平板', 'fixed-electronics', 12),
  child('fixed-electronics-computer', '电脑', 'fixed-electronics', 13),
  child('fixed-electronics-display', '显示器', 'fixed-electronics', 14),
  child('fixed-electronics-camera', '相机摄影', 'fixed-electronics', 15),
  child('fixed-electronics-audio', '影音设备', 'fixed-electronics', 16),
  child('fixed-electronics-game', '游戏设备', 'fixed-electronics', 17),
  child('fixed-electronics-network', '网络设备', 'fixed-electronics', 18, true),
  child('fixed-electronics-wearable', '智能穿戴', 'fixed-electronics', 19, true),
  parent('fixed-appliance', '家用电器', 20),
  child('fixed-appliance-washer', '洗衣机', 'fixed-appliance', 21),
  child('fixed-appliance-fridge', '冰箱冰柜', 'fixed-appliance', 22),
  child('fixed-appliance-aircon', '空调', 'fixed-appliance', 23),
  child('fixed-appliance-tv', '电视投影', 'fixed-appliance', 24),
  child('fixed-appliance-kitchen', '厨房电器', 'fixed-appliance', 25),
  child('fixed-appliance-cleaning', '清洁电器', 'fixed-appliance', 26),
  child('fixed-appliance-water', '热水净水', 'fixed-appliance', 27, true),
  parent('fixed-vehicle', '车辆出行', 30),
  child('fixed-vehicle-car', '汽车', 'fixed-vehicle', 31),
  child('fixed-vehicle-motorcycle', '摩托车', 'fixed-vehicle', 32, true),
  child('fixed-vehicle-ebike', '电动车', 'fixed-vehicle', 33),
  child('fixed-vehicle-bike', '自行车', 'fixed-vehicle', 34, true),
  child('fixed-vehicle-accessory', '车辆设备', 'fixed-vehicle', 35, true),
  parent('fixed-home', '家居生活', 40),
  child('fixed-home-furniture', '家具', 'fixed-home', 41),
  child('fixed-home-decoration', '家装设施', 'fixed-home', 42),
  child('fixed-home-tool', '工具', 'fixed-home', 43, true),
  child('fixed-home-security', '安防设备', 'fixed-home', 44, true),
  child('fixed-home-lighting', '照明设备', 'fixed-home', 45, true),
  child('fixed-home-outdoor', '户外设备', 'fixed-home', 46, true),
  parent('fixed-personal', '个人用品', 50),
  child('fixed-personal-jewelry', '珠宝首饰', 'fixed-personal', 51, true),
  child('fixed-personal-instrument', '乐器', 'fixed-personal', 52, true),
  child('fixed-personal-sport', '运动器材', 'fixed-personal', 53),
  child('fixed-personal-bag', '箱包', 'fixed-personal', 54, true),
  child('fixed-personal-collection', '收藏品', 'fixed-personal', 55, true),
  parent('fixed-work', '办公与工具', 60),
  child('fixed-work-office', '办公设备', 'fixed-work', 61),
  child('fixed-work-production', '生产工具', 'fixed-work', 62, true),
  child('fixed-work-measure', '测量仪器', 'fixed-work', 63, true),
  child('fixed-work-storage', '存储设备', 'fixed-work', 64, true),
  parent('fixed-other', '其他物品', 90),
  child('fixed-other-unclassified', '待分类', 'fixed-other', 91),
  child('fixed-other-other', '其他', 'fixed-other', 92),
];
