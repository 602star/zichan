import type { Category, TransactionCategory, TransactionCategoryType, TransactionType } from './types.js';

export const TYPE_LABEL: Record<TransactionType, string> = {
  income: '收入',
  expense: '支出',
  transfer: '转账',
  refund: '退款',
  adjustment: '余额调整',
};

export type BuiltInCategory = Pick<Category, 'id' | 'name' | 'type' | 'parentId' | 'color' | 'sortOrder' | 'budgetable' | 'isActive'> & {
  hidden?: boolean;
};

export type CategoryPackId =
  | 'vehicle'
  | 'pet'
  | 'parenting'
  | 'student'
  | 'travel'
  | 'investment'
  | 'renovation'
  | 'freelance'
  | 'health'
  | 'insurance_tax'
  | 'social'
  | 'leisure';

export interface CategoryPack {
  id: CategoryPackId;
  name: string;
  description: string;
  /**
   * 扩展分类 id（目录里默认未启用的可选分类）。
   *
   * 默认启用的分类永远不在此列：它们由账本初始化直接落库，既不需要扩展包
   * 补齐，也不允许被扩展包停用。一个分类可以同时属于多个扩展包（如 租车 同属
   * 「车主」与「旅行」），停用时由调用方按引用关系保留。
   */
  categoryIds: readonly string[];
}

export type CatalogCategory = Category & {
  /** Runtime-only marker. Catalog-only rows are not persisted until enabled. */
  catalogOnly?: boolean;
};

const parentCategory = (id: string, name: string, type: TransactionCategoryType, color: string, sortOrder: number): BuiltInCategory => ({
  id,
  name,
  type,
  color,
  sortOrder,
  budgetable: false,
  isActive: true,
});

const childCategory = (
  id: string,
  name: string,
  type: TransactionCategoryType,
  parentId: string,
  color: string,
  sortOrder: number,
  hidden = false,
): BuiltInCategory => ({
  id,
  name,
  type,
  parentId,
  color,
  sortOrder,
  budgetable: type === 'expense',
  isActive: true,
  hidden,
});

export function storedCategory(category: BuiltInCategory): Pick<Category, 'id' | 'name' | 'type' | 'parentId' | 'color' | 'sortOrder' | 'budgetable' | 'isHidden' | 'isActive'> {
  const { hidden, ...stored } = category;
  return { ...stored, isHidden: hidden === true };
}

