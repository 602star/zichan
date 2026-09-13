import { describe, expect, it } from 'vitest';
import type { FixedAssetUsageMetric } from '@zichan/core';
import * as forms from '../src/forms.js';
import type { EntityFormSpec } from '../src/ui/EntityFormModal.js';
import {
  emptyOptionHint,
  isFieldVisible,
  isMoreFieldVisible,
  renderedFieldKeys,
  requiredFieldErrors,
  unreachableErrorKeys,
  type FormFieldLike,
} from '../src/form-validation.js';
import { makeSnapshot } from './fixtures.js';

type Field = FormFieldLike & {
  type: string;
  allowEmpty?: boolean;
  defaultValue?: string;
  options?: { value: string }[] | ((values: Record<string, string>) => { value: string }[]);
};

function optionsOf(field: Field, values: Record<string, string>): { value: string }[] {
  return typeof field.options === 'function' ? field.options(values) : field.options ?? [];
}

/** Mirrors the modal's initial values so probes start where a real user starts. */
function defaultsOf(fields: Field[]): Record<string, string> {
  const values: Record<string, string> = {};
  for (const field of fields) {
    const options = optionsOf(field, values);
    if (field.defaultValue !== undefined) values[field.key] = field.defaultValue;
    else if (field.type === 'checkbox') values[field.key] = 'false';
    else if (field.type === 'select' || field.type === 'category') values[field.key] = field.allowEmpty ? '' : (options[0]?.value ?? '');
    else values[field.key] = '';
  }
  return values;
}

/**
 * States a user can actually reach: the default state plus every single-select
 * variant. Every required/visibility rule in this app keys off one or two
 * selects (账户类型、资金处理方式、记账模式), so single-field probes cover them.
 */
function probeStates(fields: Field[]): Record<string, string>[] {
  const base = defaultsOf(fields);
  const states = [base];
  for (const field of fields) {
    if (field.type !== 'select' && field.type !== 'category') continue;
    for (const option of optionsOf(field, base)) {
      if (option.value === base[field.key]) continue;
      states.push({ ...base, [field.key]: option.value });
    }
  }
  return states;
}

interface Case {
  name: string;
  build: () => EntityFormSpec<unknown>;
}

