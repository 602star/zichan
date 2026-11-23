import { useState } from 'react';
import { isEntityIconImage, SYSTEM_CATEGORY_CATALOG, type Category } from '@zichan/core';
import {
  Utensils, Car, ShoppingBag, House, HeartPulse, BookOpen, Ticket,
  Users, Landmark, CircleEllipsis, BriefcaseBusiness, TrendingUp, Wallet, Coffee,
  Fuel, Plane, TrainFront, Bike, Smartphone, Shirt, Gift,
  PawPrint, Store, Building2, UserRound, Package, Music, Gamepad2,
  type LucideIcon, Salad, Soup, Sandwich, Apple, CakeSlice, Wheat,
  Wine, Truck, BusFront, Ship, CircleParking, Wrench, Route,
  Sparkles, Baby, Monitor, Gem, Armchair, KeyRound, Droplets,
  Wifi, PlugZap, Brush, Stethoscope, Pill, ClipboardCheck, ScanHeart,
  Dumbbell, GraduationCap, NotebookPen, Pencil, Languages, CodeXml, Cloud,
  Clapperboard, Tv, Hotel, Tent, Camera, MicVocal, Dices,
  HeartHandshake, HandCoins, ShieldCheck, ReceiptText, CreditCard, Percent, BadgeDollarSign,
  Award, FileCheck2, CircleHelp, CirclePlus, CircleDollarSign, Flower2, LibraryBig,
  Luggage, Scissors, Glasses, Syringe, Ambulance, Heart, Receipt,
  ChartNoAxesCombined, CircleArrowDown, CircleArrowUp, RotateCcw, HandHeart, Search, Settings2,
  Scale, CircleAlert, ScanLine, Printer, FileText, Volleyball, Waves,
  Mountain, Crown, Headphones,
} from 'lucide-react';
import { siTaobao, siMeituan, siBilibili, siNeteasecloudmusic, siSteam, siAppstore, type SimpleIcon } from 'simple-icons';
import { findPlatform } from '../payee-catalog.js';

