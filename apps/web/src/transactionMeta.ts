import { allCategories, CATEGORY_LABEL, type Category, type Payee, type Transaction } from '@zichan/core';

export {
  TYPE_LABEL,
  SYSTEM_CATEGORY_CATALOG,
  DEFAULT_ENABLED_CATEGORY_IDS,
  CATEGORY_PACKS,
  EXTENSION_CATEGORY_IDS,
  SHARED_PACK_CATEGORY_IDS,
  categoryPack,
  categoryPacksContaining,
  categoryPackMemberState,
  categoryPackState,
  CATEGORY_LABEL,
  CATEGORY_TYPE,
  HIDDEN_CATEGORY_IDS,
  EXPENSE_CATEGORIES,
  INCOME_CATEGORIES,
  CATEGORY_OPTIONS,
  storedCategory,
  systemCategory,
  allCategories,
  availableExtensionCategories,
  categoryIsHidden,
  categoryLabel,
  categoryType,
  categoryOptions,
  type BuiltInCategory,
  type CatalogCategory,
  type CategoryOption,
  type CategoryPack,
  type CategoryPackId,
  type CategoryPackMemberState,
  type CategoryPackState,
} from '@zichan/core';

/** 无参数调用的共享空数组：让缺省路径也命中下面的 WeakMap，而不是每次新建一个。 */
const EMPTY_CATEGORIES: Category[] = [];

/*
 * 索引按数组**引用**缓存：快照在写入时才换新数组，所以同一份快照上的多次查询
 * （筛选循环里每笔流水都要判一次归属）不必重建 375 条目录的 Map。
 * 代价是不能再就地改 `categories` 的内容——本项目一直把快照当不可变的用。
 */
const levelIndexCache = new WeakMap<Category[], ReturnType<typeof buildLevelIndex>>();

/**
 * 分类链的两件事：谁是这一支的一级分类，以及一个分类自己叫什么。
 *
 * 环图按一级聚合、流水只挂二级，所以画图时要能把每个叶子归到板块上；而它自己的
 * 名字不带父级前缀——环已经是「板块 → 细分」的嵌套读法，再写一遍父级就是重复。
 *
 * 一次建成索引而不是每个叶子查一遍：一屏要处理几十个分类，且要把两级的
 * 名字与归属放在同一次比对里，不然会出现「环上叫 A、图例里叫 B」这种不一致。
 */
function buildLevelIndex(categories: Category[]) {
  const byId = new Map(
    allCategories(categories, { includeCatalog: true, includeInactive: true }).map((category) => [category.id, category]),
  );
  const nameOf = (id: string): string => byId.get(id)?.name ?? CATEGORY_LABEL[id] ?? id;
  /* 目录只有两级，但自建分类允许留空父级、也不排除以后出现更深的链，所以按链上溯
   * 而不是取一次 `parentId`；脏数据里出现环时停在原地（`doctor` 会单独报 category_cycle）。 */
  const rootOf = (id: string): string => {
    let current = byId.get(id);
    if (!current) return id;
    const seen = new Set<string>([current.id]);
    while (current.parentId) {
      const parent = byId.get(current.parentId);
      if (!parent || seen.has(parent.id)) break;
      seen.add(parent.id);
      current = parent;
    }
    return current.id;
  };
  return { nameOf, rootOf };
}

export function categoryLevelIndex(categories: Category[] = EMPTY_CATEGORIES) {
  const cached = levelIndexCache.get(categories);
  if (cached) return cached;
  const index = buildLevelIndex(categories);
  levelIndexCache.set(categories, index);
  return index;
}

/** 单个分类的一级归属；一次性场景（例如表格行点击）用它。 */
export function rootCategoryId(category: string, categories: Category[] = EMPTY_CATEGORIES): string {
  return categoryLevelIndex(categories).rootOf(category);
}

/** 分类自己的名字，不带「父级 / 子级」前缀。表格行、条形标签这些窄位置用它。 */
export function categoryName(category: string, categories: Category[] = EMPTY_CATEGORIES): string {
  return categoryLevelIndex(categories).nameOf(category);
}

/**
 * 流水「摘要」那一格的兜底链：描述 → 商户（目录里的名字，退回手填的商户文本）→ 分类。
 *
 * 每一档都必须真的能落到下一档，所以这里**不产出任何占位符**。旧写法在没有商户时返回的
 * 是一个**真的横杠字符**，而 `??` 只认 null/undefined——那个横杠卡在第二档，把后面的商户
 * 和分类一起短路了，于是不写描述、也没填商户的流水整行标题只剩一个横杠。
 *
 * 只是显示层的兜底，结果不写回 `transaction.description`：分类改名或换分类之后，落过盘的
 * 兜底值会变成假数据，而且再也分不出哪些字是用户自己写的。
 *
 * `fallbackCategoryLabel` 由调用方给（列表里旁边就是分类列，传二级名省宽度；作废列表那列
 * 放的是类型，就传完整路径），这样转账/对账调整/拆分的口径跟同一行的分类列保持一致。
 */
export function transactionSummaryTitle(
  tx: Pick<Transaction, 'description' | 'merchant' | 'payeeId'>,
  payees: readonly Payee[],
  fallbackCategoryLabel: string,
): string {
  const description = tx.description?.trim();
  if (description) return description;
  const payee = tx.payeeId ? payees.find((item) => item.id === tx.payeeId)?.name?.trim() : undefined;
  const merchant = tx.merchant?.trim();
  return payee || merchant || fallbackCategoryLabel;
}
