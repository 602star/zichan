import { describe, expect, it } from 'vitest';
import {
  CATEGORY_PACKS,
  newId,
  type Account,
  type Asset,
  type Transaction,
} from '@zichan/core';
import {
  disableSystemCategories,
  enableSystemCategories,
  saveTransactionAggregate,
} from '../src/index.js';
import { openLedger } from '../src/node.js';

const base = () => ({
  id: newId(),
  createdAt: '',
  updatedAt: '',
  version: 1,
  isDeleted: false,
});

async function seedMoney(store: Awaited<ReturnType<typeof openLedger>>) {
  const asset = await store.assets.put({
    ...base(),
    code: 'CNY',
    name: '人民币',
    type: 'fiat',
    decimals: 2,
    symbol: '¥',
    isActive: true,
  } as Asset);
  const account = await store.accounts.put({
    ...base(),
    name: '日常账户',
    kind: 'bank',
    isActive: true,
  } as Account);
  return { asset, account };
}

describe('category catalog and account modes', () => {
  it('materializes a catalog category and its parent when first referenced', async () => {
    const store = await openLedger();
    const { asset, account } = await seedMoney(store);
    expect(await store.categories.get('pet_medical')).toBeNull();

    const transaction: Transaction = {
      ...base(),
      date: '2026-07-23',
      timePrecision: 'day',
      type: 'expense',
      category: 'pet_medical',
      amount: '88',
      assetId: asset.id,
      accountId: account.id,
      status: 'cleared',
      recordState: 'active',
    };
    await saveTransactionAggregate(store, { transaction });

    const parent = await store.categories.get('expense_home');
    expect(parent).toMatchObject({ id: 'expense_home' });
    expect(parent?.parentId).toBeUndefined();
    expect(await store.categories.get('pet_medical')).toMatchObject({
      id: 'pet_medical',
      parentId: 'expense_home',
      isHidden: true,
    });
    await store.close();
  });

  it('disables every pack category without changing historical transactions and can re-enable them', async () => {
    const store = await openLedger();
    const { asset, account } = await seedMoney(store);
    const pack = CATEGORY_PACKS.find((candidate) => candidate.id === 'pet')!;
    await enableSystemCategories(store, pack.categoryIds);
    expect(await store.categories.get('pet_medical')).toMatchObject({ isActive: true, isHidden: false });
    expect(await store.categories.get('pet_food')).toMatchObject({ isActive: true, isHidden: false });
    const saved = await saveTransactionAggregate(store, {
      transaction: {
        ...base(),
        date: '2026-07-23',
        timePrecision: 'day',
        type: 'expense',
        category: 'pet_medical',
        amount: '88',
        assetId: asset.id,
        accountId: account.id,
        status: 'cleared',
        recordState: 'active',
      } as Transaction,
    });

    const result = await disableSystemCategories(store, pack.categoryIds);
    expect(result.retainedUsedIds).toContain('pet_medical');
    expect(result.disabledIds).toEqual(expect.arrayContaining(pack.categoryIds));
    expect(await store.categories.get('pet_medical')).toMatchObject({ isActive: false, isHidden: true, archiveReason: '系统分类包停用' });
    expect(await store.categories.get('pet_food')).toMatchObject({ isActive: false, isHidden: true, archiveReason: '系统分类包停用' });
    expect(await store.transactions.get(saved.transaction.id)).toMatchObject({ category: 'pet_medical', amount: '88' });

    await enableSystemCategories(store, pack.categoryIds);
    const restoredMedical = await store.categories.get('pet_medical');
    const restoredFood = await store.categories.get('pet_food');
    expect(restoredMedical).toMatchObject({ isActive: true, isHidden: false });
    expect(restoredFood).toMatchObject({ isActive: true, isHidden: false });
    expect(restoredMedical).not.toHaveProperty('archivedAt');
    expect(restoredMedical).not.toHaveProperty('archiveReason');
    expect(restoredFood).not.toHaveProperty('archivedAt');
    expect(restoredFood).not.toHaveProperty('archiveReason');
    await store.close();
  });

  it('validates credit-card billing fields and real loan calendar dates', async () => {
    const store = await openLedger();
    await expect(store.accounts.put({
      ...base(),
      name: '信用卡',
      kind: 'credit_card',
      paymentDueDay: 20,
      isActive: true,
    } as Account)).rejects.toThrow('信用卡必须填写账单日');
    await expect(store.accounts.put({
      ...base(),
      name: '信用卡',
      kind: 'credit_card',
      statementDay: 31,
      paymentDueDay: 32,
      isActive: true,
    } as Account)).rejects.toThrow('还款日必须是 1-31');
    await expect(store.accounts.put({
      ...base(),
      name: '房贷',
      kind: 'loan',
      loanStartDate: '2026-02-30',
      isActive: true,
    } as Account)).rejects.toThrow('贷款开始日期无效');

    const credit = await store.accounts.put({
      ...base(),
      name: '信用卡',
      kind: 'credit_card',
      statementDay: 31,
      paymentDueDay: 20,
      creditLimit: '50000',
      isActive: true,
    } as Account);
    expect(credit).toMatchObject({ statementDay: 31, paymentDueDay: 20, creditLimit: '50000' });
    await store.close();
  });
});