export const ENTITY_ICONS: Record<string, { label: string; component: LucideIcon }> = {
  utensils: { label: '餐饮', component: Utensils }, car: { label: '汽车', component: Car },
  shopping: { label: '购物', component: ShoppingBag }, house: { label: '居家', component: House },
  health: { label: '健康', component: HeartPulse }, book: { label: '学习', component: BookOpen },
  ticket: { label: '演出票务', component: Ticket }, users: { label: '家庭', component: Users },
  bank: { label: '金融', component: Landmark }, other: { label: '其他', component: CircleEllipsis },
  work: { label: '工作', component: BriefcaseBusiness }, investment: { label: '投资', component: TrendingUp },
  wallet: { label: '钱包', component: Wallet }, coffee: { label: '咖啡', component: Coffee },
  fuel: { label: '加油', component: Fuel }, plane: { label: '飞机', component: Plane },
  train: { label: '火车', component: TrainFront }, bike: { label: '骑行', component: Bike },
  phone: { label: '通信', component: Smartphone }, shirt: { label: '服饰', component: Shirt },
  gift: { label: '礼物', component: Gift }, pet: { label: '宠物', component: PawPrint },
  store: { label: '商家', component: Store }, company: { label: '公司', component: Building2 },
  person: { label: '个人', component: UserRound }, package: { label: '快递', component: Package },
  music: { label: '音乐', component: Music }, game: { label: '游戏', component: Gamepad2 },
  salad: { label: '蔬菜食材', component: Salad }, soup: { label: '正餐', component: Soup },
  sandwich: { label: '早餐', component: Sandwich }, fruit: { label: '水果零食', component: Apple },
  cake: { label: '蛋糕甜品', component: CakeSlice }, grain: { label: '粮油', component: Wheat },
  wine: { label: '酒水', component: Wine }, delivery: { label: '配送', component: Truck },
  bus: { label: '公交', component: BusFront }, ship: { label: '轮渡', component: Ship },
  parking: { label: '停车', component: CircleParking }, repair: { label: '维修', component: Wrench },
  route: { label: '路桥出行', component: Route }, beauty: { label: '美容护肤', component: Sparkles },
  baby: { label: '母婴育儿', component: Baby }, computer: { label: '电脑数码', component: Monitor },
  jewelry: { label: '珠宝饰品', component: Gem }, furniture: { label: '家具', component: Armchair },
  key: { label: '房租钥匙', component: KeyRound }, water: { label: '水电', component: Droplets },
  wifi: { label: '网络', component: Wifi }, electricity: { label: '电器充电', component: PlugZap },
  cleaning: { label: '清洁家政', component: Brush }, doctor: { label: '挂号诊疗', component: Stethoscope },
  medicine: { label: '药品', component: Pill }, checkup: { label: '体检检查', component: ClipboardCheck },
  hospital: { label: '住院手术', component: ScanHeart }, fitness: { label: '健身', component: Dumbbell },
  education: { label: '课程学费', component: GraduationCap }, exam: { label: '考试', component: NotebookPen },
  stationery: { label: '文具', component: Pencil }, language: { label: '语言', component: Languages },
  code: { label: '软件编程', component: CodeXml }, cloud: { label: '云服务', component: Cloud },
  movie: { label: '电影', component: Clapperboard }, television: { label: '电视影音', component: Tv },
  hotel: { label: '酒店', component: Hotel }, camping: { label: '露营', component: Tent },
  camera: { label: '摄影', component: Camera }, microphone: { label: '演唱', component: MicVocal },
  boardgame: { label: '桌游', component: Dices }, social: { label: '人情往来', component: HeartHandshake },
  support: { label: '赡养资助', component: HandCoins }, insurance: { label: '保险', component: ShieldCheck },
  tax: { label: '税费', component: ReceiptText }, card: { label: '银行卡', component: CreditCard },
  interest: { label: '利息', component: Percent }, salary: { label: '工资', component: BadgeDollarSign },
  bonus: { label: '奖金', component: Award }, certificate: { label: '证书', component: FileCheck2 },
  unknown: { label: '待分类', component: CircleHelp }, add: { label: '临时事项', component: CirclePlus },
  money: { label: '资金', component: CircleDollarSign }, plant: { label: '花草园艺', component: Flower2 },
  library: { label: '图书资料', component: LibraryBig }, luggage: { label: '行李旅行', component: Luggage },
  haircut: { label: '理发', component: Scissors }, glasses: { label: '眼镜', component: Glasses },
  vaccine: { label: '疫苗', component: Syringe }, ambulance: { label: '救护车', component: Ambulance },
  heart: { label: '关爱', component: Heart }, receipt: { label: '账单报销', component: Receipt },
  chart: { label: '市场行情', component: ChartNoAxesCombined }, outgoing: { label: '支出', component: CircleArrowUp },
  incoming: { label: '收入', component: CircleArrowDown }, refund: { label: '退回返还', component: RotateCcw },
  donation: { label: '捐赠', component: HandHeart }, search: { label: '查找核实', component: Search },
  settings: { label: '调整', component: Settings2 }, legal: { label: '法律', component: Scale },
  alert: { label: '罚款损失', component: CircleAlert }, scan: { label: '扫码', component: ScanLine },
  printer: { label: '打印', component: Printer }, document: { label: '项目文档', component: FileText },
  ball: { label: '球类运动', component: Volleyball }, swimming: { label: '游泳温泉', component: Waves },
  mountain: { label: '户外登山', component: Mountain }, membership: { label: '会员', component: Crown },
  headphones: { label: '耳机音频', component: Headphones },
};
const defaults: Record<string, string> = {
  expense_food: 'utensils', expense_transport: 'car', expense_shopping: 'shopping', expense_home: 'house',
  expense_health: 'health', expense_learning: 'book', expense_entertainment: 'ticket', expense_family: 'users',
  expense_finance: 'bank', expense_misc: 'other', income_work: 'work', income_investment: 'investment', income_other: 'wallet',
  coffee_drinks: 'coffee', fuel: 'fuel', flight: 'plane', train_flight: 'train', transport: 'train',
  taxi_ride: 'car', taxi: 'car', bike_ebike: 'bike', shared_ebike: 'bike', communication: 'phone',
  concert: 'ticket', movies: 'ticket', music_festival: 'music', games: 'game', express_postage: 'package',
};
// Map by stable catalog id, never by a user's editable category name. Child icons
// describe the actual purchase; siblings no longer all inherit their parent's mark.
const defaultIconGroups: Record<string, string> = {
  salad: 'groceries fresh_delivery prepared_food',
  delivery: 'takeaway',
  soup: 'food lunch_work_meal dinner canteen late_night_snack buffet',
  fruit: 'snacks_fruit kids_food pet_food',
  social: 'dining_out company_dinner social wedding_funeral friend_loan aa_settlement family_dinner',
  utensils: 'other_food group_buy_food kitchenware',
  sandwich: 'breakfast meal_allowance',
  wine: 'alcohol_drinks bar',
  cake: 'bakery_dessert birthday_gift',
  grain: 'seasoning_grain_oil',
  bus: 'transport coach',
  train: 'train_flight',
  route: 'other_transport highway_toll etc_recharge family_visit_transport',
  parking: 'parking',
  repair: 'car_maintenance car_repair car_accessories repair_parts home_repair maintenance_fund',
  car: 'taxi_ride taxi designated_driver car_rental driving_school transport_allowance',
  ship: 'ferry',
  cleaning: 'car_wash home_goods pest_control',
  ambulance: 'roadside_assistance ambulance',
  insurance: 'car_insurance auto_insurance pet_insurance insurance life_insurance critical_illness_insurance medical_insurance accident_insurance property_insurance social_security_housing_fund compensation_claim',
  checkup: 'vehicle_inspection wellness lab_tests',
  certificate: 'license_renewal qualification_certificate',
  alert: 'traffic_fine fine late_fee penalty_interest compensation_expense lost_damage damage_compensation bad_debt_loss',
  shirt: 'clothing underwear_socks',
  beauty: 'beauty medical_beauty dermatology',
  computer: 'digital_goods computer_accessories learning_device',
  shopping: 'shopping other_shopping purchasing_agent travel_shopping',
  baby: 'mother_baby children childcare baby_full_month pediatrics maternity',
  jewelry: 'accessories jewelry',
  luggage: 'luggage_bags travel overseas_shopping travel_allowance',
  fitness: 'sports_equipment fitness rehab_equipment personal_training',
  mountain: 'outdoor_equipment skiing study_trip',
  camera: 'camera_equipment photography_travel exhibition',
  phone: 'phone_accessories',
  stationery: 'office_supplies stationery',
  plant: 'flowers_plants gardening',
  gift: 'gifts festival_gifts housewarming_gift festival_filial souvenirs red_packet gift lucky_money_income',
  card: 'membership_card_topup credit_card_annual_fee payment_fee',
  game: 'designer_toys anime_goods blind_box games',
  refund: 'second_hand_purchase refund refund_plain tax_refund insurance_claim deposit_refund',
  key: 'housing deposit locks_keys rental_agent_fee escape_room',
  house: 'mortgage housing_allowance rent_income',
  water: 'utilities',
  company: 'property_management',
  wifi: 'internet_tv',
  furniture: 'furniture_appliance soft_decoration',
  pet: 'pet pet_supplies pet_grooming pet_boarding',
  package: 'storage_supplies moving_storage',
  electricity: 'heating_fee heat_allowance',
  television: 'communication subscriptions',
  settings: 'other_home system_adjustment account_correction',
  tax: 'garbage_fee tax property_tax deed_tax vat',
  scan: 'security_monitoring',
  work: 'renovation_materials business_expense sidejob intern_salary',
  hotel: 'bedding hotel',
  doctor: 'healthcare traditional_medicine pet_medical acupuncture',
  medicine: 'medicine chronic_medicine prescription_medicine otc_medicine supplements',
  hospital: 'hospital_surgery',
  heart: 'counseling gynecology nursing_care care_supplies partner_family',
  health: 'other_health physiotherapy dental orthodontics',
  vaccine: 'vaccine',
  glasses: 'glasses_contacts',
  headphones: 'hearing_aid',
  education: 'education tuition skill_training offline_training tutoring_class after_school_care children_education school_gift',
  library: 'books material_subscription reading_membership',
  document: 'paper_check project_income project_bonus knowledge_pay copyright_income patent_income',
  code: 'software_tools programming_learning',
  book: 'other_learning interest_course online_course',
  language: 'language_learning overseas_study',
  camping: 'summer_camp camping',
  printer: 'print_copy',
  cloud: 'ai_tools cloud_service',
  membership: 'productivity_software member_software',
  movie: 'movies',
  plane: 'flight',
  ticket: 'tickets concert',
  music: 'entertainment music_festival music_membership other_entertainment',
  microphone: 'ktv',
  boardgame: 'board_game chess_card script_murder',
  donation: 'live_tipping short_video_tipping donation public_donation',
  bank: 'museum other_finance',
  ball: 'amusement_park ball_sports',
  swimming: 'hot_spring_bath diving',
  person: 'yoga_dance',
  support: 'parents filial_support alimony parent_support family_transfer_in partner_transfer_in other_family',
  wallet: 'family_fund other_work_income other_income',
  receipt: 'bank_fee bank_service_fee remittance_fee fx_exchange_fee investment_fee reimbursement unrecognized_bill',
  interest: 'loan_interest interest_income deposit_interest fx_gain_loss bond_income convertible_bond_income',
  unknown: 'uncategorized',
  search: 'unknown_expense',
  add: 'temporary_misc temporary_advance',
  other: 'other_expense',
  salary: 'salary thirteenth_salary performance_salary',
  bonus: 'bonus year_end_bonus',
  incoming: 'allowance position_allowance severance_pay non_compete_compensation government_subsidy platform_subsidy',
  chart: 'asset_sale_gain stock_sale_gain fund_sale_gain other_investment_income',
  investment: 'fund_dividend dividend_income equity_dividend company_dividend reits_dividend',
  money: 'cashback coupon_cashback credit_card_cashback draw_cashback points_redemption',
  outgoing: 'sale_income second_hand_sale recycling_income',
  exam: 'exams grad_civil_exam',
};
Object.assign(defaults, Object.fromEntries(Object.entries(defaultIconGroups).flatMap(([icon, ids]) => ids.split(' ').map((id) => [id, icon]))));
const brands: Record<string, SimpleIcon> = {
  taobao: siTaobao, meituan: siMeituan, bilibili: siBilibili, 'netease-music': siNeteasecloudmusic,
  steam: siSteam, 'app-store': siAppstore,
};

