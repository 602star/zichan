import { describe, expect, it } from 'vitest';
import { D, newId, accountOpeningPostings, accountTransactionPostings, computeBalances, type Account, type Transaction } from '@zichan/core';
import { openLedger } from '../src/node.js';
import { ensureDefaultAccounts, createFundAccount, saveAccountDetails, setDefaultTransactionAccounts, assignTransactionAccounts, previewAccountAssignment } from '../src/account-onboarding.js';
import { saveTransaction, previewReconciliation, exportLedger, restoreLedger } from '../src/services.js';

const base = () => ({ id: newId(), createdAt: '', updatedAt: '', version: 1, isDeleted: false });
async function setup() {
  const store = await openLedger();
  await store.assets.put({ ...base(), id: 'CNY', code: 'CNY', name: '人民币', type: 'fiat', decimals: 2, isActive: true });
  await store.settings.put({ ...base(), baseCurrencyAssetId: 'CNY', defaultLotMethod: 'fifo', ledgerMode: 'spending' });
  const setting = (await ensureDefaultAccounts(store))!;
  return { store, setting };
}
function transaction(type: Transaction['type'], amount: string, date: string, extra: Partial<Transaction> = {}): Transaction {
  return { ...base(), type, amount, date, timezone: 'Asia/Shanghai', assetId: 'CNY', category: type === 'income' ? 'salary' : 'food', ...extra };
}
function fund(amount = '1200'): Account {
  return { ...base(), name: '微信零钱', kind: 'wallet', purpose: 'funds', isActive: true,
    openingAssetId: 'CNY', openingBalance: amount, balanceStartDate: '2026-09-18', balanceStartAt: '2026-09-18T06:30:00.000Z' };
}

