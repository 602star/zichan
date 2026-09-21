import type { Category, Payee } from '@zichan/core';

/** Browsing metadata only: these groups never change ledger categories or accounts. */
export const PAYEE_SCENES = [
  { id: 'food', name: '外卖与餐饮', categories: ['takeaway', 'food', 'coffee_drinks', 'dining_out', 'other_food', 'breakfast', 'lunch_work_meal', 'dinner', 'late_night_snack', 'bakery_dessert', 'group_buy_food', 'company_dinner', 'buffet'] },
  { id: 'fresh', name: '商超与生鲜', categories: ['groceries', 'snacks_fruit', 'shopping', 'fresh_delivery', 'seasoning_grain_oil', 'prepared_food'] },
  { id: 'shopping', name: '电商购物', categories: ['clothing', 'beauty', 'digital_goods', 'shopping', 'mother_baby', 'furniture_appliance', 'books', 'stationery', 'pet_food', 'pet_supplies', 'underwear_socks', 'accessories', 'luggage_bags', 'sports_equipment', 'outdoor_equipment', 'camera_equipment', 'computer_accessories', 'phone_accessories', 'office_supplies', 'home_goods', 'storage_supplies', 'bedding', 'second_hand_purchase'] },
  { id: 'ride', name: '打车与用车', categories: ['taxi_ride', 'taxi', 'bike_ebike', 'shared_ebike', 'designated_driver', 'car_rental'] },
  { id: 'travel', name: '旅行与住宿', categories: ['train_flight', 'flight', 'travel', 'hotel', 'tickets', 'car_rental', 'amusement_park'] },
  { id: 'tickets', name: '电影与演出', categories: ['movies', 'concert', 'music_festival', 'exhibition', 'museum'] },
  { id: 'digital', name: '会员与数字服务', categories: ['subscriptions', 'games', 'software_tools', 'knowledge_pay', 'music_membership', 'reading_membership', 'ai_tools', 'cloud_service', 'productivity_software', 'member_software'] },
  { id: 'telecom', name: '通信缴费', categories: ['internet_tv', 'communication'] },
  { id: 'delivery', name: '快递物流', categories: ['express_postage'] },
] as const;
export type PayeeSceneId = typeof PAYEE_SCENES[number]['id'];
export interface PlatformEntry {
  id: string; name: string; aliases: string[]; scenes: PayeeSceneId[]; categories?: string[];
}
const platform = (id: string, name: string, aliases: string[], scenes: PayeeSceneId[], categories?: string[]): PlatformEntry => ({ id, name, aliases, scenes, categories });
export const PLATFORM_CATALOG: PlatformEntry[] = [
  platform('taobao', '淘宝', ['taobao'], ['shopping']),
  platform('jd', '京东', ['jd', 'jingdong'], ['shopping']),
  platform('tmall', '天猫', ['tmall'], ['shopping']),
  platform('pinduoduo', '拼多多', ['pdd', 'pinduoduo'], ['shopping']),
  platform('douyin-shop', '抖音商城', ['抖音电商'], ['shopping']),
  platform('xianyu', '闲鱼', ['xianyu'], ['shopping'], ['second_hand_purchase']),
  platform('dangdang', '当当', ['当当网', 'dangdang'], ['shopping'], ['books', 'stationery']),
  platform('meituan', '美团', ['美团外卖', 'meituan'], ['food', 'travel']),
  platform('taobao-instant', '淘宝闪购', ['饿了么', 'eleme', 'taobaoshangou'], ['food', 'fresh']),
  platform('dianping', '大众点评', ['点评', 'dianping'], ['food']),
  platform('hema', '盒马', ['盒马鲜生', 'hema'], ['fresh']),
  platform('sams', '山姆', ['山姆会员商店', 'sam'], ['fresh']),
  platform('dingdong', '叮咚买菜', ['dingdong'], ['fresh']),
  platform('didi', '滴滴出行', ['滴滴', 'didi'], ['ride'], ['taxi_ride', 'taxi', 'designated_driver']),
  platform('amap', '高德打车', ['高德叫车'], ['ride'], ['taxi_ride', 'taxi']),
  platform('hello', '哈啰', ['哈啰出行', '哈啰单车', 'hello'], ['ride'], ['taxi_ride', 'bike_ebike', 'shared_ebike']),
  platform('shenzhou', '神州租车', ['神州'], ['ride', 'travel'], ['car_rental']),
  platform('ctrip', '携程', ['携程旅行', 'ctrip'], ['travel']),
  platform('fliggy', '飞猪', ['飞猪旅行', 'fliggy'], ['travel']),
  platform('12306', '铁路12306', ['12306', '铁路'], ['travel'], ['train_flight']),
  platform('damai', '大麦', ['大麦网', 'damai'], ['tickets']),
  platform('maoyan', '猫眼', ['猫眼电影', '猫眼演出', 'maoyan'], ['tickets']),
  platform('taopiaopiao', '淘票票', ['taopiaopiao'], ['tickets'], ['movies']),
  platform('iqiyi', '爱奇艺', ['iqiyi'], ['digital'], ['subscriptions']),
  platform('tencent-video', '腾讯视频', ['腾讯视频会员'], ['digital'], ['subscriptions']),
  platform('bilibili', '哔哩哔哩', ['B站', 'bilibili'], ['digital'], ['subscriptions', 'knowledge_pay']),
  platform('netease-music', '网易云音乐', ['网易云'], ['digital'], ['music_membership', 'subscriptions']),
  platform('steam', 'Steam', ['steam平台'], ['digital'], ['games']),
  platform('app-store', 'App Store', ['苹果应用商店'], ['digital'], ['games', 'software_tools', 'productivity_software', 'member_software']),
  platform('china-mobile', '中国移动', ['移动', '10086'], ['telecom']),
  platform('china-unicom', '中国联通', ['联通', '10010'], ['telecom']),
  platform('china-telecom', '中国电信', ['电信', '10000'], ['telecom']),
  platform('sf', '顺丰', ['顺丰速运', 'sf'], ['delivery']),
  platform('jd-logistics', '京东物流', ['京东快递'], ['delivery']),
  platform('cainiao', '菜鸟', ['菜鸟裹裹'], ['delivery']),
  platform('ems', '中国邮政', ['邮政', 'EMS'], ['delivery']),
];
export const normalizedPayeeName = (name: string) => name.trim().toLocaleLowerCase();
export const catalogPayeeId = (entry: PlatformEntry) => `platform-payee:${entry.id}`;
export function findPlatform(name: string): PlatformEntry | undefined {
  const key = normalizedPayeeName(name);
  return PLATFORM_CATALOG.find((entry) => [entry.name, ...entry.aliases].some((item) => normalizedPayeeName(item) === key));
}
export function matchingPayee(payees: Payee[], name: string, entry = findPlatform(name)): Payee | undefined {
  const keys = new Set([name, ...(entry ? [entry.name, ...entry.aliases] : [])].map(normalizedPayeeName));
  return payees.find((payee) => entry && payee.id === catalogPayeeId(entry))
    ?? payees.find((payee) => [payee.name, ...(payee.aliases ?? [])].some((item) => keys.has(normalizedPayeeName(item))));
}
export function relatedPlatforms(categoryId: string, categories: Category[] = []): PlatformEntry[] {
  // Custom children can inherit an explicitly mapped ancestor; never infer from display names.
  const ids = new Set<string>();
  let id: string | undefined = categoryId;
  while (id && !ids.has(id)) { ids.add(id); id = categories.find((row) => row.id === id)?.parentId; }
  const scenes = PAYEE_SCENES.filter((scene) => scene.categories.some((key) => ids.has(key)));
  return PLATFORM_CATALOG.filter((entry) => entry.scenes.some((scene) => scenes.some((row) => row.id === scene))
    && (!entry.categories || entry.categories.some((key) => ids.has(key))));
}