function cases(): Case[] {
  const snapshot = (mode: 'spending' | 'accounts' | 'assets' = 'spending') => {
    const snap = makeSnapshot();
    if (snap.setting) snap.setting.ledgerMode = mode;
    snap.fixedAssets = snap.fixedAssets ?? [];
    return snap;
  };
  const fixedAssetId = 'fa-1';
  const metric = { id: 'metric-1', fixedAssetId, name: '里程', unit: 'km', entryMode: 'meter', isActive: true } as unknown as FixedAssetUsageMetric;
  const list: Case[] = [];
  for (const mode of ['spending', 'accounts', 'assets'] as const) {
    const snap = snapshot(mode);
    snap.fixedAssets.push({
      id: fixedAssetId, name: '车', categoryId: 'cat-1', purchaseDate: '2026-01-01',
      purchaseAmount: '100000', baseCurrencyAssetId: snap.ids.gbp, status: 'active',
      createdAt: '', updatedAt: '', version: 1, isDeleted: false,
    } as (typeof snap.fixedAssets)[number]);
    list.push(
      { name: `${mode}/assetForm`, build: () => forms.assetForm() as EntityFormSpec<unknown> },
      { name: `${mode}/accountForm`, build: () => forms.accountForm() as EntityFormSpec<unknown> },
      { name: `${mode}/priceMarkForm`, build: () => forms.priceMarkForm(snap) as EntityFormSpec<unknown> },
      { name: `${mode}/dcaPlanForm`, build: () => forms.dcaPlanForm(snap) as EntityFormSpec<unknown> },
      { name: `${mode}/categoryForm`, build: () => forms.categoryForm(snap) as EntityFormSpec<unknown> },
      { name: `${mode}/transactionTagForm`, build: () => forms.transactionTagForm() as EntityFormSpec<unknown> },
      { name: `${mode}/transactionLocationForm`, build: () => forms.transactionLocationForm() as EntityFormSpec<unknown> },
      { name: `${mode}/transactionTemplateForm`, build: () => forms.transactionTemplateForm(snap) as EntityFormSpec<unknown> },
      { name: `${mode}/payeeForm`, build: () => forms.payeeForm(snap) as EntityFormSpec<unknown> },
      { name: `${mode}/transactionForm`, build: () => forms.transactionForm(snap) as EntityFormSpec<unknown> },
      { name: `${mode}/transactionForm-expenseOnly`, build: () => forms.transactionForm(snap, { expenseOnly: true }) as EntityFormSpec<unknown> },
      { name: `${mode}/transactionForm-refund`, build: () => forms.transactionForm(snap, { refundMode: true }) as EntityFormSpec<unknown> },
      { name: `${mode}/transactionSplitForm`, build: () => forms.transactionSplitForm(snap) as EntityFormSpec<unknown> },
      { name: `${mode}/budgetCategoryForm`, build: () => forms.budgetCategoryForm(snap) as EntityFormSpec<unknown> },
      { name: `${mode}/scheduledTransactionForm`, build: () => forms.scheduledTransactionForm(snap) as EntityFormSpec<unknown> },
      { name: `${mode}/gameForm`, build: () => forms.gameForm() as EntityFormSpec<unknown> },
      { name: `${mode}/gameAccountForm`, build: () => forms.gameAccountForm(snap) as EntityFormSpec<unknown> },
      { name: `${mode}/gameSeasonForm`, build: () => forms.gameSeasonForm(snap) as EntityFormSpec<unknown> },
      { name: `${mode}/gameRecordForm`, build: () => forms.gameRecordForm(snap) as EntityFormSpec<unknown> },
      { name: `${mode}/fixedAssetCategoryForm`, build: () => forms.fixedAssetCategoryForm(snap) as EntityFormSpec<unknown> },
      { name: `${mode}/fixedAssetForm`, build: () => forms.fixedAssetForm(snap) as EntityFormSpec<unknown> },
      { name: `${mode}/fixedEventForm`, build: () => forms.fixedEventForm(snap, fixedAssetId) as EntityFormSpec<unknown> },
      { name: `${mode}/fixedUsageMetricForm`, build: () => forms.fixedUsageMetricForm(fixedAssetId) as EntityFormSpec<unknown> },
      { name: `${mode}/fixedUsageLogForm`, build: () => forms.fixedUsageLogForm(metric) as EntityFormSpec<unknown> },
      { name: `${mode}/fixedConsumableForm`, build: () => forms.fixedConsumableForm(snap, fixedAssetId, [metric]) as EntityFormSpec<unknown> },
      { name: `${mode}/fixedGoalForm`, build: () => forms.fixedGoalForm(fixedAssetId, [metric], '100') as EntityFormSpec<unknown> },
    );
  }
  return list;
}

describe('required fields never block a save from off screen', () => {
  const pickerStates: (string[] | undefined)[] = [undefined, [], ['note'], ['accountId', 'payeeId', 'timezone']];

  for (const testCase of cases()) {
    it(`${testCase.name} only blocks visible fields`, () => {
      const spec = testCase.build() as EntityFormSpec<unknown> & { fields: Field[] };
      const fields = spec.fields as Field[];
      for (const state of probeStates(fields)) {
        for (const optional of pickerStates) {
          const errors = requiredFieldErrors(fields, state);
          expect(unreachableErrorKeys(fields, state, errors, optional)).toEqual([]);
        }
      }
    });
  }
});

