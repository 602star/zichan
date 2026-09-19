import { describe, expect, it } from 'vitest';
import { transactionForm } from '../src/forms.js';
import { progressiveFieldGroups } from '../src/form-validation.js';
import { optionalTransactionFields, transactionFormFieldOptions } from '../src/transactionFormPrefs.js';
import { makeSnapshot } from './fixtures.js';

const keys = (fields: { key: string }[]) => fields.map((f) => f.key);
describe('transaction form presentation', () => {
  it('keeps a stable width and all basic information outside more information', () => {
    const spec = transactionForm(makeSnapshot());
    expect(spec.modalWidth).toBe(880);
    const groups = progressiveFieldGroups(spec.fields, { type: 'expense' }, {}, []);
    expect(keys(groups.core)).toEqual(expect.arrayContaining(['amount', 'assetId', 'date', 'time', 'category', 'accountId', 'attachmentDrafts']));
    expect(keys(groups.more)).toContain('note');
  });
  it('promotes existing business data without promoting automatic defaults or changing preferences', () => {
    const spec = transactionForm(makeSnapshot());
    const defaults = Object.fromEntries(spec.fields.map((f) => [f.key, f.defaultValue ?? '']));
    const preferences: string[] = [];
    const groups = progressiveFieldGroups(spec.fields, { type: 'expense' }, { ...defaults, merchant: '旧商户', note: '旧备注', tagIds: 'tag-reimburse' }, preferences);
    expect(keys(groups.core)).toEqual(expect.arrayContaining(['merchant', 'note', 'tagIds']));
    expect(keys(groups.more)).toEqual(expect.arrayContaining(['status', 'timezone']));
    expect(preferences).toEqual([]);
  });
  it('keeps all unpinned fields reachable and shows pinned ones immediately', () => {
    const spec = transactionForm(makeSnapshot());
    const groups = progressiveFieldGroups(spec.fields, { type: 'expense' }, {}, ['note']);
    expect(keys(groups.core)).toContain('note');
    expect(keys(groups.more)).toContain('merchant');
  });
  it('migrates obsolete preference keys while retaining valid choices', () => {
    const snap = makeSnapshot();
    snap.setting!.transactionFormOptionalFields = 'accountId,note,transferAccountId,tagIds,refundForId';
    expect(optionalTransactionFields(snap.setting, true)).toEqual(['note', 'tagIds']);
    const spec = transactionForm(snap);
    expect(spec.optionalFieldOptions).toEqual(transactionFormFieldOptions(true));
    expect(spec.optionalFieldOptions!.some((f) => f.key === 'accountId')).toBe(false);
  });
  it('shows conditional transfer requirements regardless of preferences', () => {
    const spec = transactionForm(makeSnapshot());
    const groups = progressiveFieldGroups(spec.fields, { type: 'transfer' }, {}, []);
    for (const key of ['transferAccountId', 'transferAssetId', 'transferAmount']) {
      expect(keys(groups.core)).toContain(key);
      expect(spec.fields.find((f) => f.key === key)?.required).toBe(true);
    }
    expect(keys(progressiveFieldGroups(spec.fields, { type: 'expense' }, {}, []).core)).not.toContain('refundForId');
  });
  it('uses directional defaults but preserves a manually chosen funds account', () => {
    const snap = makeSnapshot();
    snap.setting!.incomeDefaultAccountId = snap.accounts.find((a) => a.kind === 'cash')!.id;
    const bank = snap.accounts.find((a) => a.kind === 'bank')!;
    const spec = transactionForm(snap);
    const values = { type: 'income', accountId: bank.id };
    expect(spec.onFieldChange!(values, 'type', new Set()).accountId).toBe(snap.setting!.incomeDefaultAccountId);
    expect(spec.onFieldChange!(values, 'type', new Set(['accountId'])).accountId).toBe(bank.id);
  });
  it('retains referenced historical accounts as readable options', () => {
    const snap = makeSnapshot();
    const account = snap.accounts.find((a) => a.kind === 'bank')!;
    account.isActive = false;
    const field = transactionForm(snap).fields.find((f) => f.key === 'accountId')!;
    const options = typeof field.options === 'function' ? field.options({ type: 'expense', accountId: account.id }) : field.options!;
    expect(options.find((o) => o.value === account.id)?.label).toContain('历史账户');
  });
});