export const SYSTEM_CATEGORY_CATALOG: BuiltInCategory[] = [
  parentCategory('expense_food', '食品餐饮', 'expense', '#f97316', 10),
  childCategory('groceries', '买菜食材', 'expense', 'expense_food', '#65a30d', 11),
  childCategory('takeaway', '外卖', 'expense', 'expense_food', '#ea580c', 12),
  childCategory('food', '堂食餐饮', 'expense', 'expense_food', '#f97316', 13),
  childCategory('coffee_drinks', '咖啡奶茶', 'expense', 'expense_food', '#c2410c', 14),
  childCategory('snacks_fruit', '零食水果', 'expense', 'expense_food', '#f59e0b', 15),
  childCategory('dining_out', '聚餐请客', 'expense', 'expense_food', '#dc2626', 16),
  childCategory('other_food', '其他餐饮', 'expense', 'expense_food', '#fdba74', 17),
  childCategory('breakfast', '早餐', 'expense', 'expense_food', '#fb923c', 18, true),
  childCategory('lunch_work_meal', '午餐/工作餐', 'expense', 'expense_food', '#fb923c', 19, true),
  childCategory('dinner', '晚餐', 'expense', 'expense_food', '#fb923c', 20, true),
  childCategory('canteen', '食堂', 'expense', 'expense_food', '#fb923c', 21, true),
  childCategory('late_night_snack', '夜宵', 'expense', 'expense_food', '#fb923c', 22, true),
  childCategory('alcohol_drinks', '酒水饮料', 'expense', 'expense_food', '#f97316', 23, true),
  childCategory('bakery_dessert', '烘焙甜品', 'expense', 'expense_food', '#f97316', 24, true),
  childCategory('seasoning_grain_oil', '调味粮油', 'expense', 'expense_food', '#65a30d', 25, true),
  childCategory('fresh_delivery', '生鲜配送', 'expense', 'expense_food', '#65a30d', 26, true),
  childCategory('group_buy_food', '团购餐饮', 'expense', 'expense_food', '#ea580c', 27, true),
  childCategory('company_dinner', '公司聚餐', 'expense', 'expense_food', '#dc2626', 28, true),
  childCategory('buffet', '自助餐', 'expense', 'expense_food', '#dc2626', 29, true),
  childCategory('prepared_food', '预制菜', 'expense', 'expense_food', '#65a30d', 30, true),
  childCategory('kids_food', '儿童食品', 'expense', 'expense_food', '#f59e0b', 31, true),

  parentCategory('expense_transport', '交通出行', 'expense', '#0284c7', 40),
  childCategory('transport', '公交地铁', 'expense', 'expense_transport', '#0284c7', 41),
  childCategory('taxi_ride', '打车/网约车', 'expense', 'expense_transport', '#0ea5e9', 42),
  childCategory('train_flight', '火车高铁', 'expense', 'expense_transport', '#2563eb', 43),
  childCategory('flight', '飞机', 'expense', 'expense_transport', '#1d4ed8', 44),
  childCategory('fuel', '加油/充电', 'expense', 'expense_transport', '#0369a1', 45),
  childCategory('parking', '停车过路', 'expense', 'expense_transport', '#38bdf8', 46),
  childCategory('car_maintenance', '车辆保养', 'expense', 'expense_transport', '#075985', 47),
  childCategory('other_transport', '其他交通', 'expense', 'expense_transport', '#67e8f9', 48),
  childCategory('bike_ebike', '共享单车', 'expense', 'expense_transport', '#0891b2', 49, true),
  childCategory('shared_ebike', '共享电动车', 'expense', 'expense_transport', '#0891b2', 50, true),
  childCategory('taxi', '出租车', 'expense', 'expense_transport', '#0ea5e9', 51, true),
  childCategory('designated_driver', '代驾', 'expense', 'expense_transport', '#0ea5e9', 52, true),
  childCategory('car_rental', '租车', 'expense', 'expense_transport', '#0284c7', 53, true),
  childCategory('coach', '长途客运', 'expense', 'expense_transport', '#2563eb', 54, true),
  childCategory('ferry', '轮渡', 'expense', 'expense_transport', '#2563eb', 55, true),
  childCategory('etc_recharge', 'ETC充值', 'expense', 'expense_transport', '#38bdf8', 56, true),
  childCategory('highway_toll', '高速过路费', 'expense', 'expense_transport', '#38bdf8', 57, true),
  childCategory('car_wash', '洗车美容', 'expense', 'expense_transport', '#075985', 58, true),
  childCategory('car_repair', '车辆维修', 'expense', 'expense_transport', '#075985', 59, true),
  childCategory('car_accessories', '车品配件', 'expense', 'expense_transport', '#075985', 60, true),
  childCategory('roadside_assistance', '道路救援', 'expense', 'expense_transport', '#075985', 61, true),
  childCategory('car_insurance', '汽车保险', 'expense', 'expense_transport', '#075985', 62, true),
  childCategory('vehicle_inspection', '车辆年检', 'expense', 'expense_transport', '#075985', 63, true),
  childCategory('traffic_fine', '违章罚款', 'expense', 'expense_transport', '#dc2626', 64, true),
  childCategory('driving_school', '驾校学车', 'expense', 'expense_transport', '#0284c7', 65, true),
  childCategory('license_renewal', '驾照换证', 'expense', 'expense_transport', '#0284c7', 66, true),

  parentCategory('expense_shopping', '购物消费', 'expense', '#a855f7', 80),
  childCategory('clothing', '服饰鞋包', 'expense', 'expense_shopping', '#7c3aed', 81),
  childCategory('beauty', '美妆护肤', 'expense', 'expense_shopping', '#c026d3', 82),
  childCategory('digital_goods', '数码电子', 'expense', 'expense_shopping', '#4f46e5', 83),
  childCategory('shopping', '日用百货', 'expense', 'expense_shopping', '#a855f7', 84),
  childCategory('mother_baby', '母婴用品', 'expense', 'expense_shopping', '#d946ef', 85),
  childCategory('express_postage', '快递邮寄', 'expense', 'expense_shopping', '#8b5cf6', 86),
  childCategory('other_shopping', '其他购物', 'expense', 'expense_shopping', '#c084fc', 87),
  childCategory('underwear_socks', '内衣袜子', 'expense', 'expense_shopping', '#7c3aed', 88, true),
  childCategory('accessories', '饰品配件', 'expense', 'expense_shopping', '#7c3aed', 89, true),
  childCategory('luggage_bags', '箱包', 'expense', 'expense_shopping', '#7c3aed', 90, true),
  childCategory('jewelry', '珠宝首饰', 'expense', 'expense_shopping', '#7c3aed', 91, true),
  childCategory('sports_equipment', '运动装备', 'expense', 'expense_shopping', '#7c3aed', 92, true),
  childCategory('outdoor_equipment', '户外装备', 'expense', 'expense_shopping', '#7c3aed', 93, true),
  childCategory('camera_equipment', '摄影设备', 'expense', 'expense_shopping', '#4f46e5', 94, true),
  childCategory('computer_accessories', '电脑配件', 'expense', 'expense_shopping', '#4f46e5', 95, true),
  childCategory('phone_accessories', '手机配件', 'expense', 'expense_shopping', '#4f46e5', 96, true),
  childCategory('office_supplies', '办公用品', 'expense', 'expense_shopping', '#a855f7', 97, true),
  childCategory('flowers_plants', '鲜花绿植', 'expense', 'expense_shopping', '#a855f7', 98, true),
  childCategory('gifts', '礼品包装', 'expense', 'expense_shopping', '#db2777', 99, true),
  childCategory('membership_card_topup', '会员卡充值', 'expense', 'expense_shopping', '#a855f7', 100, true),
  childCategory('designer_toys', '潮玩收藏', 'expense', 'expense_shopping', '#db2777', 101, true),
  childCategory('anime_goods', '二次元周边', 'expense', 'expense_shopping', '#db2777', 102, true),
  childCategory('blind_box', '盲盒', 'expense', 'expense_shopping', '#db2777', 103, true),
  childCategory('purchasing_agent', '代购', 'expense', 'expense_shopping', '#8b5cf6', 104, true),
  childCategory('overseas_shopping', '海淘', 'expense', 'expense_shopping', '#8b5cf6', 105, true),
  childCategory('second_hand_purchase', '二手购买', 'expense', 'expense_shopping', '#8b5cf6', 106, true),
  childCategory('repair_parts', '维修配件', 'expense', 'expense_shopping', '#8b5cf6', 107, true),

  parentCategory('expense_home', '居家生活', 'expense', '#0f766e', 120),
  childCategory('housing', '房租', 'expense', 'expense_home', '#0f766e', 121),
  childCategory('mortgage', '房贷月供', 'expense', 'expense_home', '#0f766e', 122),
  childCategory('utilities', '水电燃气', 'expense', 'expense_home', '#0284c7', 123),
  childCategory('property_management', '物业管理', 'expense', 'expense_home', '#14b8a6', 124),
  childCategory('internet_tv', '宽带话费', 'expense', 'expense_home', '#64748b', 125),
  childCategory('furniture_appliance', '家具家装', 'expense', 'expense_home', '#059669', 126),
  childCategory('home_repair', '家政维修', 'expense', 'expense_home', '#10b981', 127),
  childCategory('pet', '宠物', 'expense', 'expense_home', '#8b5cf6', 128),
  childCategory('other_home', '其他居家', 'expense', 'expense_home', '#5eead4', 129),
  childCategory('deposit', '押金', 'expense', 'expense_home', '#0f766e', 130, true),
  childCategory('rental_agent_fee', '租房中介费', 'expense', 'expense_home', '#0f766e', 131, true),
  childCategory('heating_fee', '取暖费', 'expense', 'expense_home', '#0284c7', 132, true),
  childCategory('garbage_fee', '垃圾处理费', 'expense', 'expense_home', '#0284c7', 133, true),
  childCategory('communication', '有线电视费', 'expense', 'expense_home', '#64748b', 134, true),
  childCategory('maintenance_fund', '维修基金', 'expense', 'expense_home', '#0f766e', 135, true),
  childCategory('locks_keys', '门锁钥匙', 'expense', 'expense_home', '#059669', 136, true),
  childCategory('security_monitoring', '安防监控', 'expense', 'expense_home', '#059669', 137, true),
  childCategory('renovation_materials', '家装建材', 'expense', 'expense_home', '#059669', 138, true),
  childCategory('soft_decoration', '软装装饰', 'expense', 'expense_home', '#059669', 139, true),
  childCategory('kitchenware', '厨具餐具', 'expense', 'expense_home', '#059669', 140, true),
  childCategory('home_goods', '清洁用品', 'expense', 'expense_home', '#10b981', 141, true),
  childCategory('storage_supplies', '收纳用品', 'expense', 'expense_home', '#10b981', 142, true),
  childCategory('bedding', '床上用品', 'expense', 'expense_home', '#10b981', 143, true),
  childCategory('gardening', '绿植园艺', 'expense', 'expense_home', '#10b981', 144, true),
  childCategory('pest_control', '虫害消杀', 'expense', 'expense_home', '#10b981', 145, true),
  childCategory('moving_storage', '搬家仓储', 'expense', 'expense_home', '#10b981', 146, true),
  childCategory('pet_food', '宠物食品', 'expense', 'expense_home', '#8b5cf6', 147, true),
  childCategory('pet_supplies', '宠物用品', 'expense', 'expense_home', '#8b5cf6', 148, true),
  childCategory('pet_medical', '宠物医疗', 'expense', 'expense_home', '#8b5cf6', 149, true),
  childCategory('pet_grooming', '宠物美容', 'expense', 'expense_home', '#8b5cf6', 150, true),
  childCategory('pet_boarding', '宠物寄养', 'expense', 'expense_home', '#8b5cf6', 151, true),
  childCategory('pet_insurance', '宠物保险', 'expense', 'expense_home', '#8b5cf6', 152, true),

  parentCategory('expense_health', '医疗健康', 'expense', '#dc2626', 170),
  childCategory('healthcare', '挂号诊疗', 'expense', 'expense_health', '#dc2626', 171),
  childCategory('medicine', '药品', 'expense', 'expense_health', '#ef4444', 172),
  childCategory('wellness', '体检', 'expense', 'expense_health', '#f43f5e', 173),
  childCategory('dental', '牙科', 'expense', 'expense_health', '#ef4444', 174),
  childCategory('hospital_surgery', '住院手术', 'expense', 'expense_health', '#b91c1c', 175),
  childCategory('counseling', '心理咨询', 'expense', 'expense_health', '#be123c', 176),
  childCategory('fitness', '健身运动', 'expense', 'expense_health', '#16a34a', 177),
  childCategory('other_health', '其他医疗', 'expense', 'expense_health', '#f87171', 178),
  childCategory('lab_tests', '检查化验', 'expense', 'expense_health', '#dc2626', 179, true),
  childCategory('vaccine', '疫苗', 'expense', 'expense_health', '#dc2626', 180, true),
  childCategory('traditional_medicine', '中医', 'expense', 'expense_health', '#dc2626', 181, true),
  childCategory('physiotherapy', '理疗按摩', 'expense', 'expense_health', '#dc2626', 182, true),
  childCategory('acupuncture', '针灸推拿', 'expense', 'expense_health', '#dc2626', 183, true),
  childCategory('gynecology', '妇科', 'expense', 'expense_health', '#ef4444', 184, true),
  childCategory('pediatrics', '儿科', 'expense', 'expense_health', '#ef4444', 185, true),
  childCategory('dermatology', '皮肤科', 'expense', 'expense_health', '#ef4444', 186, true),
  childCategory('orthodontics', '口腔正畸', 'expense', 'expense_health', '#ef4444', 187, true),
  childCategory('glasses_contacts', '眼镜隐形', 'expense', 'expense_health', '#ef4444', 188, true),
  childCategory('hearing_aid', '助听器', 'expense', 'expense_health', '#ef4444', 189, true),
  childCategory('chronic_medicine', '慢病用药', 'expense', 'expense_health', '#ef4444', 190, true),
  childCategory('prescription_medicine', '处方药', 'expense', 'expense_health', '#ef4444', 191, true),
  childCategory('otc_medicine', '非处方药', 'expense', 'expense_health', '#ef4444', 192, true),
  childCategory('supplements', '营养补剂', 'expense', 'expense_health', '#16a34a', 193, true),
  childCategory('rehab_equipment', '康复器材', 'expense', 'expense_health', '#16a34a', 194, true),
  childCategory('care_supplies', '护理用品', 'expense', 'expense_health', '#16a34a', 195, true),
  childCategory('medical_beauty', '医美', 'expense', 'expense_health', '#f43f5e', 196, true),
  childCategory('nursing_care', '陪护费', 'expense', 'expense_health', '#b91c1c', 197, true),
  childCategory('ambulance', '救护车', 'expense', 'expense_health', '#b91c1c', 198, true),
  childCategory('maternity', '产检生育', 'expense', 'expense_health', '#ef4444', 199, true),

  parentCategory('expense_learning', '学习成长', 'expense', '#2563eb', 220),
  childCategory('education', '课程培训', 'expense', 'expense_learning', '#2563eb', 221),
  childCategory('books', '图书教材', 'expense', 'expense_learning', '#1d4ed8', 222),
  childCategory('exams', '考试认证', 'expense', 'expense_learning', '#3b82f6', 223),
  childCategory('knowledge_pay', '知识付费', 'expense', 'expense_learning', '#60a5fa', 224),
  childCategory('stationery', '文具耗材', 'expense', 'expense_learning', '#93c5fd', 225),
  childCategory('software_tools', '软件工具', 'expense', 'expense_learning', '#6366f1', 226),
  childCategory('other_learning', '其他学习', 'expense', 'expense_learning', '#93c5fd', 227),
  childCategory('tuition', '学费', 'expense', 'expense_learning', '#2563eb', 228, true),
  childCategory('language_learning', '语言学习', 'expense', 'expense_learning', '#2563eb', 229, true),
  childCategory('skill_training', '技能培训', 'expense', 'expense_learning', '#2563eb', 230, true),
  childCategory('programming_learning', '编程学习', 'expense', 'expense_learning', '#2563eb', 231, true),
  childCategory('grad_civil_exam', '考研考公', 'expense', 'expense_learning', '#3b82f6', 232, true),
  childCategory('qualification_certificate', '资格证书', 'expense', 'expense_learning', '#3b82f6', 233, true),
  childCategory('interest_course', '兴趣课程', 'expense', 'expense_learning', '#2563eb', 234, true),
  childCategory('online_course', '线上课程', 'expense', 'expense_learning', '#2563eb', 235, true),
  childCategory('offline_training', '线下培训', 'expense', 'expense_learning', '#2563eb', 236, true),
  childCategory('tutoring_class', '补习班', 'expense', 'expense_learning', '#2563eb', 237, true),
  childCategory('after_school_care', '托管班', 'expense', 'expense_learning', '#2563eb', 238, true),
  childCategory('summer_camp', '夏令营', 'expense', 'expense_learning', '#2563eb', 239, true),
  childCategory('study_trip', '研学', 'expense', 'expense_learning', '#2563eb', 240, true),
  childCategory('paper_check', '论文查重', 'expense', 'expense_learning', '#60a5fa', 241, true),
  childCategory('print_copy', '打印复印', 'expense', 'expense_learning', '#93c5fd', 242, true),
  childCategory('learning_device', '学习设备', 'expense', 'expense_learning', '#6366f1', 243, true),
  childCategory('material_subscription', '订阅资料', 'expense', 'expense_learning', '#60a5fa', 244, true),
  childCategory('ai_tools', 'AI工具', 'expense', 'expense_learning', '#6366f1', 245, true),
  childCategory('cloud_service', '云服务', 'expense', 'expense_learning', '#6366f1', 246, true),
  childCategory('productivity_software', '效率软件', 'expense', 'expense_learning', '#6366f1', 247, true),
  childCategory('member_software', '会员软件', 'expense', 'expense_learning', '#6366f1', 248, true),
  childCategory('overseas_study', '留学游学', 'expense', 'expense_learning', '#2563eb', 249, true),
  childCategory('children_education', '子女教育', 'expense', 'expense_learning', '#2563eb', 250, true),

  parentCategory('expense_entertainment', '休闲娱乐', 'expense', '#db2777', 270),
  childCategory('subscriptions', '影音会员', 'expense', 'expense_entertainment', '#f97316', 271),
  childCategory('movies', '电影演出', 'expense', 'expense_entertainment', '#be185d', 272),
  childCategory('games', '游戏', 'expense', 'expense_entertainment', '#9333ea', 273),
  childCategory('travel', '旅行度假', 'expense', 'expense_entertainment', '#0d9488', 274),
  childCategory('hotel', '酒店住宿', 'expense', 'expense_entertainment', '#0d9488', 275),
  childCategory('tickets', '景点门票', 'expense', 'expense_entertainment', '#0d9488', 276),
  childCategory('entertainment', '兴趣爱好', 'expense', 'expense_entertainment', '#db2777', 277),
  childCategory('other_entertainment', '其他娱乐', 'expense', 'expense_entertainment', '#f9a8d4', 278),
  childCategory('music_membership', '音乐会员', 'expense', 'expense_entertainment', '#f97316', 279, true),
  childCategory('reading_membership', '阅读会员', 'expense', 'expense_entertainment', '#f97316', 280, true),
  childCategory('ktv', 'KTV', 'expense', 'expense_entertainment', '#be185d', 281, true),
  childCategory('bar', '酒吧', 'expense', 'expense_entertainment', '#be185d', 282, true),
  childCategory('script_murder', '剧本杀', 'expense', 'expense_entertainment', '#be185d', 283, true),
  childCategory('escape_room', '密室逃脱', 'expense', 'expense_entertainment', '#be185d', 284, true),
  childCategory('board_game', '桌游', 'expense', 'expense_entertainment', '#be185d', 285, true),
  childCategory('chess_card', '棋牌', 'expense', 'expense_entertainment', '#be185d', 286, true),
  childCategory('live_tipping', '直播打赏', 'expense', 'expense_entertainment', '#db2777', 287, true),
  childCategory('short_video_tipping', '短视频打赏', 'expense', 'expense_entertainment', '#db2777', 288, true),
  childCategory('concert', '演唱会', 'expense', 'expense_entertainment', '#be185d', 289, true),
  childCategory('music_festival', '音乐节', 'expense', 'expense_entertainment', '#be185d', 290, true),
  childCategory('exhibition', '展览', 'expense', 'expense_entertainment', '#be185d', 291, true),
  childCategory('museum', '博物馆', 'expense', 'expense_entertainment', '#be185d', 292, true),
  childCategory('amusement_park', '游乐园', 'expense', 'expense_entertainment', '#0d9488', 293, true),
  childCategory('hot_spring_bath', '温泉洗浴', 'expense', 'expense_entertainment', '#0d9488', 294, true),
  childCategory('camping', '露营', 'expense', 'expense_entertainment', '#0d9488', 295, true),
  childCategory('skiing', '滑雪', 'expense', 'expense_entertainment', '#0d9488', 296, true),
  childCategory('diving', '潜水', 'expense', 'expense_entertainment', '#0d9488', 297, true),
  childCategory('personal_training', '健身私教', 'expense', 'expense_entertainment', '#db2777', 298, true),
  childCategory('yoga_dance', '瑜伽舞蹈', 'expense', 'expense_entertainment', '#db2777', 299, true),
  childCategory('ball_sports', '球类运动', 'expense', 'expense_entertainment', '#db2777', 300, true),
  childCategory('photography_travel', '摄影旅行', 'expense', 'expense_entertainment', '#0d9488', 301, true),
  childCategory('travel_shopping', '旅游购物', 'expense', 'expense_entertainment', '#0d9488', 302, true),
  childCategory('souvenirs', '纪念品', 'expense', 'expense_entertainment', '#0d9488', 303, true),

  parentCategory('expense_family', '家庭人情', 'expense', '#e11d48', 320),
  childCategory('parents', '父母', 'expense', 'expense_family', '#f43f5e', 321),
  childCategory('children', '子女', 'expense', 'expense_family', '#fb7185', 322),
  childCategory('red_packet', '红包礼金', 'expense', 'expense_family', '#dc2626', 323),
  childCategory('wedding_funeral', '婚丧嫁娶', 'expense', 'expense_family', '#dc2626', 324),
  childCategory('festival_gifts', '节日礼物', 'expense', 'expense_family', '#f43f5e', 325),
  childCategory('social', '请客送礼', 'expense', 'expense_family', '#e11d48', 326),
  childCategory('donation', '慈善捐赠', 'expense', 'expense_family', '#be123c', 327),
  childCategory('other_family', '其他人情', 'expense', 'expense_family', '#fda4af', 328),
  childCategory('filial_support', '孝敬父母', 'expense', 'expense_family', '#f43f5e', 329, true),
  childCategory('alimony', '赡养费', 'expense', 'expense_family', '#f43f5e', 330, true),
  childCategory('childcare', '育儿支出', 'expense', 'expense_family', '#fb7185', 331, true),
  childCategory('partner_family', '伴侣家庭', 'expense', 'expense_family', '#f43f5e', 332, true),
  childCategory('birthday_gift', '生日礼物', 'expense', 'expense_family', '#f43f5e', 333, true),
  childCategory('baby_full_month', '满月/百日', 'expense', 'expense_family', '#fb7185', 334, true),
  childCategory('school_gift', '升学礼', 'expense', 'expense_family', '#fb7185', 335, true),
  childCategory('housewarming_gift', '乔迁礼', 'expense', 'expense_family', '#f43f5e', 336, true),
  childCategory('hospital_visit', '探病慰问', 'expense', 'expense_family', '#f43f5e', 337, true),
  childCategory('funeral_expense', '丧葬白事', 'expense', 'expense_family', '#dc2626', 338, true),
  childCategory('wedding_gift_money', '婚礼份子钱', 'expense', 'expense_family', '#dc2626', 339, true),
  childCategory('lucky_money', '压岁钱', 'expense', 'expense_family', '#dc2626', 340, true),
  childCategory('red_packet_transfer', '红包转账', 'expense', 'expense_family', '#dc2626', 341, true),
  childCategory('family_loan', '亲属借款', 'expense', 'expense_family', '#e11d48', 342, true),
  childCategory('friend_loan', '朋友借款', 'expense', 'expense_family', '#e11d48', 343, true),
  childCategory('family_fund', '家庭共同基金', 'expense', 'expense_family', '#e11d48', 344, true),
  childCategory('aa_settlement', 'AA收付', 'expense', 'expense_family', '#e11d48', 345, true),
  childCategory('family_dinner', '家庭聚餐', 'expense', 'expense_family', '#e11d48', 346, true),
  childCategory('family_visit_transport', '探亲交通', 'expense', 'expense_family', '#e11d48', 347, true),
  childCategory('festival_filial', '节日孝敬', 'expense', 'expense_family', '#f43f5e', 348, true),

  parentCategory('expense_finance', '金融税费', 'expense', '#64748b', 370),
  childCategory('bank_fee', '手续费', 'expense', 'expense_finance', '#64748b', 371),
  childCategory('insurance', '保险', 'expense', 'expense_finance', '#b91c1c', 372),
  childCategory('loan_interest', '贷款利息', 'expense', 'expense_finance', '#475569', 373),
  childCategory('tax', '个税', 'expense', 'expense_finance', '#334155', 374),
  childCategory('social_security_housing_fund', '社保公积金', 'expense', 'expense_finance', '#475569', 375),
  childCategory('credit_card_annual_fee', '信用卡年费', 'expense', 'expense_finance', '#64748b', 376),
  childCategory('investment_fee', '投资手续费', 'expense', 'expense_finance', '#0f172a', 377),
  childCategory('other_finance', '其他金融税费', 'expense', 'expense_finance', '#94a3b8', 378),
  childCategory('bank_service_fee', '银行手续费', 'expense', 'expense_finance', '#64748b', 379, true),
  childCategory('payment_fee', '支付手续费', 'expense', 'expense_finance', '#64748b', 380, true),
  childCategory('interbank_fee', '跨行手续费', 'expense', 'expense_finance', '#64748b', 381, true),
  childCategory('account_management_fee', '账户管理费', 'expense', 'expense_finance', '#64748b', 382, true),
  childCategory('credit_card_interest', '信用卡利息', 'expense', 'expense_finance', '#475569', 383, true),
  childCategory('minimum_payment_interest', '最低还款利息', 'expense', 'expense_finance', '#475569', 384, true),
  childCategory('withdrawal_fee', '提现手续费', 'expense', 'expense_finance', '#64748b', 385, true),
  childCategory('installment_fee', '分期手续费', 'expense', 'expense_finance', '#64748b', 386, true),
  childCategory('fund_subscription_fee', '基金申购费', 'expense', 'expense_finance', '#0f172a', 387, true),
  childCategory('fund_redemption_fee', '基金赎回费', 'expense', 'expense_finance', '#0f172a', 388, true),
  childCategory('stock_commission', '股票佣金', 'expense', 'expense_finance', '#0f172a', 389, true),
  childCategory('stamp_tax', '印花税', 'expense', 'expense_finance', '#334155', 390, true),
  childCategory('margin_interest', '融资利息', 'expense', 'expense_finance', '#475569', 391, true),
  childCategory('auto_insurance', '车险', 'expense', 'expense_finance', '#b91c1c', 392, true),
  childCategory('life_insurance', '寿险', 'expense', 'expense_finance', '#b91c1c', 393, true),
  childCategory('critical_illness_insurance', '重疾险', 'expense', 'expense_finance', '#b91c1c', 394, true),
  childCategory('medical_insurance', '医疗险', 'expense', 'expense_finance', '#b91c1c', 395, true),
  childCategory('accident_insurance', '意外险', 'expense', 'expense_finance', '#b91c1c', 396, true),
  childCategory('property_insurance', '财产险', 'expense', 'expense_finance', '#b91c1c', 397, true),
  childCategory('property_tax', '房产税', 'expense', 'expense_finance', '#334155', 398, true),
  childCategory('deed_tax', '契税', 'expense', 'expense_finance', '#334155', 399, true),
  childCategory('vat', '增值税', 'expense', 'expense_finance', '#334155', 400, true),
  childCategory('late_fee', '滞纳金', 'expense', 'expense_finance', '#dc2626', 401, true),
  childCategory('penalty_interest', '罚息', 'expense', 'expense_finance', '#dc2626', 402, true),
  childCategory('remittance_fee', '汇款手续费', 'expense', 'expense_finance', '#64748b', 403, true),
  childCategory('fx_exchange_fee', '外币兑换手续费', 'expense', 'expense_finance', '#64748b', 404, true),
  childCategory('fx_gain_loss', '汇兑损益', 'expense', 'expense_finance', '#64748b', 405, true),

  parentCategory('expense_misc', '其他支出', 'expense', '#78716c', 430),
  childCategory('uncategorized', '待分类', 'expense', 'expense_misc', '#78716c', 431),
  childCategory('unknown_expense', '不明支出', 'expense', 'expense_misc', '#78716c', 432),
  childCategory('temporary_misc', '临时杂项', 'expense', 'expense_misc', '#78716c', 433),
  childCategory('other_expense', '其他', 'expense', 'expense_misc', '#78716c', 434),
  childCategory('compensation_expense', '赔偿支出', 'expense', 'expense_misc', '#a16207', 435, true),
  childCategory('lost_damage', '物品丢失', 'expense', 'expense_misc', '#a16207', 436, true),
  childCategory('damage_compensation', '损坏赔付', 'expense', 'expense_misc', '#a16207', 437, true),
  childCategory('public_donation', '公益捐赠', 'expense', 'expense_misc', '#be123c', 438, true),
  childCategory('religious_expense', '宗教支出', 'expense', 'expense_misc', '#78716c', 439, true),
  childCategory('temporary_advance', '临时垫付', 'expense', 'expense_misc', '#78716c', 440, true),
  childCategory('unrecognized_bill', '无法识别账单', 'expense', 'expense_misc', '#78716c', 441, true),
  childCategory('system_adjustment', '系统调整', 'expense', 'expense_misc', '#78716c', 442, true),
  childCategory('account_correction', '账目修正', 'expense', 'expense_misc', '#78716c', 443, true),
  childCategory('bad_debt_loss', '坏账损失', 'expense', 'expense_misc', '#78716c', 444, true),
  childCategory('business_expense', '特殊项目支出', 'expense', 'expense_misc', '#78716c', 445, true),
  // 通用罚款：行政/平台/民事处罚。交通违法有专门的「违章罚款」（在车主扩展包里），
  // 这一项覆盖与之无关的场景：乱扔垃圾、违规养犬、平台处罚、法院罚金……
  // 它是跨场景的通用支出，不属于任何场景扩展包，所以默认可用。
  childCategory('fine', '罚款', 'expense', 'expense_misc', '#dc2626', 446),

  parentCategory('income_work', '工作收入', 'income', '#16a34a', 500),
  childCategory('salary', '工资', 'income', 'income_work', '#16a34a', 501),
  childCategory('bonus', '奖金', 'income', 'income_work', '#22c55e', 502),
  childCategory('allowance', '补贴', 'income', 'income_work', '#84cc16', 503),
  childCategory('sidejob', '兼职副业', 'income', 'income_work', '#65a30d', 504),
  childCategory('project_income', '项目收入', 'income', 'income_work', '#15803d', 505),
  childCategory('reimbursement', '报销', 'income', 'income_work', '#0ea5e9', 506),
  childCategory('other_work_income', '其他工作收入', 'income', 'income_work', '#86efac', 507),
  childCategory('year_end_bonus', '年终奖', 'income', 'income_work', '#22c55e', 508, true),
  childCategory('thirteenth_salary', '十三薪', 'income', 'income_work', '#22c55e', 509, true),
  childCategory('project_bonus', '项目奖金', 'income', 'income_work', '#22c55e', 510, true),
  childCategory('commission', '销售提成', 'income', 'income_work', '#15803d', 511, true),
  childCategory('performance_salary', '绩效工资', 'income', 'income_work', '#22c55e', 512, true),
  childCategory('overtime_pay', '加班费', 'income', 'income_work', '#84cc16', 513, true),
  childCategory('position_allowance', '岗位津贴', 'income', 'income_work', '#84cc16', 514, true),
  childCategory('transport_allowance', '交通补贴', 'income', 'income_work', '#84cc16', 515, true),
  childCategory('meal_allowance', '餐补', 'income', 'income_work', '#84cc16', 516, true),
  childCategory('housing_allowance', '住房补贴', 'income', 'income_work', '#84cc16', 517, true),
  childCategory('heat_allowance', '高温补贴', 'income', 'income_work', '#84cc16', 518, true),
  childCategory('travel_allowance', '差旅补贴', 'income', 'income_work', '#84cc16', 519, true),
  childCategory('severance_pay', '离职补偿', 'income', 'income_work', '#16a34a', 520, true),
  childCategory('non_compete_compensation', '竞业补偿', 'income', 'income_work', '#16a34a', 521, true),
  childCategory('intern_salary', '实习工资', 'income', 'income_work', '#16a34a', 522, true),
  childCategory('labor_fee', '劳务费', 'income', 'income_work', '#65a30d', 523, true),
  childCategory('consulting_fee_income', '咨询费', 'income', 'income_work', '#65a30d', 524, true),
  childCategory('design_fee_income', '设计费', 'income', 'income_work', '#65a30d', 525, true),
  childCategory('development_fee_income', '开发费', 'income', 'income_work', '#65a30d', 526, true),
  childCategory('operation_income', '运营收入', 'income', 'income_work', '#65a30d', 527, true),
  childCategory('shop_income', '店铺收入', 'income', 'income_work', '#65a30d', 528, true),
  childCategory('media_income', '自媒体收入', 'income', 'income_work', '#65a30d', 529, true),
  childCategory('live_stream_income', '直播收入', 'income', 'income_work', '#65a30d', 530, true),
  childCategory('course_income', '课程收入', 'income', 'income_work', '#65a30d', 531, true),
  childCategory('royalty_income', '稿费版税', 'income', 'income_work', '#65a30d', 532, true),

  parentCategory('income_investment', '投资资产', 'income', '#059669', 560),
  childCategory('interest_income', '利息', 'income', 'income_investment', '#0d9488', 561),
  childCategory('investment_income', '理财收益', 'income', 'income_investment', '#059669', 562),
  childCategory('fund_dividend', '基金分红', 'income', 'income_investment', '#047857', 563),
  childCategory('dividend_income', '股票分红', 'income', 'income_investment', '#047857', 564),
  childCategory('rent_income', '房租收入', 'income', 'income_investment', '#0f766e', 565),
  childCategory('asset_sale_gain', '资产出售收益', 'income', 'income_investment', '#059669', 566),
  childCategory('other_investment_income', '其他投资收益', 'income', 'income_investment', '#6ee7b7', 567),
  childCategory('deposit_interest', '存款利息', 'income', 'income_investment', '#0d9488', 568, true),
  childCategory('stock_sale_gain', '股票卖出收益', 'income', 'income_investment', '#047857', 569, true),
  childCategory('fund_sale_gain', '基金卖出收益', 'income', 'income_investment', '#047857', 570, true),
  childCategory('bond_income', '债券收益', 'income', 'income_investment', '#059669', 571, true),
  childCategory('convertible_bond_income', '可转债收益', 'income', 'income_investment', '#059669', 572, true),
  childCategory('option_income', '期权收益', 'income', 'income_investment', '#059669', 573, true),
  childCategory('gold_income', '黄金收益', 'income', 'income_investment', '#ca8a04', 574, true),
  childCategory('forex_income', '外汇收益', 'income', 'income_investment', '#0d9488', 575, true),
  childCategory('digital_asset_income', '数字资产收益', 'income', 'income_investment', '#059669', 576, true),
  childCategory('reits_dividend', 'REITs分红', 'income', 'income_investment', '#047857', 577, true),
  childCategory('bank_wealth_income', '银行理财收益', 'income', 'income_investment', '#059669', 578, true),
  childCategory('trust_income', '信托收益', 'income', 'income_investment', '#059669', 579, true),
  childCategory('parking_rent_income', '车位出租', 'income', 'income_investment', '#0f766e', 580, true),
  childCategory('equipment_rent_income', '设备出租', 'income', 'income_investment', '#0f766e', 581, true),
  childCategory('copyright_income', '版权收入', 'income', 'income_investment', '#059669', 582, true),
  childCategory('patent_income', '专利收入', 'income', 'income_investment', '#059669', 583, true),
  childCategory('equity_dividend', '股权分红', 'income', 'income_investment', '#047857', 584, true),
  childCategory('company_dividend', '公司分红', 'income', 'income_investment', '#047857', 585, true),
  childCategory('asset_appreciation_gain', '资产增值收益', 'income', 'income_investment', '#059669', 586, true),

  parentCategory('income_other', '其他收入', 'income', '#65a30d', 620),
  childCategory('gift', '红包礼金', 'income', 'income_other', '#e11d48', 621),
  childCategory('refund', '退款退货', 'income', 'income_other', '#14b8a6', 622),
  childCategory('cashback', '返现优惠', 'income', 'income_other', '#f97316', 623),
  childCategory('sale_income', '二手出售', 'income', 'income_other', '#7c3aed', 624),
  childCategory('compensation_claim', '赔偿理赔', 'income', 'income_other', '#22c55e', 625),
  childCategory('government_subsidy', '政府补贴', 'income', 'income_other', '#84cc16', 626),
  childCategory('other_income', '其他收入', 'income', 'income_other', '#65a30d', 627),
  childCategory('family_transfer_in', '亲友转入', 'income', 'income_other', '#65a30d', 628, true),
  childCategory('parent_support', '父母资助', 'income', 'income_other', '#65a30d', 629, true),
  childCategory('partner_transfer_in', '伴侣转入', 'income', 'income_other', '#65a30d', 630, true),
  childCategory('lucky_money_income', '压岁钱', 'income', 'income_other', '#e11d48', 631, true),
  childCategory('lottery_income', '中奖', 'income', 'income_other', '#eab308', 632, true),
  childCategory('draw_cashback', '抽奖返现', 'income', 'income_other', '#f97316', 633, true),
  childCategory('platform_subsidy', '平台补贴', 'income', 'income_other', '#84cc16', 634, true),
  childCategory('coupon_cashback', '消费券返现', 'income', 'income_other', '#f97316', 635, true),
  childCategory('credit_card_cashback', '信用卡返现', 'income', 'income_other', '#f97316', 636, true),
  childCategory('points_redemption', '积分兑换', 'income', 'income_other', '#f97316', 637, true),
  childCategory('refund_plain', '退款', 'income', 'income_other', '#14b8a6', 638, true),
  childCategory('tax_refund', '退税', 'income', 'income_other', '#14b8a6', 639, true),
  childCategory('deposit_refund', '押金退回', 'income', 'income_other', '#14b8a6', 640, true),
  childCategory('compensation_income', '赔偿金', 'income', 'income_other', '#22c55e', 641, true),
  childCategory('insurance_claim', '保险理赔', 'income', 'income_other', '#22c55e', 642, true),
  childCategory('reimbursement_received', '报销到账', 'income', 'income_other', '#0ea5e9', 643, true),
  childCategory('second_hand_sale', '二手闲置出售', 'income', 'income_other', '#7c3aed', 644, true),
  childCategory('recycling_income', '废品回收', 'income', 'income_other', '#65a30d', 645, true),
  childCategory('borrowed_money', '借入款', 'income', 'income_other', '#65a30d', 646, true),
  childCategory('loan_recovered', '收回借款', 'income', 'income_other', '#65a30d', 647, true),
];