describe('default accounts to fund accounts', () => {
  it('normalizes legacy defaults in place without moving or rewriting their history', async () => {
    const store = await openLedger();
    try {
      await store.assets.put({ ...base(), id: 'CNY', code: 'CNY', name: '人民币', type: 'fiat', decimals: 2, isActive: true });
      const expense = await store.accounts.put({ ...base(), kind: 'wallet', purpose: 'default_expense', name: '旧默认支出', isActive: true });
      const income = await store.accounts.put({ ...base(), kind: 'wallet', purpose: 'default_income', name: '旧默认收入', isActive: true });
      await store.settings.put({ ...base(), baseCurrencyAssetId: 'CNY', defaultLotMethod: 'fifo', expenseDefaultAccountId: expense.id, incomeDefaultAccountId: income.id });
      const old = await saveTransaction(store, transaction('expense', '12.34', '2026-09-17'));
      const legacyBackup = await exportLedger(store);
      await ensureDefaultAccounts(store);
      const migrated = (await store.accounts.get(expense.id))!;
      expect(migrated).toMatchObject({ id: expense.id, kind: 'other', purpose: 'default_expense', name: '旧默认支出' });
      expect(await store.accounts.count()).toBe(2);
      expect(await store.transactions.get(old.id)).toEqual(old);
      expect((await store.accountBalanceAggregates()).find((r) => r.accountId === expense.id)?.amounts).toEqual(['-12.34']);
      await ensureDefaultAccounts(store);
      expect((await store.accounts.get(expense.id))?.version).toBe(migrated.version);
      await saveAccountDetails(store, { account: { ...migrated, name: '综合账户' }, defaultExpense: true, defaultIncome: true });
      expect((await saveTransaction(store, transaction('income', '20', '2026-09-18'))).accountId).toBe(expense.id);
      expect((await store.accountLedgerPage({ accountId: expense.id })).rows[0]?.balance).toBe('7.66');
      const restored = await openLedger();
      try {
        await restoreLedger(restored, legacyBackup);
        expect((await restored.accounts.get(expense.id))).toMatchObject({ kind: 'other', purpose: 'default_expense' });
        expect((await restored.transactions.get(old.id))?.accountId).toBe(expense.id);
        expect((await restored.accountLedgerPage({ accountId: expense.id })).rows[0]?.balance).toBe('-12.34');
      } finally { await restored.close(); }
    } finally { await store.close(); }
  });

  it('restores and can undo older reconciliation history on system accounts without allowing new reconciliation', async () => {
    const { store, setting } = await setup();
    const restored = await openLedger();
    try {
      const { undoLatestReconciliation } = await import('../src/services.js');
      const session = await store.reconciliationSessions.put({ ...base(), accountId: setting.expenseDefaultAccountId!, assetId: 'CNY', statementDate: '2026-09-17',
        statementBalance: '0', openingBalance: '0', selectedTotal: '0', clearedBalance: '0', difference: '0', status: 'closed', closedAt: '2026-09-17T12:00:00.000Z' });
      await restoreLedger(restored, await exportLedger(store));
      expect((await restored.reconciliationSessions.get(session.id))?.statementBalance).toBe('0');
      await expect(previewReconciliation(restored, { accountId: session.accountId, assetId: 'CNY', statementDate: '2026-09-18', statementBalance: '0', selectedTransactionIds: [] })).rejects.toThrow('系统预建');
      await undoLatestReconciliation(restored, session.id);
      expect(await restored.reconciliationSessions.count()).toBe(0);
      expect(await restored.transactions.count()).toBe(0);
    } finally { await store.close(); await restored.close(); }
  });

  it('sets independent defaults for new spending and income without moving earlier transactions', async () => {
    const { store, setting } = await setup();
    try {
      const old = await saveTransaction(store, transaction('expense', '12.34', '2026-09-17'));
      const wallet = await createFundAccount(store, { account: fund('1000') });
      const bank = await createFundAccount(store, { account: { ...fund('2000'), id: newId(), name: '工资卡', kind: 'bank' } });
      await setDefaultTransactionAccounts(store, { expenseAccountId: wallet.id, incomeAccountId: bank.id, expectedVersion: setting.version });
      expect((await store.transactions.get(old.id))?.accountId).toBe(setting.expenseDefaultAccountId);
      expect((await saveTransaction(store, transaction('expense', '100.01', '2026-09-19'))).accountId).toBe(wallet.id);
      expect((await saveTransaction(store, transaction('income', '300.02', '2026-09-19'))).accountId).toBe(bank.id);
      const balances = await store.accountBalanceAggregates();
      const total = (id: string) => balances.filter((row) => row.accountId === id).flatMap((row) => row.amounts).reduce((sum, value) => sum.plus(value), D(0)).toString();
      expect(total(wallet.id)).toBe('899.99');
      expect(total(bank.id)).toBe('2300.02');
      await setDefaultTransactionAccounts(store, { expenseAccountId: setting.expenseDefaultAccountId!, incomeAccountId: setting.incomeDefaultAccountId! });
      expect((await saveTransaction(store, transaction('expense', '1.01', '2026-09-20'))).accountId).toBe(setting.expenseDefaultAccountId);
    } finally { await store.close(); }
  });

  it('rejects inactive and stale defaults atomically, while allowing either default account in both directions', async () => {
    const { store, setting } = await setup();
    try {
      const wallet = await createFundAccount(store, { account: fund() });
      const inactive = await createFundAccount(store, { account: { ...fund(), id: newId(), name: '停用卡', isActive: false } });
      await expect(setDefaultTransactionAccounts(store, { expenseAccountId: wallet.id, incomeAccountId: inactive.id })).rejects.toThrow('默认账户');
      expect((await store.settings.list())[0]?.expenseDefaultAccountId).toBe(setting.expenseDefaultAccountId);
      await setDefaultTransactionAccounts(store, { expenseAccountId: setting.incomeDefaultAccountId!, incomeAccountId: wallet.id });
      const currentSetting = (await store.settings.list())[0]!;
      const saved = await setDefaultTransactionAccounts(store, { expenseAccountId: wallet.id, incomeAccountId: wallet.id, expectedVersion: currentSetting.version });
      await expect(setDefaultTransactionAccounts(store, { expenseAccountId: setting.expenseDefaultAccountId!, incomeAccountId: setting.incomeDefaultAccountId!, expectedVersion: setting.version })).rejects.toThrow('已变化');
      expect((await store.settings.list())[0]?.version).toBe(saved.version);
      await expect(saveAccountDetails(store, { account: { ...wallet, name: '不应保存' }, defaultExpense: false, defaultIncome: false, expectedSettingVersion: setting.version })).rejects.toThrow('已变化');
      expect((await store.accounts.get(wallet.id))?.name).toBe(wallet.name);
    } finally { await store.close(); }
  });
  it('creates ordinary other-type accounts idempotently and includes their cashflows in balances', async () => {
    const { store, setting } = await setup();
    try {
      await ensureDefaultAccounts(store);
      expect(await store.accounts.count()).toBe(2);
      const expense = await saveTransaction(store, transaction('expense', '400', '2026-09-17'));
      const income = await saveTransaction(store, transaction('income', '8000', '2026-09-17'));
      expect(expense.accountId).toBe(setting.expenseDefaultAccountId);
      expect(income.accountId).toBe(setting.incomeDefaultAccountId);
      expect((await store.accounts.list()).every((a) => a.purpose === 'funds' && a.kind === 'other')).toBe(true);
      const balances = await store.accountBalanceAggregates();
      const balance = (id: string) => balances.filter((r) => r.accountId === id).flatMap((r) => r.amounts).reduce((s, n) => s.plus(n), D(0)).toString();
      expect(balance(expense.accountId!)).toBe('-400');
      expect(balance(income.accountId!)).toBe('8000');
      const dashboard = (await store.dashboardTransactionReadModel()).balanceAggregates;
      expect(dashboard.flatMap((r) => r.amounts).reduce((s, n) => s.plus(n), D(0)).toString()).toBe('7600');
      const reports = await store.transactionReportAggregate({});
      expect(reports.length).toBeGreaterThan(0);
    } finally { await store.close(); }
  });

  it('keeps the snapshot when assigning old spending, then posts new spending and a later refund exactly once', async () => {
    const { store, setting } = await setup();
    try {
      const expense = await saveTransaction(store, transaction('expense', '400', '2026-09-17'));
      const account = await createFundAccount(store, { account: fund(), defaultExpense: true });
      expect((await store.settings.list())[0]?.incomeDefaultAccountId).toBe(setting.incomeDefaultAccountId);
      const preview = await previewAccountAssignment(store, account.id, [{ id: expense.id, version: expense.version }]);
      expect(preview.impacts[`${expense.accountId}|CNY`]).toBe('400');
      expect(preview.impacts[`${account.id}|CNY`] ?? '0').toBe('0');
      await assignTransactionAccounts(store, account.id, [{ id: expense.id, version: expense.version }]);
      expect((await store.accountBalanceAggregates()).find((r) => r.accountId === account.id)?.amounts).toEqual(['1200']);
      await saveTransaction(store, transaction('expense', '100', '2026-09-18', { time: '15:00:00' }));
      const refund = await saveTransaction(store, transaction('refund', '400', '2026-09-18', { time: '16:00:00', refundForId: expense.id }));
      expect(refund.accountId).toBe(account.id);
      const aggregated = await store.accountBalanceAggregates();
      expect(aggregated[0]?.amounts.reduce((sum, value) => sum.plus(value), D(0)).toString()).toBe('1500');
      const accounts = await store.accounts.list();
      const postings = [...accountOpeningPostings(accounts), ...(await store.transactions.list()).flatMap((t) => accountTransactionPostings(t, accounts))];
      expect(computeBalances(postings, { perAccount: true })[0]?.amount).toBe('1500');
      const reconciliation = await previewReconciliation(store, { accountId: account.id, assetId: 'CNY', statementDate: '2026-09-18', statementBalance: '1500', selectedTransactionIds: [] });
      expect(reconciliation.excluded?.beforeOpening).toBe(1);
      expect(reconciliation.openingBalance).toBe('1200');
      expect(reconciliation.candidates.map((row) => row.transaction.id)).not.toContain(expense.id);
      expect((await store.accountLedgerPage({ accountId: account.id })).rows[0]?.balance).toBe('1500');
      const copy = await openLedger();
      try {
        await restoreLedger(copy, await exportLedger(store));
        expect(await copy.accountBalanceAggregates()).toEqual(aggregated);
      } finally { await copy.close(); }
    } finally { await store.close(); }
  });

  it('requires a same-day boundary choice and refuses stale batch updates without partial writes', async () => {
    const { store } = await setup();
    try {
      const old = await saveTransaction(store, transaction('expense', '40', '2026-09-18'));
      const another = await saveTransaction(store, transaction('expense', '10', '2026-09-17'));
      const account = await createFundAccount(store, { account: fund() });
      await expect(previewAccountAssignment(store, account.id, [{ id: old.id, version: old.version }])).rejects.toThrow(/之前还是之后/);
      await assignTransactionAccounts(store, account.id, [{ id: old.id, version: old.version, timing: 'before' }]);
      expect((await store.accountBalanceAggregates()).find((r) => r.accountId === account.id)?.amounts).toEqual(['1200']);
      await expect(assignTransactionAccounts(store, account.id, [{ id: another.id, version: another.version }, { id: old.id, version: old.version, timing: 'after' }])).rejects.toThrow(/刷新/);
      expect((await store.transactions.get(another.id))?.accountId).toBe(another.accountId);
      const current = (await store.transactions.get(old.id))!;
      await assignTransactionAccounts(store, account.id, [{ id: current.id, version: current.version, timing: 'after' }]);
      expect((await store.accountBalanceAggregates()).find((r) => r.accountId === account.id)?.amounts.reduce((sum, value) => sum.plus(value), D(0)).toString()).toBe('1160');
    } finally { await store.close(); }
  });
});

