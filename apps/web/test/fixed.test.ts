import { describe, it, expect } from 'vitest';
import { newId, round, type FixedAssetCashflowLink, type FixedAssetConsumable, type Transaction } from '@zichan/core';
import { buildFixed, canConvertFixedUpgrade, canPlaceFixedComponent } from '../src/selectors/fixed.js';
import { fixedAssetForm, fixedComponentPlacementForm, fixedConsumableForm, fixedEventForm } from '../src/forms.js';
import { makeSnapshot, makeTransaction } from './fixtures.js';

describe('buildFixed', () => {
  const vms = buildFixed(makeSnapshot());

  it('keeps reference value out of net investment', () => {
    expect(vms.length).toBe(1);
    const f = vms[0]!;
    expect(f.name).toBe('笔记本');
    expect(f.sold).toBe(false);
    expect(f.category).toBe('电脑');
    expect(round(f.net, 2)).toBe('500.00');
  });

  it('rows and timeline expose the normalized lifecycle', () => {
    const f = vms[0]!;
    expect(f.rows.map((r) => r.l)).toEqual(['累计支出', '累计回款', '维修／升级支出', '耗材支出']);
    expect(f.rows[0]!.v).toBe('£500.00');
    expect(f.rows[1]!.v).toBe('£0.00');
    expect(f.timeline.map((e) => e.label)).toEqual(['更新参考现值', '购入物品']);
    expect(f.timeline.find((event) => event.label === '购入物品')?.detail).toBe('仅登记，不影响余额');
  });

  it('places consumable installation and replacement on their actual dates', () => {
    const snap = makeSnapshot();
    snap.fixedConsumables.push({
      id: newId(), createdAt: '', updatedAt: '', version: 1, isDeleted: false,
      fixedAssetId: snap.fixedAssets[0]!.id,
      name: '空调滤芯', amountBase: '20', cashflowMode: 'record_only', purchaseDate: '2026-01-01',
      installedDate: '2026-01-03', replacedDate: '2026-03-08', status: 'replaced',
    } as FixedAssetConsumable);

    const timeline = buildFixed(snap)[0]!.timeline;
    expect(timeline.filter((event) => event.kind === 'consumable').map((event) => [event.label, event.date])).toEqual([
      ['更换耗材', '2026-03-08'],
      ['安装耗材', '2026-01-03'],
      ['购入耗材', '2026-01-01'],
    ]);
    expect(timeline.find((event) => event.label === '购入耗材')).toMatchObject({ moneyKind: 'spend', amount: '£20.00' });
    expect(timeline.find((event) => event.label === '安装耗材')?.amount).toBeUndefined();
  });

  it('marks spending, recovery, and reference amounts separately in the timeline', () => {
    const snap = makeSnapshot();
    const original = snap.fixedEvents[0]!;
    snap.fixedEvents.push(
      { ...original, id: newId(), type: 'upgrade', amountBase: '200', date: '2026-04-01' },
      { ...original, id: newId(), type: 'part_sale', amountBase: '40', date: '2026-04-02', note: '旧内存' },
      { ...original, id: newId(), type: 'sale', amountBase: '300', date: '2026-04-03' },
    );
    const timeline = buildFixed(snap, '2026-04-04')[0]!.timeline;
    expect(timeline.find((event) => event.label === '购入物品')).toMatchObject({ moneyKind: 'spend', amount: '£500.00' });
    expect(timeline.find((event) => event.label === '升级／改造支出')).toMatchObject({ moneyKind: 'spend', amount: '£200.00' });
    expect(timeline.find((event) => event.label === '卖出配件')).toMatchObject({ moneyKind: 'recover', amount: '£40.00' });
    expect(timeline.find((event) => event.label === '卖出整件物品')).toMatchObject({ moneyKind: 'recover', amount: '£300.00' });
    expect(timeline.find((event) => event.label === '更新参考现值')).toMatchObject({ moneyKind: 'reference', amount: '£300.00' });
  });

  it('exposes native barcode scanning and direct camera capture fields', () => {
    const form = fixedAssetForm(makeSnapshot());
    expect(form.fields.find((field) => field.key === 'barcode')).toMatchObject({ deviceAction: 'scan-barcode' });
    expect(form.fields.find((field) => field.key === 'imageFiles')).toMatchObject({ capture: 'environment' });
    expect(form.fields.find((field) => field.key === 'invoiceFiles')).toMatchObject({ capture: 'environment' });
  });

  it('asks for the purchase merchant once and shares it with a newly created cash flow', () => {
    const spec = fixedAssetForm(makeSnapshot());
    expect(spec.fields.filter((field) => field.type === 'payee').map((field) => field.key)).toEqual(['purchaseMerchant']);
    expect(spec.onFieldChange?.({ purchaseMerchant: '京东', cashflowMerchant: '', cashflowPayeeId: 'old' },
      'purchaseMerchant', new Set())).toMatchObject({ purchaseMerchant: '京东', cashflowMerchant: '京东', cashflowPayeeId: '' });
    expect(spec.onFieldChange?.({ purchaseMerchant: '资料商户', cashflowMerchant: '原流水商户' }, 'name', new Set()))
      .toMatchObject({ purchaseMerchant: '资料商户', cashflowMerchant: '原流水商户' });
    expect(spec.onFieldChange?.({ purchaseMerchant: '资料商户', cashflowMerchant: '原流水商户',
      cashflowMode: 'create_transaction' }, 'cashflowMode', new Set()))
      .toMatchObject({ purchaseMerchant: '资料商户', cashflowMerchant: '资料商户' });
    expect(spec.fields.find((field) => field.key === 'purchaseMerchant')?.visibleWhen?.({ bundledFromAssetId: 'host' })).toBe(false);
    expect(spec.moreInitiallyOpen).toBe(false);
    expect(spec.fields.find((field) => field.key === 'serialNumber')?.section).toBe('more');
  });

  it('uses the item merchant when an older created cash flow has a different merchant', () => {
    const snap = makeSnapshot();
    const asset = { ...snap.fixedAssets[0]!, purchaseMerchant: '资料商户' };
    const purchase = { ...snap.fixedEvents.find((row) => row.type === 'purchase')!, cashflowMode: 'create_transaction' as const };
    const transactionId = newId();
    snap.transactions.push({ id: transactionId, merchant: '旧流水商户', payeeId: 'old-payee' } as Transaction);
    snap.fixedCashflowLinks.push({ sourceType: 'event', sourceId: purchase.id, transactionId } as FixedAssetCashflowLink);
    const values = fixedAssetForm(snap, [], purchase).toValues(asset);
    expect(values).toMatchObject({ purchaseMerchant: '资料商户', cashflowMerchant: '资料商户', cashflowPayeeId: '' });
  });

  it('prefills a same-currency linked amount and keeps terminal status out of new item choices', () => {
    const snap = makeSnapshot();
    const spec = fixedAssetForm(snap);
    const amount = spec.onFieldChange?.({ cashflowMode: 'linked_transaction', purchaseAmount: '500',
      baseCurrencyAssetId: snap.fixedAssets[0]!.baseCurrencyAssetId, cashflowSourceAmount: '' }, 'cashflowMode', new Set());
    expect(amount?.cashflowSourceAmount).toBe('500');
    const status = spec.fields.find((field) => field.key === 'status')!;
    expect(typeof status.options === 'function' ? status.options({ status: 'active' }).map((row) => row.value) : []).toEqual(['active', 'stored']);
    expect(status.visibleWhen?.({ status: 'sold' })).toBe(false);
  });

  it('offers one explicit cashflow mode for acquisition, lifecycle events, and consumables', () => {
    const snap = makeSnapshot();
    const modes = ['record_only', 'linked_transaction', 'create_transaction'];
    for (const form of [
      fixedAssetForm(snap),
      fixedEventForm(snap, snap.fixedAssets[0]!.id),
      fixedConsumableForm(snap, snap.fixedAssets[0]!.id, []),
    ]) {
      expect(form.fields.find((field) => field.key === 'cashflowMode')?.options)
        .toEqual(expect.arrayContaining(modes.map((value) => expect.objectContaining({ value }))));
    }
    expect(fixedEventForm(snap, snap.fixedAssets[0]!.id).fields
      .find((field) => field.key === 'cashflowReportingTreatment')?.options)
      .toEqual(expect.arrayContaining([
        expect.objectContaining({ value: 'ordinary' }),
        expect.objectContaining({ value: 'balance_only' }),
      ]));
  });

  it('keeps spare consumables simple and asks for dates and readings only when relevant', () => {
    const snap = makeSnapshot();
    const metric = { id: 'metric', createdAt: '', updatedAt: '', version: 1, isDeleted: false,
      fixedAssetId: snap.fixedAssets[0]!.id, name: '打印页数', unit: 'count' as const, entryMode: 'increment' as const,
      startValue: '0', isPrimary: true, isActive: true };
    const spec = fixedConsumableForm(snap, snap.fixedAssets[0]!.id, [metric]);
    const field = (key: string) => spec.fields.find((row) => row.key === key)!;
    expect(spec.moreInitiallyOpen).toBe(false);
    expect(spec.fields.filter((row) => row.type === 'payee').map((row) => row.key)).toEqual(['purchaseMerchant']);
    expect(spec.onFieldChange?.({ purchaseMerchant: '京东', cashflowMerchant: '', cashflowPayeeId: 'old' },
      'purchaseMerchant', new Set())).toMatchObject({ cashflowMerchant: '京东', cashflowPayeeId: '' });
    expect(spec.onFieldChange?.({ purchaseMerchant: '京东', cashflowMerchant: '', cashflowMode: 'create_transaction' },
      'cashflowMode', new Set())).toMatchObject({ cashflowMerchant: '京东' });
    expect(field('category').section).toBe('more');
    expect(field('usageMetricId').visibleWhen?.({ installedDate: '' })).toBe(false);
    expect(field('usageMetricId').visibleWhen?.({ installedDate: '2026-03-01' })).toBe(true);
    expect(field('replacedDate').visibleWhen?.({ status: 'active' })).toBe(false);
    expect(field('replacedDate').visibleWhen?.({ status: 'replaced' })).toBe(true);
    expect(spec.validate?.({ amountBase: '20', purchaseDate: '2026-03-03', installedDate: '2026-03-01', status: 'active', cashflowMode: 'record_only' }))
      .toMatchObject({ installedDate: '安装日期不能早于购买日期' });
    expect(spec.validate?.({ amountBase: '20', purchaseDate: '2026-03-01', status: 'replaced', cashflowMode: 'record_only' }))
      .toMatchObject({ replacedDate: '请填写更换或丢弃日期' });
    expect(spec.fromValues({ name: '备用墨盒', amountBase: '20', purchaseDate: '2026-03-01', status: 'active',
      cashflowMode: 'record_only', purchaseMerchant: '京东', usageMetricId: '', replacedDate: '2026-03-02' }))
      .toMatchObject({ status: 'active', purchaseMerchant: '京东', replacedDate: undefined });
  });

  it('prefills linked consumable spending only when the transaction uses the item currency', () => {
    const snap = makeSnapshot();
    const spec = fixedConsumableForm(snap, snap.fixedAssets[0]!.id, []);
    const same = spec.onFieldChange?.({ cashflowMode: 'linked_transaction', amountBase: '50',
      cashflowTransactionId: '', cashflowSourceAmount: '' }, 'cashflowMode', new Set());
    expect(same?.cashflowSourceAmount).toBe('50');
    snap.transactions.push(makeTransaction({ id: 'btc-expense', assetId: snap.ids.btc }));
    const different = spec.onFieldChange?.({ cashflowMode: 'linked_transaction', amountBase: '50',
      cashflowTransactionId: 'btc-expense', cashflowSourceAmount: '50' }, 'cashflowTransactionId', new Set());
    expect(different?.cashflowSourceAmount).toBe('');
  });

  it('records an installation without another purchase or cash flow', () => {
    const snap = makeSnapshot();
    const component = { ...snap.fixedAssets[0]!, id: 'new-ram', role: 'component' as const };
    snap.fixedAssets.push(component);
    const spec = fixedComponentPlacementForm(snap, component.id);
    const event = spec.fromValues({ type: 'install', date: '2026-04-01', hostAssetId: snap.fixedAssets[0]!.id, note: '' });
    expect(event).toMatchObject({ fixedAssetId: component.id, hostAssetId: snap.fixedAssets[0]!.id, amountBase: '0' });
    expect(event.cashflowMode).toBeUndefined();
  });

  it('removes component actions after an item is sold', () => {
    const snap = makeSnapshot();
    const host = snap.fixedAssets[0]!;
    const upgrade = { ...snap.fixedEvents[0]!, id: newId(), type: 'upgrade' as const, amountBase: '222', date: '2026-10-05' };
    expect(canPlaceFixedComponent(host)).toBe(true);
    expect(canConvertFixedUpgrade(host, upgrade)).toBe(true);

    const sold = { ...host, status: 'sold' as const };
    expect(canPlaceFixedComponent(sold)).toBe(false);
    expect(canConvertFixedUpgrade(sold, upgrade)).toBe(false);
    expect(canConvertFixedUpgrade(host, { ...upgrade, amountBase: '0' })).toBe(false);
  });
});