/**
 * 扩展包：只收录默认未启用的扩展分类。
 *
 * 包内不含任何默认分类。默认分类（一级分类 + 默认可见的二级分类）由账本初始化
 * 直接创建，例如「加油/充电」「住宿」「教材」都是默认就有的一级/二级分类：把它们
 * 放进扩展包，会让「停用扩展包」连带关掉用户日常在用的分类，也会让卡片一开始就
 * 显示「已启用 3/17」这种让人看不懂的状态。
 */
export const CATEGORY_PACKS: readonly CategoryPack[] = [
  {
    id: 'vehicle',
    name: '车主',
    description: '代驾租车、ETC 过路费、洗车维修、保险年检与违章',
    categoryIds: [
      'designated_driver', 'car_rental', 'etc_recharge', 'highway_toll', 'car_wash', 'car_repair',
      'car_accessories', 'roadside_assistance', 'car_insurance', 'vehicle_inspection',
      'traffic_fine', 'driving_school', 'license_renewal', 'auto_insurance',
    ],
  },
  {
    id: 'pet',
    name: '养宠',
    description: '宠物食品、用品、医疗、美容、寄养和保险',
    categoryIds: ['pet_food', 'pet_supplies', 'pet_medical', 'pet_grooming', 'pet_boarding', 'pet_insurance'],
  },
  {
    id: 'parenting',
    name: '育儿',
    description: '儿童食品、儿科、产检生育、教育托管和亲子支出',
    categoryIds: [
      'kids_food', 'pediatrics', 'maternity', 'children_education', 'childcare',
      'after_school_care', 'tutoring_class', 'summer_camp', 'study_trip', 'baby_full_month',
    ],
  },
  {
    id: 'student',
    name: '学生',
    description: '食堂、学费、网课、论文查重和打印复印',
    categoryIds: [
      'canteen', 'tuition', 'online_course', 'paper_check', 'print_copy', 'learning_device',
      'material_subscription',
    ],
  },
  {
    id: 'travel',
    name: '旅行',
    description: '长途客运、轮渡、租车、露营滑雪潜水与旅途购物',
    categoryIds: [
      'coach', 'ferry', 'car_rental', 'camping', 'skiing', 'diving', 'travel_shopping', 'souvenirs',
    ],
  },
  {
    id: 'investment',
    name: '投资',
    description: '申赎费用、佣金印花税、融资利息、汇兑和各类投资损益',
    categoryIds: [
      'fund_subscription_fee', 'fund_redemption_fee', 'stock_commission', 'stamp_tax',
      'margin_interest', 'fx_exchange_fee', 'fx_gain_loss', 'stock_sale_gain', 'fund_sale_gain',
      'bond_income', 'gold_income', 'forex_income', 'digital_asset_income', 'reits_dividend',
    ],
  },
  {
    id: 'renovation',
    name: '装修',
    description: '家装建材、软装、厨具、清洁收纳与搬家仓储',
    categoryIds: [
      'renovation_materials', 'soft_decoration', 'kitchenware', 'home_goods', 'storage_supplies',
      'bedding', 'moving_storage',
    ],
  },
  {
    id: 'freelance',
    name: '自由职业',
    description: '劳务咨询、设计开发、店铺运营、自媒体和工具订阅',
    categoryIds: [
      'labor_fee', 'consulting_fee_income', 'design_fee_income', 'development_fee_income',
      'operation_income', 'shop_income', 'media_income', 'ai_tools', 'cloud_service',
      'productivity_software', 'office_supplies', 'business_expense',
    ],
  },
  {
    id: 'health',
    name: '健康管理',
    description: '体检疫苗、中医理疗、慢病用药、口腔眼科与健身私教',
    categoryIds: [
      'lab_tests', 'vaccine', 'traditional_medicine', 'physiotherapy', 'acupuncture',
      'gynecology', 'dermatology', 'orthodontics', 'glasses_contacts', 'hearing_aid',
      'chronic_medicine', 'prescription_medicine', 'otc_medicine', 'supplements',
      'rehab_equipment', 'care_supplies', 'medical_beauty', 'nursing_care', 'ambulance',
      'personal_training', 'yoga_dance',
    ],
  },
  {
    id: 'insurance_tax',
    name: '保险与税费',
    description: '寿险重疾医疗意外财产险、房产税契税、滞纳金与各类手续费',
    categoryIds: [
      'life_insurance', 'critical_illness_insurance', 'medical_insurance', 'accident_insurance',
      'property_insurance', 'property_tax', 'deed_tax', 'vat', 'late_fee', 'penalty_interest',
      'bank_service_fee', 'payment_fee', 'interbank_fee', 'account_management_fee',
      'credit_card_interest', 'minimum_payment_interest', 'withdrawal_fee', 'installment_fee',
      'remittance_fee',
    ],
  },
  {
    id: 'social',
    name: '人情往来',
    description: '孝敬父母、红包压岁钱、婚丧嫁娶、生日乔迁与亲友借款',
    categoryIds: [
      'filial_support', 'alimony', 'partner_family', 'birthday_gift', 'school_gift',
      'housewarming_gift', 'hospital_visit', 'funeral_expense', 'wedding_gift_money',
      'lucky_money', 'red_packet_transfer', 'family_loan', 'friend_loan', 'family_fund',
      'aa_settlement', 'family_dinner', 'family_visit_transport', 'festival_filial',
    ],
  },
  {
    id: 'leisure',
    name: '休闲社交',
    description: '影音阅读会员、聚会娱乐、演出展览、打赏与运动旅行',
    categoryIds: [
      'music_membership', 'reading_membership', 'ktv', 'bar', 'script_murder', 'escape_room',
      'board_game', 'chess_card', 'live_tipping', 'short_video_tipping', 'concert',
      'music_festival', 'exhibition', 'museum', 'amusement_park', 'hot_spring_bath',
      'ball_sports', 'photography_travel',
    ],
  },
];

