import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createLedgerKeyEnvelope } from '@zichan/core';

const state = vi.hoisted(() => ({ values: new Map<string, unknown>(), fail: false }));
vi.mock('../src/db/idb.js', () => ({
  loadKv: async (key: string, db: string) => structuredClone(state.values.get(`${db}:${key}`) ?? null),
  saveKv: async (key: string, value: unknown, db: string) => { if (state.fail) throw new Error('disk full'); state.values.set(`${db}:${key}`, structuredClone(value)); },
  deleteKv: async (key: string, db: string) => { state.values.delete(`${db}:${key}`); },
}));
import { createConversionDraftStore } from '../src/db/conversion-drafts.js';
beforeEach(() => { state.values.clear(); state.fail = false; });
describe('encrypted conversion drafts', () => {
  it('encrypts full nested values, preserves conflicting versions and isolates accounts, ledgers and records', async () => {
    const { session } = await createLedgerKeyEnvelope('ledger-0000000001', 'long-passphrase');
    const draft = createConversionDraftStore(session, 'conversion-one', 'account-one');
    const values = { title: 'private-title', steps: [{ amount: '1.23456789', fees: [{ amount: '0.0001' }], manualFields: ['amount'] }] };
    await draft.save(values, 3);
    expect(JSON.stringify([...state.values.values()])).not.toContain('private-title');
    expect(await draft.load()).toMatchObject({ entityVersion: 3, values });
    expect(await createConversionDraftStore(session, 'conversion-one', 'account-two').load()).toBeNull();
    expect(await createConversionDraftStore(session, 'conversion-two', 'account-one').load()).toBeNull();
    expect(await createConversionDraftStore({ ...session, ledgerId: 'ledger-0000000002' }, 'conversion-one', 'account-one').load()).toBeNull();
    await expect(createConversionDraftStore({ ...session, backupSecret: new Uint8Array(32) }, 'conversion-one', 'account-one').load()).rejects.toThrow();
    expect(await draft.load()).toMatchObject({ entityVersion: 3 });
  });
  it('does not resurrect a submitted draft from queued saves and surfaces write failure', async () => {
    const { session } = await createLedgerKeyEnvelope('ledger-0000000001', 'long-passphrase');
    const draft = createConversionDraftStore(session, 'new', 'account-one');
    state.fail = true;
    await expect(draft.save({ title: 'first' })).rejects.toThrow('disk full');
    state.fail = false;
    await draft.save({ title: 'retry' });
    const writes = [draft.save({ title: 'late-one' }), draft.save({ title: 'late-two' })];
    await draft.finish();
    await Promise.all(writes);
    await draft.save({ title: 'after-submit' });
    expect(await draft.load()).toBeNull();
  });
});
