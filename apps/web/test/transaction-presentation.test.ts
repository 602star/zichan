import { describe, expect, it } from 'vitest';
import { transactionForm } from '../src/forms.js';
import { moreFieldsSummaryLabel, progressiveFieldGroups } from '../src/form-validation.js';
import {
  COMMON_TRANSACTION_FORM_FIELDS,
  optionalTransactionFields,
  transactionFormFieldGroups,
  transactionFormFieldOptions,
} from '../src/transactionFormPrefs.js';
import { makeSnapshot } from './fixtures.js';

const keys = (fields: { key: string }[]) => fields.map((f) => f.key);
describe('transaction form presentation', () => {
  it('keeps phone date and time together and migrates the old location text preference', () => {
    const snap = makeSnapshot();
    const spec = transactionForm(snap);
    expect(spec.compactDateTime).toBe(true);
    snap.setting!.transactionFormOptionalFields = 'locationName,locationId,note';
    expect(optionalTransactionFields(snap.setting, true)).toEqual(['locationId', 'note']);
    expect(spec.optionalFieldOptions!.filter((field) => field.key.startsWith('location'))).toEqual([{ key: 'locationId', label: '地点', group: 'daily' }]);
    const groups = progressiveFieldGroups(spec.fields, { type: 'expense' }, { locationName: '旧记录的手填地点' }, []);
    expect(keys(groups.core)).toContain('locationId');
    expect(keys(groups.core)).not.toContain('locationName');
  });

  it('replaces saved location coordinates when selecting or typing a different place', () => {
    const snap = makeSnapshot();
    const location = snap.transactionLocations[0]!;
    location.latitude = '31.23'; location.longitude = '121.47';
    const spec = transactionForm(snap);
    const selected = spec.onFieldChange!({ locationId: location.id, locationName: '旧文本', latitude: '1', longitude: '2', locationAccuracyMeters: '10' }, 'locationId', new Set());
    expect(selected).toMatchObject({ locationName: location.name, latitude: '31.23', longitude: '121.47', locationAccuracyMeters: '' });
    const typed = spec.onFieldChange!({ ...selected, locationId: '', locationName: '新地点' }, 'locationId', new Set());
    expect(typed).toMatchObject({ locationId: '', locationName: '新地点', latitude: '', longitude: '', locationAccuracyMeters: '' });
  });

  it('shows the currency beside the amount and keeps its selector in more information', () => {
    const snap = makeSnapshot();
    const spec = transactionForm(snap);
    expect(spec.modalWidth).toBe(880);
    const groups = progressiveFieldGroups(spec.fields, { type: 'expense' }, {}, []);
    expect(keys(groups.core)).toEqual(expect.arrayContaining(['amount', 'date', 'time', 'category', 'accountId', 'attachmentDrafts']));
    expect(keys(groups.more)).toEqual(expect.arrayContaining(['assetId', 'note']));
    const amount = spec.fields.find((field) => field.key === 'amount')!;
    expect(typeof amount.suffix === 'function' ? amount.suffix({ assetId: snap.ids.gbp }) : amount.suffix).toBe('英镑');
    expect(typeof amount.suffix === 'function' ? amount.suffix({ assetId: snap.ids.btc }) : amount.suffix).toBe('比特币');
    expect(spec.fields.find((field) => field.key === 'assetId')?.defaultValue).toBe(snap.ids.gbp);
    expect(spec.fields.find((field) => field.key === 'assetId')?.assetPresetOptions).toBe(true);
    const populated = progressiveFieldGroups(spec.fields, { type: 'expense', assetId: snap.ids.btc }, { assetId: snap.ids.btc }, []);
    expect(keys(populated.more)).toContain('assetId');
    snap.setting!.transactionDefaultAssetId = snap.ids.btc;
    const withChangedDefault = transactionForm(snap);
    expect(withChangedDefault.fields.find((field) => field.key === 'assetId')?.defaultValue).toBe(snap.ids.btc);
  });
  it('promotes existing business data without promoting automatic defaults or changing preferences', () => {
    const spec = transactionForm(makeSnapshot());
    const defaults = Object.fromEntries(spec.fields.map((f) => [f.key, f.defaultValue ?? '']));
    const preferences: string[] = [];
    const groups = progressiveFieldGroups(spec.fields, { type: 'expense' }, { ...defaults, merchant: '旧商户', note: '旧备注', tagIds: 'tag-reimburse' }, preferences);
    expect(keys(groups.core)).toEqual(expect.arrayContaining(['payeeId', 'note', 'tagIds']));
    expect(keys(groups.more)).toEqual(expect.arrayContaining(['status', 'timezone']));
    expect(preferences).toEqual([]);
  });
  it('keeps all unpinned fields reachable and shows pinned ones immediately', () => {
    const spec = transactionForm(makeSnapshot());
    const groups = progressiveFieldGroups(spec.fields, { type: 'expense' }, {}, ['note']);
    expect(keys(groups.core)).toContain('note');
    expect(keys(groups.more)).toContain('payeeId');
  });
  it('moves phone extras below the fold while retaining populated and required fields', () => {
    const spec = transactionForm(makeSnapshot());
    const compactKeys = spec.compactNewFieldKeys!;
    const empty = progressiveFieldGroups(spec.fields, { type: 'expense' }, {}, [], compactKeys);
    expect(keys(empty.more)).toEqual(expect.arrayContaining(['assetId', 'time', 'note']));
    expect(keys(empty.core)).toEqual(expect.arrayContaining(['amount', 'date', 'category', 'attachmentDrafts']));

    const populated = progressiveFieldGroups(spec.fields, { type: 'expense' }, { time: '13:45', attachmentDrafts: '[{"fileName":"receipt.jpg"}]' }, [], compactKeys);
    expect(keys(populated.core)).toEqual(expect.arrayContaining(['time', 'attachmentDrafts']));

    const transfer = progressiveFieldGroups(spec.fields, { type: 'transfer' }, {}, [], compactKeys);
    expect(keys(transfer.core)).toEqual(expect.arrayContaining(['transferAccountId', 'transferAssetId', 'transferAmount']));
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

  it('exposes all optional fields in three groups and lets currency and document fields be pinned', () => {
    const snap = makeSnapshot();
    const groupsWithAccounts = transactionFormFieldGroups(true);
    expect(groupsWithAccounts.map((g) => ({ key: g.key, keys: g.fields.map((f) => f.key) }))).toEqual([
      { key: 'daily', keys: ['payeeId', 'locationId', 'tagIds', 'note'] },
      { key: 'ledger', keys: ['assetId', 'timezone', 'status'] },
      { key: 'document', keys: ['orderNumber', 'trackingNumber', 'invoiceNumber', 'invoiceCode', 'invoiceDate'] },
    ]);
    const groupsWithoutAccounts = transactionFormFieldGroups(false);
    expect(groupsWithoutAccounts.find((g) => g.key === 'ledger')!.fields.map((f) => f.key)).toEqual(['assetId', 'timezone']);
    expect(COMMON_TRANSACTION_FORM_FIELDS).toEqual(['payeeId', 'locationId', 'tagIds', 'note']);

    snap.setting!.transactionFormOptionalFields = 'assetId,orderNumber,invoiceNumber,note';
    const preferred = optionalTransactionFields(snap.setting, true);
    expect(preferred).toEqual(['assetId', 'orderNumber', 'invoiceNumber', 'note']);

    const spec = transactionForm(snap);
    const pinned = progressiveFieldGroups(spec.fields, { type: 'expense' }, {}, preferred);
    expect(keys(pinned.core)).toEqual(expect.arrayContaining(['assetId', 'orderNumber', 'invoiceNumber', 'note']));
    expect(keys(pinned.more)).toEqual(expect.arrayContaining(['payeeId', 'trackingNumber', 'invoiceCode', 'invoiceDate']));
  });

  it('orders optional fields from high-frequency daily fields to documents and full-width note', () => {
    const snap = makeSnapshot();
    const spec = transactionForm(snap);
    expect(spec.fields[0]?.key).toBe('amount');
    const visibleExpenseKeys = spec.fields
      .filter((f) => !f.hidden && (!f.visibleWhen || f.visibleWhen({ type: 'expense' })))
      .map((f) => f.key);
    expect(visibleExpenseKeys).toEqual([
      'amount', 'type', 'accountId', 'category',
      'date', 'time', 'description', 'attachmentDrafts',
      'assetId', 'payeeId', 'tagIds', 'locationId',
      'status', 'timezone',
      'orderNumber', 'trackingNumber', 'invoiceNumber', 'invoiceCode', 'invoiceDate',
      'note',
    ]);
  });

  it('keeps unpinned OCR document numbers tucked in more fields with a summary badge', () => {
    const snap = makeSnapshot();
    const spec = transactionForm(snap);
    const defaults = Object.fromEntries(spec.fields.map((f) => [f.key, f.defaultValue ?? '']));
    const values = { ...defaults, type: 'expense', orderNumber: '00001234567890', trackingNumber: 'SF1234567890' };
    const groups = progressiveFieldGroups(spec.fields, values, values, COMMON_TRANSACTION_FORM_FIELDS);

    expect(keys(groups.core)).not.toContain('orderNumber');
    expect(keys(groups.core)).not.toContain('trackingNumber');
    expect(keys(groups.more)).toEqual(expect.arrayContaining(['orderNumber', 'trackingNumber', 'invoiceNumber', 'invoiceCode', 'invoiceDate']));

    expect(moreFieldsSummaryLabel(groups.more, defaults, false)).toBe(`更多字段（${groups.more.length}）`);
    expect(moreFieldsSummaryLabel(groups.more, values, false)).toBe(`更多字段（${groups.more.length} · 已填：订单号、物流单号）`);
    expect(moreFieldsSummaryLabel(groups.more, { ...values, invoiceNumber: '12345678' }, false)).toBe(`更多字段（${groups.more.length} · 已填 3 项：订单号、物流单号等）`);
    expect(moreFieldsSummaryLabel(groups.more, values, true)).toBe(`收起更多字段（${groups.more.length} · 已填 2 项）`);
  });
});
