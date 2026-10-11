import { afterEach, describe, expect, it, vi } from 'vitest';
import { createLedgerKeyEnvelope } from '@zichan/core';
import { httpCommitTransport } from '../src/http-transport.js';

afterEach(() => vi.unstubAllGlobals());

describe('member commit transport', () => {
  it('connects to an existing replica without reading the owner-only legacy key envelope', async () => {
    const ledgerId = 'ledger-member-transport-0001';
    const key = await createLedgerKeyEnvelope(ledgerId, 'member local key password');
    const requested: string[] = [];
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      requested.push(url);
      if (url.endsWith('/api/v3/replica')) return Response.json({
        bound: true, serverId: 'server-member-transport', ledgerId,
        replicaId: 'replica-member-0001', streamEpoch: 'epoch-member-0001', headSeq: 0,
        capabilities: ['asset-cost-v2'], currentKeyEpoch: 1,
      });
      return Response.json({ code: 'LEDGER_OWNER_REQUIRED', error: 'owner only' }, { status: 403 });
    }));
    const transport = httpCommitTransport({ baseUrl: 'https://ledger.example', token: 'member-token',
      cryptoSession: key.session, keyEnvelope: key.envelope, memberKeyEnvelope: true });
    await expect(transport.connect(ledgerId)).resolves.toMatchObject({
      serverId: 'server-member-transport', ledgerId,
    });
    expect(requested).toEqual(['https://ledger.example/api/v3/replica']);
  });

  it('stops before decrypting or applying a commit from an old member epoch', async () => {
    const ledgerId = 'ledger-member-stale-0001';
    const key = await createLedgerKeyEnvelope(ledgerId, 'member local key password');
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      if (url.endsWith('/api/v3/replica')) return Response.json({
        bound: true, serverId: 'server-member-stale', ledgerId,
        replicaId: 'replica-member-stale', streamEpoch: 'epoch-member-stale', headSeq: 1,
        capabilities: ['asset-cost-v2'], currentKeyEpoch: 2,
      });
      if (url.includes('/api/v3/commits?')) return Response.json({
        serverId: 'server-member-stale', replicaId: 'replica-member-stale',
        streamEpoch: 'epoch-member-stale', currentKeyEpoch: 2,
        headSeq: 1, nextSeq: 1, hasMore: false,
        commits: [{ seq: 1, commitId: 'commit-member-stale-0001', ledgerId,
          contentHash: 'a'.repeat(64), keyEpoch: 1,
          encCommit: { v: 3, keyId: key.session.activeKeyId, iv: 'iv', ct: 'cipher' } }],
      });
      return Response.json({ error: 'unexpected' }, { status: 500 });
    }));
    const transport = httpCommitTransport({ baseUrl: 'https://ledger.example', token: 'member-token',
      cryptoSession: key.session, keyEnvelope: key.envelope, memberKeyEnvelope: true });
    const identity = await transport.connect(ledgerId);
    await expect(transport.pullCommits(identity, 0)).rejects.toThrow('旧权限或密钥代次');
  });
});
