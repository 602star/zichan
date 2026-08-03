import {
  newId,
  type BudgetCategory,
  type Category,
  type FixedAssetCategory,
  type ScheduledTransaction,
  type Transaction,
  type TransactionLocation,
  type TransactionTag,
  type TransactionTemplate,
} from '@zichan/core';
import type { SqlLedgerStore } from '@zichan/db';
import { DEFAULT_ENABLED_CATEGORY_IDS, SYSTEM_CATEGORY_CATALOG, storedCategory } from '../transactionMeta.js';
import { DEFAULT_FIXED_ASSET_CATEGORIES } from '../fixedAssetCategories.js';

type StoredBuiltInCategory = ReturnType<typeof storedCategory>;

export function categoryWithBuiltInDefaults(current: Category, defaults: StoredBuiltInCategory): Category {
  return {
    ...defaults,
    ...current,
    isHidden: current.isHidden ?? defaults.isHidden,
    sortOrder: current.sortOrder ?? defaults.sortOrder,
  } as Category;
}

function baseFields() {
  return { id: newId(), createdAt: '', updatedAt: '', version: 1, isDeleted: false };
}

function keyOf(value: string): string {
  return value.trim().toLocaleLowerCase();
}

function byName<T extends { name: string; isDeleted?: boolean }>(rows: T[]): Map<string, T> {
  const map = new Map<string, T>();
  for (const row of rows.filter((x) => !x.isDeleted)) map.set(keyOf(row.name), row);
  return map;
}