export const CATEGORY_LABEL: Record<string, string> = Object.fromEntries(SYSTEM_CATEGORY_CATALOG.map((c) => [c.id, c.name]));

export const CATEGORY_TYPE: Record<string, TransactionCategoryType> = Object.fromEntries(
  SYSTEM_CATEGORY_CATALOG.map((c) => [c.id, c.type]),
);

export const HIDDEN_CATEGORY_IDS = new Set(SYSTEM_CATEGORY_CATALOG.filter((c) => c.hidden).map((c) => c.id));

const DEFAULT_PARENT_IDS = new Set(SYSTEM_CATEGORY_CATALOG.map((c) => c.parentId).filter(Boolean));

export const DEFAULT_ENABLED_CATEGORY_IDS = new Set(
  SYSTEM_CATEGORY_CATALOG
    .filter((category) => !category.parentId || !category.hidden)
    .map((category) => category.id),
);

/**
 * 扩展分类 = 目录里默认未启用的可选分类。扩展包只允许收录这些分类。
 *
 * 它们是“默认不存在”的：首次启用扩展包（或首次在记账中引用）时才落库，因此
 * “启用/停用”对它们而言是一个可逆、可枚举的动作，不会碰到用户已有的默认分类。
 */
export const EXTENSION_CATEGORY_IDS = new Set(
  SYSTEM_CATEGORY_CATALOG
    .filter((category) => !DEFAULT_ENABLED_CATEGORY_IDS.has(category.id))
    .map((category) => category.id),
);