it('preserves a later balance checkpoint when reconstructing an earlier start, and blocks unexplained differences', async () => {
  const { previewEarlierBalance, applyEarlierBalance } = await import('../src/account-onboarding.js');
  const { store } = await setup();
  try {
    const account = await createFundAccount(store, { account: fund() });
    await saveTransaction(store, transaction('expense', '400', '2026-09-17', { accountId: account.id }));
    const input = { accountId: account.id, openingBalance: '1500', balanceStartAt: '2026-09-16T00:00:00.000Z', balanceStartDate: '2026-09-16' };
    const mismatch = await previewEarlierBalance(store, input);
    expect(mismatch.difference).toBe('-100');
    await expect(applyEarlierBalance(store, input, mismatch.signature)).rejects.toThrow(/仍有差额/);
    input.openingBalance = '1600';
    const matching = await previewEarlierBalance(store, input);
    expect(matching.difference).toBe('0');
    await applyEarlierBalance(store, input, matching.signature);
    const saved = (await store.accounts.get(account.id))!;
    expect(saved.openingBalance).toBe('1600');
    expect(saved.balanceCheckpoints).toEqual([{ at: account.balanceStartAt, date: account.balanceStartDate, assetId: 'CNY', balance: '1200' }]);
    expect((await store.accountBalanceAggregates())[0]!.amounts.reduce((a, b) => a.plus(b), D(0)).toString()).toBe('1200');
    const copy = await openLedger();
    try { await restoreLedger(copy, await exportLedger(store)); expect((await copy.accounts.get(account.id))!.balanceCheckpoints).toEqual(saved.balanceCheckpoints); }
    finally { await copy.close(); }
  } finally { await store.close(); }
});