export function categoryIconValue(id: string, categories: Category[] = []): string {
  const category = categories.find((row) => row.id === id) ?? SYSTEM_CATEGORY_CATALOG.find((row) => row.id === id);
  if (category && 'icon' in category && category.icon) return category.icon;
  if (defaults[id]) return `lucide:${defaults[id]}`;
  const parent = categories.find((row) => row.id === category?.parentId);
  return parent?.icon || `lucide:${defaults[category?.parentId ?? ''] ?? 'other'}`;
}

export function categoryOptionIcon(option: { value: string; icon?: string; parentIcon?: string; parentId?: string }): string {
  return option.icon || (defaults[option.value] ? `lucide:${defaults[option.value]}` : option.parentIcon)
    || (option.parentId ? categoryIconValue(option.parentId) : categoryIconValue(option.value));
}

/** Never fetch remote URLs or render uploaded SVG markup. */
export function EntityIcon({ icon, fallback = 'other', platformName, platformId, size = 18, color }: {
  icon?: string; fallback?: string; platformName?: string; platformId?: string; size?: number; color?: string;
}) {
  const [failed, setFailed] = useState('');
  const style = { width: size, height: size, flex: '0 0 auto' as const, color, verticalAlign: 'middle' as const };
  if (isEntityIconImage(icon) && failed !== icon) return <img aria-hidden="true" alt="" src={icon} width={size} height={size}
    style={{ ...style, objectFit: 'contain' }} onError={() => setFailed(icon)} />;
  const brand = !icon ? brands[platformId?.replace(/^platform-payee:/, '') ?? ''] ?? brands[findPlatform(platformName ?? '')?.id ?? ''] : undefined;
  if (brand) return <svg aria-hidden="true" width={size} height={size} viewBox="0 0 24 24" style={style} fill="currentColor"><path d={brand.path} /></svg>;
  const Icon = ENTITY_ICONS[icon?.replace(/^lucide:/, '') ?? '']?.component ?? ENTITY_ICONS[fallback]?.component ?? CircleEllipsis;
  return <Icon aria-hidden="true" size={size} strokeWidth={1.8} style={style} />;
}

export function CategoryMark({ id, categories }: { id: string; categories: Category[] }) {
  return <EntityIcon icon={categoryIconValue(id, categories)} color={categories.find((row) => row.id === id)?.color} />;
}