/**
 * 目录里存在、但账本里还没有的扩展分类：扩展分类的「浏览 + 逐项添加」入口。
 *
 * 扩展包只收录“会被同一类人成组需要”的分类；单一领域内的细分项（早餐、检查化验、
 * KTV……）数量多且因人而异，逐项挑选比整包开关更合适。这条入口直接读目录，因此
 * 目录新增分类后自动可达，不需要为它再设计一个扩展包。
 *
 * 两重限定都是必需的：
 * - 限定在扩展分类内：目录虚拟行不区分“默认分类”与“扩展分类”（两者都带
 *   catalogOnly 标记），只看标记会在账本缺行时把「早餐」这种默认分类当成可添加项。
 * - 排除已落库的 id（含已归档、已软删除）：归档过的成员要走「归档/恢复」，
 *   当成“可添加”再创建一份会写出重复分类。
 */
export function availableExtensionCategories(categories: readonly Category[] = []): CatalogCategory[] {
  const persisted = new Set(categories.map((category) => category.id));
  return allCategories(categories, { includeCatalog: true, includeInactive: true })
    .filter((category) => EXTENSION_CATEGORY_IDS.has(category.id) && !persisted.has(category.id));
}

export function categoryPack(packId: CategoryPackId): CategoryPack | undefined {
  return CATEGORY_PACKS.find((pack) => pack.id === packId);
}

