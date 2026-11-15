import { describe, expect, it } from 'vitest';
import { formTaskGroups } from '../src/ui/form-task-groups.js';
import { mobileViewKey } from '../src/ui/MobilePage.js';
import { buildGameSeason, ALL_GAME_RECORDS } from '../src/selectors/game.js';
import { makeSnapshot } from './fixtures.js';

describe('mobile task groups', () => {
  it('keeps every field exactly once while separating game identity from financial accounts', () => {
    const fields = ['gameId', 'gameAccountId', 'amount', 'settlementAccountId', 'date', 'note'].map((key) => ({ key }));
    const groups = formTaskGroups(fields);
    expect(groups.flatMap((group) => group.fields)).toHaveLength(fields.length);
    expect(new Set(groups.flatMap((group) => group.fields))).toEqual(new Set(fields));
    expect(groups.find((group) => group.title === '记录内容')?.fields.map((field) => field.key)).toEqual(['gameId', 'gameAccountId']);
    expect(groups.find((group) => group.title === '金额与账户')?.fields.map((field) => field.key)).toEqual(['amount', 'settlementAccountId']);
  });

  it('does not restore another screen’s subpage', () => {
    expect(mobileViewKey({ zcMobileView: { screen: 'account', key: 'security' } }, 'settings')).toBe('index');
    expect(mobileViewKey({ zcMobileView: { screen: 'settings', key: 'appearance' } }, 'settings')).toBe('appearance');
    expect(mobileViewKey(null, 'transactions', 'records')).toBe('records');
  });

  it('keeps game record amounts exact beyond the JavaScript safe-integer range', () => {
    const snap = makeSnapshot();
    snap.gameRecords = [{ ...snap.gameRecords[0]!, id: 'large-expense', recordType: 'other_expense', settlementAssetId: snap.ids.gbp, settlementAmount: '9007199254740993.21' }];
    const vm = buildGameSeason(snap, snap.games[0]!.id, ALL_GAME_RECORDS);
    expect(vm?.records[0]?.amountExact).toBe('-9007199254740993.21');
  });
});
