/**
 * Creates the explicitly selected demo ledger. Numbers are realistic (computed
 * by the core), not penny-copies of the mock's hand-typed values. StoreProvider
 * must never call this automatically.
 */
import {
  D, addDays, newId, localToday,
  type Asset, type Account, type BudgetCategory, type Category, type ConversionChain, type ConversionStep,
  type DcaExecution, type Game, type GameAccount, type GameSeason, type GameRecord, type FixedAsset,
  type FixedAssetConsumable, type FixedAssetEvent, type FixedAssetCategory, type FixedAssetGoal,
  type FixedAssetUsageLog, type FixedAssetUsageMetric, type Payee, type PriceMark, type ScheduledTransaction,
  type Transaction, type TransactionLocation, type TransactionSavedView, type TransactionTag, type TransactionTemplate,
} from '@zichan/core';
import { recordConversion, recordSell, saveTransaction, type SqlLedgerStore } from '@zichan/db';
import { DEFAULT_ENABLED_CATEGORY_IDS, SYSTEM_CATEGORY_CATALOG, storedCategory } from '../transactionMeta.js';
import { DEFAULT_FIXED_ASSET_CATEGORIES } from '../fixedAssetCategories.js';

const localDate = () => localToday();
function baseFields() {
  return { id: newId(), createdAt: '', updatedAt: '', version: 1, isDeleted: false };
}

