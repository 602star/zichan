import { describe, it, expect } from 'vitest';
import { round } from '@zichan/core';
import { balances, balanceOfAsset, priceInBase, baseAsset } from '../src/db/derive.js';
import { makeSnapshot, makeTransaction } from './fixtures.js';

describe('derive', () => {
  const snap = makeSnapshot();

  it('baseAsset resolves from the setting', () => {
    expect(baseAsset(snap)?.code).toBe('GBP');
  });

  it('priceInBase: base = 1, crypto from latest mark', () => {
    expect(priceInBase(snap, snap.ids.gbp)).toBe('1');
    expect(priceInBase(snap, snap.ids.btc)).toBe('70000');
  });

  it('balances exclude external equity and unlinked game reporting records', () => {
    // deposit +1000 to bank, buy −600 → cash 400; game records need a linked transaction.
    expect(round(balanceOfAsset(snap, snap.ids.gbp), 2)).toBe('400.00');
    expect(round(balanceOfAsset(snap, snap.ids.btc), 8)).toBe('0.01000000');
  });

  it('balances include daily transactions', () => {
    const s = makeSnapshot();
    s.transactions = [
      makeTransaction({ type: 'income', category: 'salary', amount: '3000', assetId: s.ids.gbp }),
      makeTransaction({ type: 'expense', category: 'food', amount: '25.50', assetId: s.ids.gbp }),
    ];
    expect(round(balanceOfAsset(s, s.ids.gbp), 2)).toBe('3374.50');
  });

  it('balances() returns one row per asset', () => {
    const b = balances(snap);
    expect(new Set(b.map((x) => x.assetId)).size).toBe(b.length);
  });
});