it('uses normal account rules for default accounts, including transfers, both directions and deletion when unreferenced', async () => {
  const { store, setting } = await setup();
  try {
    const account = (await store.accounts.get(setting.expenseDefaultAccountId!))!;
    await setDefaultTransactionAccounts(store, { expenseAccountId: account.id, incomeAccountId: account.id });
    await saveTransaction(store, transaction('expense', '100', '2026-09-18'));
    await saveTransaction(store, transaction('income', '200', '2026-09-18'));
    const bank = await createFundAccount(store, { account: fund('500') });
    await saveTransaction(store, transaction('transfer', '25', '2026-09-19', { accountId: account.id, transferAccountId: bank.id, transferAmount: '25', transferAssetId: 'CNY' }));
    const balances = await store.accountBalanceAggregates();
    expect(balances.find((r) => r.accountId === account.id)?.amounts.reduce((s, n) => s.plus(n), D(0)).toString()).toBe('75');
    expect(balances.find((r) => r.accountId === bank.id)?.amounts.reduce((s, n) => s.plus(n), D(0)).toString()).toBe('525');
    const candidates = (await store.accountLedgerPage({ accountId: account.id })).rows.map((r) => r.transaction!.id);
    await expect(previewReconciliation(store, { accountId: account.id, assetId: 'CNY', statementDate: '2026-09-19', statementBalance: '75', selectedTransactionIds: candidates })).rejects.toThrow('系统预建账户不进行');
    const customOther = await createFundAccount(store, { account: { ...fund('10'), id: newId(), kind: 'other' } });
    expect((await previewReconciliation(store, { accountId: customOther.id, assetId: 'CNY', statementDate: '2026-09-19', statementBalance: '10', selectedTransactionIds: [] })).difference).toBe('0');
    const unused = (await store.accounts.get(setting.incomeDefaultAccountId!))!;
    const disabled = await store.accounts.put({ ...unused, isActive: false });
    await store.accounts.remove(disabled.id, disabled.version);
    await ensureDefaultAccounts(store);
    expect(await store.accounts.count()).toBe(3);
  } finally { await store.close(); }
});