export async function seedDemoLedger(store: SqlLedgerStore): Promise<void> {
  await store.runInAuditBatch('初始化演示账本', async (store) => {
  // This check belongs to the same transaction as the seed. Concurrent first-
  // run submissions therefore serialize, and the later one becomes a no-op.
  const settings = await store.settings.list();
  if (settings.length > 1) throw new Error('数据库包含多个活动账本设置，无法创建演示账本');
  const current = settings[0];
  if (current) {
    if (current.ledgerKind === 'demo' && typeof current.initializedAt === 'string'
      && !Number.isNaN(Date.parse(current.initializedAt))) return;
    throw new Error('账本已经初始化，不能创建演示账本');
  }
  const [assetCount, categoryCount, fixedCategoryCount] = await Promise.all([
    store.assets.count(),
    store.categories.count(),
    store.fixedAssetCategories.count(),
  ]);
  if (assetCount || categoryCount || fixedCategoryCount) {
    throw new Error('数据库存在未完成的初始化数据，不能创建演示账本');
  }

  for (const category of DEFAULT_FIXED_ASSET_CATEGORIES) {
    await store.fixedAssetCategories.put({ ...baseFields(), ...category } as FixedAssetCategory);
  }
  // ── assets ──
  const A = (code: string, name: string, type: Asset['type'], decimals: number, symbol?: string): Asset =>
    ({ ...baseFields(), code, name, type, decimals, symbol, isActive: true }) as Asset;
  const gbp = A('GBP', '英镑', 'fiat', 2, '£');
  const usdt = A('USDT', '泰达币', 'stablecoin', 6);
  const btc = A('BTC', '比特币', 'crypto', 8);
  const eth = A('ETH', '以太坊', 'crypto', 8);
  const embers = A('初火', '初火', 'game', 0);
  for (const a of [gbp, usdt, btc, eth, embers]) await store.assets.put(a);

  await store.settings.put({
    ...baseFields(),
    baseCurrencyAssetId: gbp.id,
    transactionDefaultAssetId: gbp.id,
    investmentCostAssetId: gbp.id,
    fixedAssetDefaultCurrencyAssetId: gbp.id,
    gameDefaultSettlementAssetId: gbp.id,
    categoryPickerDefaultScope: 'frequent',
    refundAttributionMode: 'original_date',
    ledgerMode: 'spending',
    ledgerKind: 'demo',
    initializedAt: new Date().toISOString(),
    defaultLotMethod: 'fifo',
    asOfDate: localDate(),
  } as never);

  // ── accounts ──
  const acc = (name: string, kind: Account['kind'], platform?: string): Account =>
    ({ ...baseFields(), name, kind, platform, isActive: true }) as Account;
  const bank = acc('汇丰活期', 'bank');
  const cash = acc('现金钱包', 'cash');
  const binance = acc('Binance', 'exchange', 'Binance');
  const wallet = acc('Ledger 冷钱包', 'wallet');
  // Opening-balance / equity account (double-entry): deposits come "from" here.
  // Balances exclude it so cash-on-hand reads correctly.
  const external = acc('外部 / 入金', 'other');
  for (const a of [bank, cash, binance, wallet, external]) await store.accounts.put(a);

  for (const c of SYSTEM_CATEGORY_CATALOG.filter((category) => DEFAULT_ENABLED_CATEGORY_IDS.has(category.id))) {
    await store.categories.put({ ...baseFields(), ...storedCategory(c) } as Category);
  }

  const payee = (name: string, defaultCategory: string, defaultAccountId = bank.id, aliases: string[] = []): Payee =>
    ({ ...baseFields(), name, defaultCategory, defaultAccountId, aliases, isActive: true }) as Payee;
  const employer = payee('雇主', 'salary');
  const apartment = payee('公寓', 'housing');
  const noodle = payee('Noodle Bar', 'food', bank.id, ['面馆']);
  const tfl = payee('TfL', 'transport');
  const amazon = payee('Amazon', 'shopping');
  const apple = payee('Apple', 'shopping');
  for (const p of [employer, apartment, noodle, tfl, amazon, apple]) await store.payees.put(p);

  const tag = (name: string, groupName: string, color: string, sortOrder: number): TransactionTag =>
    ({ ...baseFields(), name, groupName, color, sortOrder, isActive: true }) as TransactionTag;
  const tagWork = tag('工作日', '场景', '#14b8a6', 10);
  const tagRecurring = tag('固定', '项目', '#6366f1', 20);
  const tagReimburse = tag('待报销', '报销', '#f97316', 30);
  const tagGame = tag('游戏', '项目', '#db2777', 40);
  for (const t of [tagWork, tagRecurring, tagReimburse, tagGame]) await store.transactionTags.put(t);

  const loc = (name: string, address?: string): TransactionLocation =>
    ({ ...baseFields(), name, address, isActive: true }) as TransactionLocation;
  const locHome = loc('家', 'Home');
  const locOffice = loc('公司附近', 'Office area');
  const locStation = loc('地铁站', 'Tube station');
  for (const l of [locHome, locOffice, locStation]) await store.transactionLocations.put(l);

  const tx = (
    date: string,
    time: string,
    type: Transaction['type'],
    category: Transaction['category'],
    amount: string,
    description: string,
    merchant?: string,
    payeeId?: string,
    tagIds: string[] = [],
    locationId?: string,
  ): Transaction => ({
    ...baseFields(),
    date,
    time,
    timezone: 'Asia/Shanghai',
    type,
    category,
    amount,
    assetId: gbp.id,
    accountId: bank.id,
    status: 'cleared',
    description,
    merchant,
    payeeId,
    tagIds,
    locationId,
  }) as Transaction;
  const amazonPurchase = tx('2026-02-16', '20:18', 'expense', 'shopping', '86.5', '生活用品', 'Amazon', amazon.id);
  const appleRefund: Transaction = {
    ...tx('2026-02-25', '16:45', 'refund', 'shopping', '42', '设备退款', 'Apple', apple.id, [tagReimburse.id]),
    refundForId: amazonPurchase.id,
    refundAppliedAmount: '42',
    refundAppliedAssetId: gbp.id,
  };
  for (const t of [
    tx('2026-03-01', '09:10', 'income', 'salary', '3200', '三月工资', '雇主', employer.id, [tagRecurring.id], locHome.id),
    tx('2026-03-02', '08:40', 'expense', 'housing', '980', '房租', '公寓', apartment.id, [tagRecurring.id], locHome.id),
    tx('2026-03-03', '13:04', 'expense', 'food', '18.6', '午餐', 'Noodle Bar', noodle.id, [tagWork.id], locOffice.id),
    tx('2026-03-03', '08:35', 'expense', 'transport', '6.8', '地铁通勤', 'TfL', tfl.id, [tagWork.id], locStation.id),
    amazonPurchase,
    appleRefund,
    { ...tx(localDate(), '10:20', 'transfer', 'other_expense', '120', '取现', 'ATM'), accountId: bank.id, transferAccountId: cash.id, transferAssetId: gbp.id, transferAmount: '120' } as Transaction,
  ]) await saveTransaction(store, t);

  const tpl = (name: string, type: Transaction['type'], category: string, amount: string, payeeId?: string, tagIds: string[] = [], locationId?: string): TransactionTemplate =>
    ({
      ...baseFields(), name, type, category, amount, assetId: gbp.id, accountId: bank.id,
      payeeId, tagIds, locationId, description: name, sortOrder: tagIds.includes(tagRecurring.id) ? 20 : 10,
      isActive: true,
    }) as TransactionTemplate;
  for (const t of [
    tpl('午餐', 'expense', 'food', '18.6', noodle.id, [tagWork.id], locOffice.id),
    tpl('房租', 'expense', 'housing', '980', apartment.id, [tagRecurring.id], locHome.id),
    tpl('工资', 'income', 'salary', '3200', employer.id, [tagRecurring.id], locHome.id),
  ]) await store.transactionTemplates.put(t);

  const savedView = (name: string, query: unknown, sortOrder: number): TransactionSavedView =>
    ({ ...baseFields(), name, queryJson: JSON.stringify(query), sortOrder, isPinned: true, isActive: true }) as TransactionSavedView;
  for (const v of [
    savedView('本月餐饮', {
      range: 'this_month', type: 'expense', category: 'food', accountId: 'all',
      payeeId: 'all', tagId: 'all', status: 'all', amountMin: '', amountMax: '', search: '',
    }, 10),
    savedView('待报销', {
      range: 'all', type: 'all', category: 'all', accountId: 'all',
      payeeId: 'all', tagId: tagReimburse.id, status: 'all', amountMin: '', amountMax: '', search: '',
      advanced: { op: 'or', groups: [{ id: newId(), op: 'and', conditions: [{ id: newId(), field: 'tagId', op: 'eq', value: tagReimburse.id }] }] },
    }, 20),
  ]) await store.transactionSavedViews.put(v);

  const budget = (category: string, plannedAmount: string): BudgetCategory =>
    ({ ...baseFields(), month: '2026-03', category, plannedAmount, assetId: gbp.id, rolloverMode: 'none' }) as BudgetCategory;
  for (const b of [
    budget('food', '420'),
    budget('transport', '160'),
    budget('shopping', '300'),
    budget('housing', '980'),
    budget('entertainment', '180'),
  ]) await store.budgetCategories.put(b);

  const schedule = (name: string, type: Transaction['type'], category: string, amount: string, anchorDate: string, payeeId?: string): ScheduledTransaction =>
    ({
      ...baseFields(), name, type, category, amount, assetId: gbp.id, accountId: bank.id,
      payeeId, frequency: 'monthly', anchorDate, anchorMode: 'calendar_day', time: '09:00', timezone: 'Europe/London',
      autoCreate: false, catchUpPolicy: 'all', status: 'active',
    }) as ScheduledTransaction;
  for (const s of [
    schedule('工资', 'income', 'salary', '3200', '2026-04-01', employer.id),
    schedule('房租', 'expense', 'housing', '980', '2026-04-02', apartment.id),
  ]) await store.scheduledTransactions.put(s);

  // ── price marks (quote in GBP) ──
  const mark = (assetId: string, price: string): PriceMark =>
    ({ ...baseFields(), assetId, quoteAssetId: gbp.id, price, date: localDate(), source: 'manual' }) as PriceMark;
  await store.priceMarks.put(mark(btc.id, '73200'));
  await store.priceMarks.put(mark(eth.id, '2620'));
  await store.priceMarks.put(mark(usdt.id, '0.792'));

  // ── conversion chains (c1..c5, from the prototype) ──
  const chain = (date: string, type: ConversionChain['type'], title: string): ConversionChain =>
    ({ ...baseFields(), date, type, title, baseCurrencyAssetId: gbp.id }) as ConversionChain;
  const step = (
    chainId: string, order: number, fromAssetId: string, fromAmount: string,
    toAssetId: string, toAmount: string, fee?: { assetId: string; amount: string; base?: string }, rate?: string,
  ): ConversionStep => {
    const targetFee = fee?.assetId === toAssetId;
    return {
      id: newId(), chainId, order, fromAssetId, fromAmount, toAssetId,
      toAmount: targetFee ? D(toAmount).plus(fee.amount).toString() : toAmount,
      sourceAmountMode: 'trade_principal', targetAmountMode: 'trade_gross',
      fees: fee ? [{
        id: newId(), assetId: fee.assetId, amount: fee.amount,
        treatment: fee.assetId === fromAssetId ? 'source_extra' : targetFee ? 'target_deducted' : 'third_asset_extra',
        valueInBase: fee.base,
      }] : [],
      referenceRate: rate,
    };
  };

  // opening deposit (£4,000 external → bank) so cash-on-hand is positive
  const dep = chain('2025-11-01', 'deposit', '入金 · 汇丰');
  {
    const s = step(dep.id, 1, gbp.id, '4000', gbp.id, '4000');
    s.accountFromId = external.id;
    s.accountToId = bank.id;
    await recordConversion(store, { chain: dep, steps: [s] });
  }

  const plan = { ...baseFields(), name: 'BTC 每周定投', targetAssetId: btc.id, baseCurrencyAssetId: gbp.id,
    defaultPath: 'GBP → USDT → BTC', anchorDate: '2025-12-08', anchorMode: 'calendar_day', timezone: 'Asia/Shanghai',
    frequency: 'weekly', plannedAmount: '250', reminderDaysBefore: 3, status: 'active' } as never;
  await store.dcaPlans.put(plan);

  // 6 BTC DCA rounds — each is a real GBP→USDT→BTC chain. recordConversion saves
  // the chain and creates the cost-basis lot (business logic lives in the service).
  // [date, usdtMid, btcOut, feeGbp, feeUsdt, feeUsdtBase, rate]
  const rounds: [string, string, string, string, string, string, string][] = [
    ['2025-12-08', '314.20', '0.004276', '1.50', '0.50', '0.40', '73200'],
    ['2025-12-22', '313.80', '0.004033', '1.50', '0.50', '0.40', '77500'],
    ['2026-01-06', '313.10', '0.003827', '1.50', '0.50', '0.40', '81300'],
    ['2026-01-20', '312.90', '0.003594', '1.50', '0.50', '0.40', '86400'],
    ['2026-02-16', '312.60', '0.003454', '1.50', '0.55', '0.44', '90400'],
    ['2026-03-02', '312.10', '0.003317', '1.50', '0.60', '0.48', '93850'],
  ];
  for (const [occurrenceIndex, round] of rounds.entries()) {
    const [date, usdtMid, btcOut, feeGbp, feeUsdt, feeUsdtBase, rate] = round;
    const ch = chain(date, 'dca', 'GBP → USDT → BTC 定投');
    const usdtPrincipal = D(usdtMid).minus(feeUsdt).toString();
    const { chain: saved } = await recordConversion(store, {
      chain: ch,
      steps: [
        step(ch.id, 1, gbp.id, '250', usdt.id, usdtMid, { assetId: gbp.id, amount: feeGbp }, '1.256'),
        step(ch.id, 2, usdt.id, usdtPrincipal, btc.id, btcOut, { assetId: usdt.id, amount: feeUsdt, base: feeUsdtBase }, rate),
      ],
    });
    await store.dcaExecutions.put({
      ...baseFields(), planId: (plan as { id: string }).id, occurrenceIndex,
      scheduledDate: addDays('2025-12-08', occurrenceIndex * 7), date, plannedAmount: '250',
      actualBaseCost: saved.totalBaseCost ?? '0', baseCurrencyAssetId: gbp.id, finalAssetId: btc.id,
      finalAmount: btcOut, totalFeeInBase: saved.totalFeesInBase ?? '0', chainId: saved.id,
    } as DcaExecution);
  }

  // one ETH DCA round
  const ethChain = chain('2026-01-20', 'dca', 'GBP → USDT → ETH 定投');
  await recordConversion(store, {
    chain: ethChain,
    steps: [
      step(ethChain.id, 1, gbp.id, '250', usdt.id, '311.90', { assetId: gbp.id, amount: '1.50' }, '1.256'),
      step(ethChain.id, 2, usdt.id, '311.10', eth.id, '0.118', { assetId: usdt.id, amount: '0.80', base: '0.63' }, '2635'),
    ],
  });

  // buy some USDT to hold, then change 150 of it back to GBP
  const buyUsdt = chain('2026-02-05', 'exchange', 'GBP → USDT 换汇');
  await recordConversion(store, {
    chain: buyUsdt,
    steps: [step(buyUsdt.id, 1, gbp.id, '215', usdt.id, '270', { assetId: gbp.id, amount: '1.00' }, '1.256')],
  });
  const c3 = chain('2026-02-10', 'exchange', 'USDT → GBP 换汇');
  await recordConversion(store, {
    chain: c3,
    steps: [step(c3.id, 1, usdt.id, '150', gbp.id, '118.40', { assetId: gbp.id, amount: '0.60' }, '0.792')],
  });

  // sell 0.005 BTC (BTC → USDT → GBP) — recordSell matches lots (FIFO) and books P&L
  const c2 = chain('2026-02-24', 'sell', 'BTC → USDT → GBP 卖出');
  await recordSell(store, {
    chain: c2,
    steps: [
      step(c2.id, 1, btc.id, '0.005', usdt.id, '488.60', { assetId: usdt.id, amount: '0.80', base: '0.64' }, '98000'),
      step(c2.id, 2, usdt.id, '488.60', gbp.id, '387.90', { assetId: gbp.id, amount: '1.30' }, '0.796'),
    ],
    method: 'fifo',
  });

  // ── game: 深渊回响 ──
  const game: Game = { ...baseFields(), name: '深渊回响', platform: 'PC', serverName: '欧服', enableSeason: true, isActive: true } as Game;
  await store.games.put(game);
  const ashen: GameAccount = { ...baseFields(), gameId: game.id, accountName: 'Ashen 主号', status: 'active' } as GameAccount;
  const ember: GameAccount = { ...baseFields(), gameId: game.id, accountName: 'Emberling 小号', status: 'active' } as GameAccount;
  await store.gameAccounts.put(ashen);
  await store.gameAccounts.put(ember);

  const s2: GameSeason = { ...baseFields(), gameId: game.id, name: 'S2 · 灰烬余烬', seasonNo: 'S2',
    startDate: '2025-12-20', status: 'active', hours: '42' } as GameSeason;
  const s1: GameSeason = { ...baseFields(), gameId: game.id, name: 'S1 · 初火纪元', seasonNo: 'S1',
    startDate: '2025-09-01', endDate: '2025-12-15', status: 'ended', hours: '96' } as GameSeason;
  await store.gameSeasons.put(s2);
  await store.gameSeasons.put(s1);

  const gr = (
    seasonId: string, accId: string, date: string, recordType: GameRecord['recordType'],
    item: string, qty: string | undefined, amt: string,
  ): GameRecord => ({
    ...baseFields(), date, gameId: game.id, seasonId, gameAccountId: accId, recordType,
    gameCurrencyName: qty ? '初火' : undefined, gameCurrencyAmount: qty,
    settlementAssetId: amt === '0' ? undefined : gbp.id,
    settlementAmount: amt === '0' ? undefined : amt,
    note: item,
  });
  const s2r: GameRecord[] = [
    gr(s2.id, ashen.id, '2025-12-22', 'buy_currency', '初火 ×4,000', '4000', '16.0'),
    gr(s2.id, ashen.id, '2026-01-05', 'produce', '初火 ×6,200 · 深渊掉落', '6200', '0'),
    gr(s2.id, ashen.id, '2026-02-03', 'sell_equipment', '暗焰长弓 ×1 · 换得初火', '2500', '0'),
    gr(s2.id, ember.id, '2026-02-10', 'sell_material', '星陨石 ×120 · 换得初火', '1500', '0'),
    gr(s2.id, ashen.id, '2026-02-12', 'buy_equipment', '霜纹护符 ×1 · 花费初火', '800', '0'),
    gr(s2.id, ashen.id, '2026-02-18', 'topup', '赛季月卡', undefined, '8.0'),
    gr(s2.id, ashen.id, '2026-02-28', 'sell_currency', '初火 ×8,000', '8000', '31.6'),
    gr(s2.id, ashen.id, '2026-03-01', 'fee', '平台交易抽成', undefined, '2.1'),
  ];
  const s1r: GameRecord[] = [
    gr(s1.id, ashen.id, '2025-09-05', 'buy_currency', '初火 ×10,000', '10000', '40.0'),
    gr(s1.id, ashen.id, '2025-10-12', 'produce', '初火 ×14,500 · 活动', '14500', '0'),
    gr(s1.id, ashen.id, '2025-11-02', 'sell_equipment', '寒霜战铠 ×1 · 换得初火', '6000', '0'),
    gr(s1.id, ashen.id, '2025-11-20', 'sell_currency', '初火 ×22,000', '22000', '68.0'),
    gr(s1.id, ashen.id, '2025-12-01', 'topup', '赛季通行证', undefined, '16.0'),
    gr(s1.id, ashen.id, '2025-12-10', 'fee', '平台交易抽成', undefined, '5.6'),
  ];
  for (const r of [...s2r, ...s1r]) await store.gameRecords.put(r);

  // ── fixed assets ──
  const fa = (name: string, categoryId: string, tag: string, status: FixedAsset['status'], purchaseDate: string, extra: Partial<FixedAsset> = {}): FixedAsset =>
    ({ ...baseFields(), name, categoryId, tag, status, purchaseDate, baseCurrencyAssetId: gbp.id, ...extra }) as FixedAsset;
  const fe = (assetId: string, type: FixedAssetEvent['type'], date: string, amount: string, note?: string): FixedAssetEvent =>
    ({
      ...baseFields(), fixedAssetId: assetId, type, date, amountBase: amount, note,
      cashflowMode: type === 'purchase' || type === 'repair' || type === 'upgrade' || type === 'sale' ? 'record_only' : undefined,
    }) as FixedAssetEvent;

  const iphone = fa('iPhone 15 Pro', 'fixed-electronics-phone', '主力机', 'active', '2024-05-10', { brand: 'Apple', model: 'iPhone 15 Pro', serialNumber: 'DEMO-IP15', warrantyEndDate: '2025-05-10', purchaseMerchant: 'Apple Store' });
  const macbook = fa('MacBook Pro 14"', 'fixed-electronics-computer', '工作机', 'active', '2023-11-02', { brand: 'Apple', model: 'MacBook Pro 14', warrantyEndDate: '2026-11-02' });
  const sony = fa('Sony A7C', 'fixed-electronics-camera', '相机', 'active', '2024-08-20', { brand: 'Sony', model: 'A7C', warrantyEndDate: '2026-08-20' });
  const ps5 = fa('PlayStation 5', 'fixed-electronics-game', '游戏机', 'sold', '2022-06-15', { brand: 'Sony', model: 'CFI-1000' });
  const car = fa('Corolla Hybrid', 'fixed-vehicle-car', '家庭用车', 'active', '2024-01-15', { brand: 'Toyota', model: 'Corolla Hybrid', activatedDate: '2024-01-15', barcode: 'VIN-DEMO-COROLLA', warrantyEndDate: '2027-01-15' });
  const aircon = fa('客厅空调', 'fixed-appliance-aircon', '客厅', 'active', '2025-05-20', { brand: 'Midea', model: 'KFR Demo', activatedDate: '2025-05-22', warrantyEndDate: '2031-05-20' });
  for (const f of [iphone, macbook, sony, ps5, car, aircon]) await store.fixedAssets.put(f);

  const events: FixedAssetEvent[] = [
    fe(iphone.id, 'purchase', '2024-05-10', '999'),
    fe(iphone.id, 'residual_update', '2026-03-01', '520'),
    fe(macbook.id, 'purchase', '2023-11-02', '1899'), fe(macbook.id, 'repair', '2025-06-18', '180', '换电池'),
    fe(macbook.id, 'residual_update', '2026-03-01', '1150'),
    fe(sony.id, 'purchase', '2024-08-20', '1450'), fe(sony.id, 'repair', '2026-02-20', '85', '快门'),
    fe(sony.id, 'residual_update', '2026-03-01', '980'),
    fe(ps5.id, 'purchase', '2022-06-15', '449'),
    fe(ps5.id, 'sale', '2024-06-05', '260'),
    fe(car.id, 'purchase', '2024-01-15', '12000'), fe(car.id, 'residual_update', '2026-03-01', '9300'),
    fe(aircon.id, 'purchase', '2025-05-20', '620'), fe(aircon.id, 'activate', '2025-05-22', '0'),
  ];
  for (const e of events) await store.fixedAssetEvents.put(e);

  const metric = (fixedAssetId: string, name: string, unit: FixedAssetUsageMetric['unit'], entryMode: FixedAssetUsageMetric['entryMode'], startValue: string): FixedAssetUsageMetric =>
    ({ ...baseFields(), fixedAssetId, name, unit, entryMode, startValue, isPrimary: true, isActive: true, sortOrder: 10 }) as FixedAssetUsageMetric;
  const carKm = metric(car.id, '总里程', 'km', 'meter', '12000');
  const airHours = metric(aircon.id, '实际使用时长', 'hour', 'increment', '0');
  await store.fixedAssetUsageMetrics.put(carKm);
  await store.fixedAssetUsageMetrics.put(airHours);
  const usageLog = (fixedAssetId: string, metricId: string, date: string, value: string, entryMode: FixedAssetUsageLog['entryMode'], note?: string): FixedAssetUsageLog =>
    ({ ...baseFields(), fixedAssetId, metricId, date, value, entryMode, note }) as FixedAssetUsageLog;
  for (const log of [
    usageLog(car.id, carKm.id, '2025-01-01', '20500', 'meter'),
    usageLog(car.id, carKm.id, '2026-03-01', '28750', 'meter'),
    usageLog(aircon.id, airHours.id, '2025-08-31', '340', 'increment', '首个夏季'),
    usageLog(aircon.id, airHours.id, '2026-03-01', '95', 'increment', '冬季制热'),
  ]) await store.fixedAssetUsageLogs.put(log);

  const consumable = (fixedAssetId: string, name: string, amountBase: string, purchaseDate: string, usageMetricId?: string, installedAtUsage?: string, targetLife?: string): FixedAssetConsumable =>
    ({ ...baseFields(), fixedAssetId, name, amountBase, cashflowMode: 'record_only', purchaseDate, installedDate: purchaseDate, usageMetricId, installedAtUsage, targetLife, reminderAtRemaining: targetLife ? D(targetLife).times('0.1').toString() : undefined, status: 'active' }) as FixedAssetConsumable;
  for (const item of [
    consumable(iphone.id, '保护壳与钢化膜', '45', '2024-05-12'),
    consumable(macbook.id, '扩展坞', '30', '2024-01-10'),
    consumable(sony.id, '备用电池与存储卡', '60', '2024-09-01'),
    consumable(ps5.id, '第二只手柄', '120', '2023-01-10'),
    consumable(car.id, '空调滤芯', '28', '2025-09-01', carKm.id, '24500', '10000'),
    consumable(aircon.id, '回风滤网', '18', '2025-05-22', airHours.id, '0', '500'),
  ]) await store.fixedAssetConsumables.put(item);

  const goal = (fixedAssetId: string, name: string, unit: FixedAssetGoal['unit'], costBasisAmount: string, targetUnitCost: string, targetUsage: string, startDate: string, metricId?: string): FixedAssetGoal =>
    ({ ...baseFields(), fixedAssetId, name, metricId, unit, mode: 'unit_cost', costBasisAmount, targetUnitCost, targetUsage, startDate, status: 'active' }) as FixedAssetGoal;
  await store.fixedAssetGoals.put(goal(aircon.id, '每小时使用成本控制', 'hour', '638', '1.5', D('638').div('1.5').ceil().toString(), '2025-05-22', airHours.id));
  await store.fixedAssetGoals.put(goal(car.id, '每公里净使用成本', 'km', '12028', '0.5', D('12028').div('0.5').ceil().toString(), '2024-01-15', carKm.id));
  }, 'system', { undoable: false });
}

/** Kept for fixture compatibility; production startup must use seedDemoLedger explicitly. */
export const seedIfEmpty = seedDemoLedger;
