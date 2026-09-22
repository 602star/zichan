import { describe, it, expect } from 'vitest';
import { openLedger } from '../src/node.js';
import { DuplicateMasterDataError, duplicateMasterData } from '../src/master-data-identity.js';
const base = (id: string) => ({ id, createdAt: '', updatedAt: '', version: 1, isDeleted: false });
describe('shared identity validation', () => {
  it('enforces account, season, tag and payee scope in the repository, allowing unrelated edits', async () => {
    const store = await openLedger({ deviceId: 'identity' });
    try {
      await store.games.put({ ...base('game'), name: 'Game', enableSeason: true, isActive: true });
      const season = await store.gameSeasons.put({ ...base('s'), name: ' S1 ', gameId: 'game', status: 'active' });
      await expect(store.gameSeasons.put({ ...base('s2'), name: 's1', gameId: 'game', status: 'active' })).rejects.toBeInstanceOf(DuplicateMasterDataError);
      await expect(store.gameSeasons.put({ ...season, note: 'new note' })).resolves.toMatchObject({ note: 'new note' });
      await store.gameAccounts.put({ ...base('a'), gameId: 'game', accountName: 'Player', serverName: 'East', status: 'active' });
      await expect(store.gameAccounts.put({ ...base('a2'), gameId: 'game', accountName: ' player ', serverName: 'east', status: 'active' })).rejects.toBeInstanceOf(DuplicateMasterDataError);
      await expect(store.gameAccounts.put({ ...base('a3'), gameId: 'game', accountName: 'Player', serverName: 'West', status: 'active' })).resolves.toBeDefined();
      await store.transactionTags.put({ ...base('t'), name: 'Travel', groupName: 'Work', isActive: true });
      await expect(store.transactionTags.put({ ...base('t2'), name: 'travel', groupName: ' work ', isActive: true })).rejects.toBeInstanceOf(DuplicateMasterDataError);
      await expect(store.transactionTags.put({ ...base('t3'), name: 'Travel', groupName: 'Home', isActive: true })).resolves.toBeDefined();
      await store.payees.put({ ...base('p'), name: '京东', aliases: ['JD'], isActive: true });
      await expect(store.payees.put({ ...base('p2'), name: ' jd ', isActive: true })).rejects.toBeInstanceOf(DuplicateMasterDataError);
    } finally { await store.close(); }
  });
  it('does not block legacy duplicates when only non-identity metadata changes', () => {
    const current = { ...base('one'), name: 'Same', groupName: '' };
    expect(duplicateMasterData('transaction_tag', { ...current, note: 'change' }, [{ ...current, id: 'two' }], current)).toEqual([]);
  });
});