it('syncs account initialization, historical attribution and an earlier balance checkpoint', async () => {
  const { memoryCommitTransport, syncReplica, previewEarlierBalance, applyEarlierBalance } = await import('../src/index.js');
  const { store } = await setup();
  const remote = await openLedger({ deviceId: 'remote-account-test' });
  const transport = memoryCommitTransport();
  try {
    await remote.adoptLedgerId(await store.getLedgerId());
    const sync = async () => { await syncReplica(store, transport, 'memory'); const result = await syncReplica(remote, transport, 'memory'); expect(result).toMatchObject({ conflicts: 0, invalid: 0, pending: 0 }); };
    const expense = await saveTransaction(store, transaction('expense', '400', '2026-09-18'));
    const account = await createFundAccount(store, { account: fund(), defaultExpense: true });
    await sync();
    await ensureDefaultAccounts(remote);
    expect(await remote.accounts.count()).toBe(3);
    await assignTransactionAccounts(store, account.id, [{ id: expense.id, version: expense.version, timing: 'before' }]);
    await sync();
    expect((await remote.transactions.get(expense.id))!.accountId).toBe(account.id);
    const input = { accountId: account.id, openingBalance: '1600', balanceStartAt: '2026-09-16T00:00:00.000Z', balanceStartDate: '2026-09-16' };
    const preview = await previewEarlierBalance(store, input);
    await applyEarlierBalance(store, input, preview.signature);
    await sync();
    expect((await remote.accounts.get(account.id))!.balanceCheckpoints).toEqual((await store.accounts.get(account.id))!.balanceCheckpoints);
    expect(await remote.accountBalanceAggregates()).toEqual(await store.accountBalanceAggregates());
  } finally { await store.close(); await remote.close(); }
});

it('applies other-type account starting balances only to their currency and includes subsequent asset conversions', async () => {
  const { store } = await setup();
  try {
    await store.assets.put({ ...base(), id: 'USD', code: 'USD', name: '美元', type: 'fiat', decimals: 2, isActive: true });
    const account = await createFundAccount(store, { account: { ...fund(), kind: 'other' } });
    await saveTransaction(store, transaction('income', '20', '2026-09-17', { accountId: account.id, assetId: 'USD' }));
    const chain = { ...base(), type: 'exchange' as const, date: '2026-09-18', time: '15:00:00', timezone: 'Asia/Shanghai', baseCurrencyAssetId: 'CNY' };
    await store.saveChainWithSteps(chain, [{ id: newId(), chainId: chain.id, order: 1, fromAssetId: 'CNY', fromAmount: '100', toAssetId: 'USD', toAmount: '14', accountFromId: account.id, accountToId: account.id }]);
    await saveTransaction(store, transaction('expense', '50', '2026-09-19', { accountId: account.id }));
    const balances = Object.fromEntries((await store.accountBalanceAggregates()).map((r) => [r.assetId, r.amounts.reduce((total, value) => total.plus(value), D(0)).toString()]));
    expect(balances).toEqual({ CNY: '1050', USD: '34' });
    expect((await store.accountLedgerPage({ accountId: account.id })).rows[0]!.balance).toBe('1050');
  } finally { await store.close(); }
});


it('edits account metadata and defaults atomically without rewriting the balance origin', async () => {
  const { store, setting } = await setup();
  try {
    const created = await createFundAccount(store, { account: fund() });
    const saved = await saveAccountDetails(store, { account: { ...created, note: 'Edited', openingBalance: '9999' }, defaultExpense: true, defaultIncome: false });
    expect(saved.openingBalance).toBe(created.openingBalance);
    expect(saved.balanceStartAt).toBe(created.balanceStartAt);
    expect((await store.settings.get(setting.id))?.expenseDefaultAccountId).toBe(saved.id);
    const reset = await saveAccountDetails(store, { account: saved, defaultExpense: false, defaultIncome: false });
    expect((await store.settings.get(setting.id))?.expenseDefaultAccountId).toBe(setting.expenseDefaultAccountId);
    await expect(saveAccountDetails(store, { account: { ...reset, kind: 'credit_card', statementDay: 99 }, defaultExpense: true, defaultIncome: true })).rejects.toThrow();
    expect((await store.settings.get(setting.id))?.expenseDefaultAccountId).toBe(setting.expenseDefaultAccountId);
  } finally { await store.close(); }
});
