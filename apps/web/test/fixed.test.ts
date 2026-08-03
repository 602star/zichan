import { describe, it, expect } from 'vitest';
import { newId, round, type FixedAssetConsumable } from '@zichan/core';
import { buildFixed } from '../src/selectors/fixed.js';
import { fixedAssetForm, fixedConsumableForm, fixedEventForm } from '../src/forms.js';
import { makeSnapshot } from './fixtures.js';

describe('buildFixed', () => {
  const vms = buildFixed(makeSnapshot());

  it('one active card with net = invested cost minus user-entered residual', () => {
    expect(vms.length).toBe(1);
    const f = vms[0]!;
    expect(f.name).toBe('笔记本');
    expect(f.sold).toBe(false);
    expect(f.category).toBe('电脑');
    expect(round(f.net, 2)).toBe('200.00');
  });

  it('rows and timeline expose the normalized lifecycle', () => {
    const f = vms[0]!;
    expect(f.rows.map((r) => r.l)).toEqual(['累计投入', '当前残值', '维修升级', '耗材成本']);
    expect(f.rows[0]!.v).toBe('£500.00');
    expect(f.rows[1]!.v).toBe('£300.00');
    expect(f.timeline.map((e) => e.label)).toEqual(['更新残值', '购买']);
    expect(f.timeline.find((event) => event.label === '购买')?.detail).toBe('仅登记，不影响余额');
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
    ]);
  });

  it('exposes native barcode scanning and direct camera capture fields', () => {
    const form = fixedAssetForm(makeSnapshot());
    expect(form.fields.find((field) => field.key === 'barcode')).toMatchObject({ deviceAction: 'scan-barcode' });
    expect(form.fields.find((field) => field.key === 'imageFiles')).toMatchObject({ capture: 'environment' });
    expect(form.fields.find((field) => field.key === 'invoiceFiles')).toMatchObject({ capture: 'environment' });
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
});