describe('required means "required when shown"', () => {
  it('lets a plain bank account save without credit-card days', () => {
    const spec = forms.accountForm() as unknown as { fields: Field[] };
    const values = defaultsOf(spec.fields);
    expect(values.kind).toBe('bank');
    const errors = requiredFieldErrors(spec.fields, values);
    expect(Object.keys(errors)).not.toContain('statementDay');
    expect(Object.keys(errors)).not.toContain('paymentDueDay');
    expect(requiredFieldErrors(spec.fields, { ...values, name: '工资卡' })).toEqual({});
  });

  it('still asks a credit card for its statement and due day', () => {
    const spec = forms.accountForm() as unknown as { fields: Field[] };
    const values = { ...defaultsOf(spec.fields), kind: 'credit_card', name: '信用卡' };
    expect(Object.keys(requiredFieldErrors(spec.fields, values)).sort()).toEqual(['paymentDueDay', 'statementDay']);
  });

  it('lets a record-only fixed asset save without cashflow fields', () => {
    const snap = makeSnapshot();
    if (snap.setting) snap.setting.ledgerMode = 'accounts';
    const spec = forms.fixedAssetForm(snap) as unknown as { fields: Field[] };
    const values = { ...defaultsOf(spec.fields), name: '车', categoryId: 'cat-1' };
    expect(values.cashflowMode).toBe('record_only');
    expect(requiredFieldErrors(spec.fields, values)).toEqual({});
  });

  it('lets a record-only game record save without a settlement account', () => {
    const snap = makeSnapshot();
    if (snap.setting) snap.setting.ledgerMode = 'accounts';
    const spec = forms.gameRecordForm(snap) as unknown as { fields: Field[] };
    const values = { ...defaultsOf(spec.fields), settlementCashflowMode: 'record_only' };
    expect(requiredFieldErrors(spec.fields, values)).toEqual({});
    expect(renderedFieldKeys(spec.fields, values)).not.toContain('settlementAccountId');
  });

  it('never lets the field picker hide a required field', () => {
    const fields: Field[] = [
      { key: 'name', label: '名称', type: 'text', section: 'more', required: true },
      { key: 'note', label: '备注', type: 'text', section: 'more' },
    ];
    expect(isMoreFieldVisible(fields[0]!, {}, [], ['name', 'note'])).toBe(true);
    expect(isMoreFieldVisible(fields[1]!, {}, [], ['name', 'note'])).toBe(false);
    expect(renderedFieldKeys(fields, {}, [])).toEqual(['name']);
  });
});

describe('optional fields stay optional', () => {
  it('accepts a transaction without a description', () => {
    const spec = forms.transactionForm(makeSnapshot()) as unknown as { fields: Field[] };
    const description = spec.fields.find((field) => field.key === 'description')!;
    expect(description.required).toBeFalsy();
    const values = { ...defaultsOf(spec.fields), category: 'food', amount: '10' };
    expect(requiredFieldErrors(spec.fields, values)).toEqual({});
  });

  it('keeps the fields the domain really needs', () => {
    const spec = forms.transactionForm(makeSnapshot()) as unknown as { fields: Field[] };
    const values = { ...defaultsOf(spec.fields), category: 'food', amount: '10' };
    expect(Object.keys(requiredFieldErrors(spec.fields, values))).toEqual([]);
    expect(requiredFieldErrors(spec.fields, { ...values, amount: '' })).toHaveProperty('amount');
  });
});

describe('empty pickers explain themselves', () => {
  it('hints when a required selection has no options yet', () => {
    const field: Field = { key: 'gameId', label: '游戏', type: 'select', required: true };
    expect(emptyOptionHint(field, 0)).toBe('游戏还没有可选项，请先新增');
    expect(emptyOptionHint(field, 2)).toBeUndefined();
    expect(emptyOptionHint({ ...field, required: false }, 0)).toBeUndefined();
  });

  it('marks the game selector as empty when no game exists', () => {
    const snap = makeSnapshot();
    snap.games = [];
    const spec = forms.gameRecordForm(snap) as unknown as { fields: Field[] };
    const game = spec.fields.find((field) => field.key === 'gameId')!;
    expect(optionsOf(game, defaultsOf(spec.fields))).toEqual([]);
    expect(emptyOptionHint(game, 0)).toBe('游戏还没有可选项，请先新增');
  });

  it('hides fields whose visibleWhen is false', () => {
    const field: Field = {
      key: 'statementDay', label: '账单日', type: 'number', required: true,
      visibleWhen: (values) => values.kind === 'credit_card',
    };
    expect(isFieldVisible(field, { kind: 'bank' })).toBe(false);
    expect(requiredFieldErrors([field], { kind: 'bank', statementDay: '' })).toEqual({});
    expect(requiredFieldErrors([field], { kind: 'credit_card', statementDay: '' })).toEqual({ statementDay: '请填写账单日' });
  });
});
