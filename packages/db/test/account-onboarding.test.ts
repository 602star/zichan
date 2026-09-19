import { describe, expect, it } from 'vitest';
import { D, newId, accountOpeningPostings, accountTransactionPostings, computeBalances, type Account, type Transaction } from '@zichan/core';
import { openLedger } from '../src/node.js';
import { ensureDefaultAccounts, createFundAccount, assignTransactionAccounts, previewAccountAssignment } from '../src/account-onboarding.js';
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
  it('creates defaults idempotently, assigns ordinary cashflows, and excludes them from money balances', async () => {
    const { store, setting } = await setup();
    try {
      await ensureDefaultAccounts(store);
      expect(await store.accounts.count()).toBe(2);
      const expense = await saveTransaction(store, transaction('expense', '400', '2026-09-17'));
      const income = await saveTransaction(store, transaction('income', '8000', '2026-09-17'));
      expect(expense.accountId).toBe(setting.expenseDefaultAccountId);
      expect(income.accountId).toBe(setting.incomeDefaultAccountId);
      expect(await store.accountBalanceAggregates()).toEqual([]);
      expect((await store.dashboardTransactionReadModel()).balanceAggregates).toEqual([]);
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
      expect(Object.values(preview.impacts).every((v) => D(v).isZero())).toBe(true);
      await assignTransactionAccounts(store, account.id, [{ id: expense.id, version: expense.version }]);
      expect((await store.accountBalanceAggregates())[0]?.amounts).toEqual(['1200']);
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
      expect((await store.accountBalanceAggregates())[0]?.amounts).toEqual(['1200']);
      await expect(assignTransactionAccounts(store, account.id, [{ id: another.id, version: another.version }, { id: old.id, version: old.version, timing: 'after' }])).rejects.toThrow(/刷新/);
      expect((await store.transactions.get(another.id))?.accountId).toBe(another.accountId);
      const current = (await store.transactions.get(old.id))!;
      await assignTransactionAccounts(store, account.id, [{ id: current.id, version: current.version, timing: 'after' }]);
      expect((await store.accountBalanceAggregates())[0]?.amounts.reduce((sum, value) => sum.plus(value), D(0)).toString()).toBe('1160');
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

it('protects default account roles and default selections', async () => {
  const { store, setting } = await setup();
  try {
    const account = (await store.accounts.get(setting.expenseDefaultAccountId!))!;
    await expect(store.settings.put({ ...setting, expenseDefaultAccountId: setting.incomeDefaultAccountId })).rejects.toThrow(/对应方向/);
    await expect(store.accounts.put({ ...account, isActive: false })).rejects.toThrow(/需要保留/);
    await expect(store.accounts.remove(account.id, account.version)).rejects.toThrow(/不能删除/);
    await expect(saveTransaction(store, transaction('income', '100', '2026-09-18', { accountId: account.id }))).rejects.toThrow(/方向/);
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

it('applies the starting balance only to its currency and includes subsequent asset conversions', async () => {
  const { store } = await setup();
  try {
    await store.assets.put({ ...base(), id: 'USD', code: 'USD', name: '美元', type: 'fiat', decimals: 2, isActive: true });
    const account = await createFundAccount(store, { account: fund() });
    await saveTransaction(store, transaction('income', '20', '2026-09-17', { accountId: account.id, assetId: 'USD' }));
    const chain = { ...base(), type: 'exchange' as const, date: '2026-09-18', time: '15:00:00', timezone: 'Asia/Shanghai', baseCurrencyAssetId: 'CNY' };
    await store.saveChainWithSteps(chain, [{ id: newId(), chainId: chain.id, order: 1, fromAssetId: 'CNY', fromAmount: '100', toAssetId: 'USD', toAmount: '14', accountFromId: account.id, accountToId: account.id }]);
    await saveTransaction(store, transaction('expense', '50', '2026-09-19', { accountId: account.id }));
    const balances = Object.fromEntries((await store.accountBalanceAggregates()).map((r) => [r.assetId, r.amounts.reduce((total, value) => total.plus(value), D(0)).toString()]));
    expect(balances).toEqual({ CNY: '1050', USD: '34' });
    expect((await store.accountLedgerPage({ accountId: account.id })).rows[0]!.balance).toBe('1050');
  } finally { await store.close(); }
});