/** 一个扩展分类可能同时属于多个扩展包（例如 租车 同时在「车主」与「旅行」）。 */
export function categoryPacksContaining(categoryId: string): readonly CategoryPack[] {
  return CATEGORY_PACKS.filter((pack) => pack.categoryIds.includes(categoryId));
}

/** 被两个及以上扩展包引用的分类 id。 */
export const SHARED_PACK_CATEGORY_IDS = new Set(
  CATEGORY_PACKS
    .flatMap((pack) => pack.categoryIds as readonly string[])
    .filter((categoryId) => categoryPacksContaining(categoryId).length > 1),
);

/** 扩展包成员在账本里的实际可用状态。 */
export type CategoryPackMemberState = 'enabled' | 'hidden' | 'disabled' | 'missing';

/**
 * 单个成员的可用状态。
 *
 * `hidden` 与 `disabled` 是两件事：前者是用户自己在「快捷显示与排序」里把它从
 * 常用列表移出，仍然可选可搜索；后者是扩展包停用，新增记账完全不能再选。
 */
export function categoryPackMemberState(
  categoryId: string,
  categories: readonly Category[] = [],
): CategoryPackMemberState {
  const row = categories.find((category) => category.id === categoryId && !category.isDeleted);
  if (!row) return 'missing';
  if (row.isActive === false) return 'disabled';
  return categoryIsHidden(row) ? 'hidden' : 'enabled';
}