export async function runLedgerMaintenance(store: SqlLedgerStore): Promise<boolean> {
  const [
    assets, settings, payees, categories, fixedCategories, tags, locations, templates, budgets, schedules,
  ] = await Promise.all([
    store.assets.list(),
    store.settings.list(),
    store.payees.list(),
    store.categories.list({ includeDeleted: true }),
    store.fixedAssetCategories.list({ includeDeleted: true }),
    store.transactionTags.list({ includeDeleted: true }),
    store.transactionLocations.list(),
    store.transactionTemplates.list(),
    store.budgetCategories.list(),
    store.scheduledTransactions.list(),
  ]);

  const baseAssetId = settings[0]?.baseCurrencyAssetId ?? assets.find((a) => !a.isDeleted && a.type === 'fiat')?.id ?? assets.find((a) => !a.isDeleted)?.id ?? '';
  const transactionAssetId = settings[0]?.transactionDefaultAssetId ?? baseAssetId;
  const defaultAccountId = payees.find((p) => !p.isDeleted && p.defaultAccountId)?.defaultAccountId;
  const month = (settings[0]?.asOfDate ?? new Date().toISOString().slice(0, 10)).slice(0, 7);
  const tagByName = byName(tags);
  const locationByName = byName(locations);
  const templateByName = byName(templates);
  const payeeByName = byName(payees);

  const categoriesById = new Map(categories.map((c) => [c.id, c]));
  const categoryWrites: Category[] = [];
  for (const builtIn of SYSTEM_CATEGORY_CATALOG.filter((category) => DEFAULT_ENABLED_CATEGORY_IDS.has(category.id))) {
    const storedBuiltIn = storedCategory(builtIn);
    const current = categoriesById.get(storedBuiltIn.id);
    if (!current) {
      categoryWrites.push({ ...baseFields(), ...storedBuiltIn } as Category);
      continue;
    }
    const next = categoryWithBuiltInDefaults(current, storedBuiltIn);
    if (
      current.name !== next.name
      || current.type !== next.type
      || current.parentId !== next.parentId
      || current.color !== next.color
      || current.sortOrder !== next.sortOrder
      || current.budgetable !== next.budgetable
      || current.isHidden !== next.isHidden
      || current.isDeleted !== false
      || current.isActive !== next.isActive
    ) {
      categoryWrites.push(next);
    }
  }
  const fixedCategoryIds = new Set(fixedCategories.map((category) => category.id));
  const newFixedCategories = DEFAULT_FIXED_ASSET_CATEGORIES
    .filter((category) => !fixedCategoryIds.has(category.id))
    .map((category) => ({ ...baseFields(), ...category } as FixedAssetCategory));
  const newTags: TransactionTag[] = [];
  const ensureTag = (name: string, groupName: string, color: string, sortOrder: number): TransactionTag => {
    const existing = tagByName.get(keyOf(name));
    if (existing) return existing;
    const row = { ...baseFields(), name, groupName, color, sortOrder, isActive: true } as TransactionTag;
    newTags.push(row);
    tagByName.set(keyOf(name), row);
    return row;
  };
  const tagWork = ensureTag('工作日', '场景', '#14b8a6', 10);
  const tagRecurring = ensureTag('固定', '项目', '#6366f1', 20);
  const tagReimburse = ensureTag('待报销', '报销', '#f97316', 30);
  ensureTag('游戏', '项目', '#db2777', 40);

  const newLocations: TransactionLocation[] = [];
  const ensureLocation = (name: string, address?: string): TransactionLocation => {
    const existing = locationByName.get(keyOf(name));
    if (existing) return existing;
    const row = { ...baseFields(), name, address, isActive: true } as TransactionLocation;
    newLocations.push(row);
    locationByName.set(keyOf(name), row);
    return row;
  };
  const locHome = ensureLocation('家', 'Home');
  const locOffice = ensureLocation('公司附近', 'Office area');
  ensureLocation('地铁站', 'Transit station');

  const newTemplates: TransactionTemplate[] = [];
  const ensureTemplate = (
    name: string,
    type: Transaction['type'],
    category: string,
    amount: string,
    payeeName?: string,
    tagIds: string[] = [],
    locationId?: string,
  ) => {
    if (templateByName.has(keyOf(name)) || !transactionAssetId) return;
    const payee = payeeName ? payeeByName.get(keyOf(payeeName)) : undefined;
    const row = {
      ...baseFields(),
      name,
      type,
      category,
      amount,
      assetId: transactionAssetId,
      accountId: defaultAccountId,
      payeeId: payee?.id,
      tagIds,
      locationId,
      description: name,
      sortOrder: newTemplates.length + 10,
      isActive: true,
    } as TransactionTemplate;
    newTemplates.push(row);
    templateByName.set(keyOf(name), row);
  };
  ensureTemplate('午餐', 'expense', 'food', '20', 'Noodle Bar', [tagWork.id], locOffice.id);
  ensureTemplate('房租', 'expense', 'housing', '980', '公寓', [tagRecurring.id], locHome.id);
  ensureTemplate('工资', 'income', 'salary', '3200', '雇主', [tagRecurring.id], locHome.id);

  const budgetKeys = new Set(budgets.filter((b) => !b.isDeleted && b.month === month).map((b) => b.category));
  const newBudgets: BudgetCategory[] = [];
  for (const [category, plannedAmount] of [['food', '420'], ['transport', '160'], ['shopping', '300'], ['housing', '980'], ['entertainment', '180']] as const) {
    if (!budgetKeys.has(category) && transactionAssetId) {
      newBudgets.push({ ...baseFields(), month, category, plannedAmount, assetId: transactionAssetId, rolloverMode: 'none' } as BudgetCategory);
      budgetKeys.add(category);
    }
  }

  const scheduleNames = new Set(schedules.filter((s) => !s.isDeleted).map((s) => keyOf(s.name)));
  const newSchedules: ScheduledTransaction[] = [];
  const ensureSchedule = (name: string, type: Transaction['type'], category: string, amount: string, anchorDate: string, payeeName?: string) => {
    if (scheduleNames.has(keyOf(name)) || !transactionAssetId) return;
    const payee = payeeName ? payeeByName.get(keyOf(payeeName)) : undefined;
    newSchedules.push({
      ...baseFields(),
      name,
      type,
      category,
      amount,
      assetId: transactionAssetId,
      accountId: defaultAccountId,
      payeeId: payee?.id,
      frequency: 'monthly',
      anchorDate,
      anchorMode: 'calendar_day',
      time: '09:00',
      timezone: Intl.DateTimeFormat().resolvedOptions().timeZone || 'Asia/Shanghai',
      autoCreate: false,
      catchUpPolicy: 'all',
      status: 'active',
    } as ScheduledTransaction);
    scheduleNames.add(keyOf(name));
  };
  ensureSchedule('工资', 'income', 'salary', '3200', `${month}-01`, '雇主');
  ensureSchedule('房租', 'expense', 'housing', '980', `${month}-02`, '公寓');

  const entityCount = categoryWrites.length + newFixedCategories.length + newTags.length + newLocations.length + newTemplates.length + newBudgets.length + newSchedules.length;
  if (entityCount === 0) return false;

  const batch = await store.createAuditBatch({
    id: newId(),
    type: 'system',
    label: '基础资料补齐',
    actorName: '系统',
    entityCount,
    summary: `补齐收支分类 ${categoryWrites.length} 个、物品分类 ${newFixedCategories.length} 个、标签 ${newTags.length} 个、地点 ${newLocations.length} 个、模板 ${newTemplates.length} 个、预算 ${newBudgets.length} 个、定期交易 ${newSchedules.length} 个`,
  });
  await store.withAuditContext({ batchId: batch.id, source: 'system', actorName: '系统' }, async (store) => {
    await store.transaction(async (store) => {
      for (const category of categoryWrites) await store.categories.put(category);
      for (const category of newFixedCategories) await store.fixedAssetCategories.put(category);
      for (const tag of newTags) await store.transactionTags.put(tag);
      for (const location of newLocations) await store.transactionLocations.put(location);
      for (const template of newTemplates) await store.transactionTemplates.put(template);
      for (const budget of newBudgets) await store.budgetCategories.put(budget);
      for (const schedule of newSchedules) await store.scheduledTransactions.put(schedule);
    });
  });
  const loggedCount = (await store.operationLog({ batchId: batch.id })).length;
  await store.finishAuditBatch(batch.id, { entityCount: loggedCount });
  return true;
}