export interface CategoryPackState {
  /** 包内成员总数。 */
  total: number;
  /** 已可用于新增记账的成员数。 */
  enabledCount: number;
  /** 已落库但被停用的成员数。 */
  disabledCount: number;
  /** 尚未写入账本的成员，首次启用时才补齐。 */
  missingIds: string[];
  status: 'disabled' | 'partial' | 'enabled';
}

/**
 * 从账本真实分类推导扩展包状态。
 *
 * 包状态不单独存一份：包内只有扩展分类，而扩展分类的存在/启用都只能由扩展包
 * （或用户在分类中心单独启用）产生，所以成员状态就是包状态的忠实投影，不需要
 * 在 Setting 里再维护一份可能与数据不一致的快照。
 */
export function categoryPackState(
  pack: CategoryPack,
  categories: readonly Category[] = [],
): CategoryPackState {
  const missingIds: string[] = [];
  let enabledCount = 0;
  for (const categoryId of pack.categoryIds) {
    const state = categoryPackMemberState(categoryId, categories);
    if (state === 'missing') missingIds.push(categoryId);
    else if (state === 'enabled' || state === 'hidden') enabledCount += 1;
  }
  const total = pack.categoryIds.length;
  const persisted = total - missingIds.length;
  return {
    total,
    enabledCount,
    disabledCount: persisted - enabledCount,
    missingIds,
    status: enabledCount === 0 ? 'disabled' : enabledCount === total ? 'enabled' : 'partial',
  };
}

export const EXPENSE_CATEGORIES: TransactionCategory[] = SYSTEM_CATEGORY_CATALOG
  .filter((c) => c.type === 'expense' && !DEFAULT_PARENT_IDS.has(c.id) && !c.hidden)
  .map((c) => c.id as TransactionCategory);

export const INCOME_CATEGORIES: TransactionCategory[] = SYSTEM_CATEGORY_CATALOG
  .filter((c) => c.type === 'income' && !DEFAULT_PARENT_IDS.has(c.id) && !c.hidden)
  .map((c) => c.id as TransactionCategory);

/*
 * 扁平的「叶子名」候选表（`CATEGORY_LABEL` 里存的就是不带父级的名字）。
 *
 * 只能给不明白层级的消费方用（历史上这是给原生下拉用的）。要喂分类选择器请改走
 * `categoryOptions()`：那个会同时给出 `name` / `parentName`，这里没有——而「打车/网约车」
 * 这种自带斜杠的名字一旦被选择器拿 `label` 反解，就会被切成两级。
 */
export const CATEGORY_OPTIONS = [...EXPENSE_CATEGORIES, ...INCOME_CATEGORIES].map((value) => ({
  value,
  label: CATEGORY_LABEL[value],
}));

export function systemCategory(id: string, catalogOnly = true): CatalogCategory | undefined {
  const category = SYSTEM_CATEGORY_CATALOG.find((candidate) => candidate.id === id);
  if (!category) return undefined;
  return {
    ...storedCategory(category),
    createdAt: '',
    updatedAt: '',
    version: 1,
    isDeleted: false,
    ...(catalogOnly ? { catalogOnly: true } : {}),
  };
}

export function allCategories(
  categories: readonly Category[] = [],
  opts: { includeInactive?: boolean; includeCatalog?: boolean } = {},
): CatalogCategory[] {
  const map = new Map<string, CatalogCategory>();
  for (const category of SYSTEM_CATEGORY_CATALOG) {
    if (!opts.includeCatalog && !DEFAULT_ENABLED_CATEGORY_IDS.has(category.id)) continue;
    const virtual = systemCategory(category.id);
    if (virtual) map.set(virtual.id, virtual);
  }
  for (const c of categories) map.set(c.id, c);
  return [...map.values()]
    .filter((c) => !c.isDeleted && (opts.includeInactive || c.isActive !== false))
    .sort((a, b) => (a.sortOrder ?? 9999) - (b.sortOrder ?? 9999) || a.name.localeCompare(b.name));
}

export function categoryIsHidden(category: Pick<Category, 'id' | 'isHidden'>): boolean {
  return category.isHidden ?? HIDDEN_CATEGORY_IDS.has(category.id);
}

export function categoryLabel(category: string, categories: Category[] = []): string {
  const cats = allCategories(categories, { includeCatalog: true, includeInactive: true });
  const found = cats.find((c) => c.id === category);
  if (!found) return CATEGORY_LABEL[category] ?? category;
  const parent = found.parentId ? cats.find((c) => c.id === found.parentId) : undefined;
  return parent ? `${parent.name} / ${found.name}` : found.name;
}

export function categoryType(category: string, categories: Category[] = []): TransactionCategoryType | undefined {
  return allCategories(categories, { includeCatalog: true, includeInactive: true }).find((c) => c.id === category)?.type ?? CATEGORY_TYPE[category];
}

export interface CategoryOption {
  icon?: string;
  parentId?: string;
  parentIcon?: string;
  parentColor?: string;
  color?: string;
  value: string;
  label: string;
  /**
   * 分类自己的名字，不含父级前缀。
   *
   * `label` 是给人看的字符串（一级和二级用「空格 斜杠 空格」拼起来），而分类名是
   * 用户可编辑的自由文本——叶子名本身就可能带斜杠（目录里的「打车/网约车」）。
   * 想在面板里分左右两栏显示的读侧必须用这两个字段，不要拿 `label` 反解。
   */
  name?: string;
  /** 父级名；没有父级时缺省，而不是空串。 */
  parentName?: string;
  hidden?: boolean;
  catalogOnly?: boolean;
  /**
   * 已停用（如所属扩展包被停用），但账本里可能仍留有引用。
   *
   * 注意与 `hidden` 的区别：隐藏的分类仍在选项池里，开关一下就看得见；
   * 停用的分类被 `allCategories` 直接丢弃，必须显式传 `includeInactive` 才拿得到。
   * 写路径（记账、批量修改）不应把它当作可选目标，读路径（筛选、查询）才需要。
   */
  inactive?: boolean;
}

export function categoryOptions(
  categories: Category[] = [],
  type?: TransactionCategoryType,
  opts: { leafOnly?: boolean; parentsOnly?: boolean; includeHidden?: boolean; includeCatalog?: boolean; includeInactive?: boolean } = {},
): CategoryOption[] {
  const cats = allCategories(categories, {
    includeCatalog: opts.includeCatalog ?? opts.includeHidden,
    includeInactive: opts.includeInactive,
  });
  const byId = new Map(cats.map((c) => [c.id, c]));
  /*
   * 结构化字段与 `label` 必须描述同一条路径，所以两者都按 `categoryLabel` 的口径从
   * 整份目录里取（含停用与未启用项）：只按上面那份 `cats` 取，会在父级被选项过滤
   * 条件剔掉时和 label 分叉，而 label 是别处一直在用的旧格式，不能悄悄改。
   */
  const named = new Map(
    allCategories(categories, { includeCatalog: true, includeInactive: true }).map((c) => [c.id, c]),
  );
  const parentIds = new Set(cats.map((c) => c.parentId).filter(Boolean));
  return cats
    .filter((c) => !type || c.type === type)
    .filter((c) => !opts.leafOnly || !parentIds.has(c.id))
    .filter((c) => !opts.parentsOnly || !c.parentId)
    .filter((c) => opts.includeHidden || !categoryIsHidden(c))
    .sort((a, b) => {
      const parentA = a.parentId ? byId.get(a.parentId) : a;
      const parentB = b.parentId ? byId.get(b.parentId) : b;
      const parentOrder = (parentA?.sortOrder ?? 9999) - (parentB?.sortOrder ?? 9999);
      if (parentOrder !== 0) return parentOrder;
      if (parentA?.id !== parentB?.id) return (parentA?.name ?? '').localeCompare(parentB?.name ?? '');
      if (!a.parentId && b.parentId) return -1;
      if (a.parentId && !b.parentId) return 1;
      const hiddenOrder = Number(categoryIsHidden(a)) - Number(categoryIsHidden(b));
      return hiddenOrder || (a.sortOrder ?? 9999) - (b.sortOrder ?? 9999) || a.name.localeCompare(b.name);
    })
    .map((c) => {
      const parent = c.parentId ? named.get(c.parentId) : undefined;
      return {
        value: c.id as TransactionCategory,
        icon: c.icon, parentId: c.parentId, parentIcon: parent?.icon, parentColor: parent?.color, color: c.color ?? parent?.color,
        label: parent ? `${parent.name} / ${c.name}` : c.name,
        name: c.name,
        parentName: parent?.name,
        hidden: categoryIsHidden(c) || undefined,
        catalogOnly: c.catalogOnly || undefined,
        inactive: c.isActive === false || undefined,
      };
    });
}
