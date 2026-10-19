import { describe, expect, it } from 'vitest';
import { assessReplicaReadiness } from '../src/replica-readiness.js';
import type { NodeReplicaInventory, NodeReplicationLink, ReplicaPhysicalStatus } from '../src/store.js';

const hash = 'a'.repeat(64);
const inventory: NodeReplicaInventory = {
  serverId: 'node-home', replicaId: 'replica-home', streamEpoch: 'epoch-home', ledgerId: 'ledger-readiness-0001',
  issuerNodeId: 'node-home', subjectAccountId: 'account-owner',
  keyringId: 'keyring-readiness', keyGeneration: 1, keyEnvelopeHash: hash,
  requirementsHash: hash, commitCount: 3, commitHash: hash, commitStreamComplete: 1,
  attachmentPromisePresent: 1, attachmentPromiseCurrent: 1,
  promisedBlobCount: 2, promisedBlobHash: hash, missingPromisedBlobCount: 0,
  blobCount: 2, blobHash: hash, tombstoneCount: 0, stateHash: hash,
  legacyBlobCount: 0,
};
const physical: ReplicaPhysicalStatus = { blobHash: hash, verifiedAt: new Date().toISOString() };
const link = { linkId: 'link-hub', peerNodeId: 'node-hub', enabled: true,
  pullSeq: 3, peerHeadSeq: 3, pushSeq: 3, localHeadSeq: 3,
  pullBlobCursor: '', pushBlobCursor: '', pullStateCursor: '', pushStateCursor: '',
  pullBlobSweepAt: new Date().toISOString(), pushBlobSweepAt: new Date().toISOString(),
  pullStateSweepAt: new Date().toISOString(), pushStateSweepAt: new Date().toISOString(),
  lastSuccessAt: new Date().toISOString() } as NodeReplicationLink;

describe('replica readiness evidence', () => {
  const check = (overrides: Partial<Parameters<typeof assessReplicaReadiness>[0]> = {}) =>
    assessReplicaReadiness({ inventory, physical, links: [link], verifiedLinkIds: new Set([link.linkId]),
      snapshotStable: true, ...overrides });

  it('requires a current promise, physical verification, and a live matching peer', () => {
    expect(check().state).toBe('READY');
    expect(check({ inventory: { ...inventory, attachmentPromisePresent: 0 } }).state).toBe('VERIFYING');
    expect(check({ inventory: { ...inventory, attachmentPromiseCurrent: 0 } }).state).toBe('VERIFYING');
    expect(check({ physical: { blobHash: 'b'.repeat(64), verifiedAt: physical.verifiedAt } }).state).toBe('VERIFYING');
    expect(check({ verifiedLinkIds: new Set() }).state).toBe('VERIFYING');
    expect(check({ snapshotStable: false }).state).toBe('VERIFYING');
  });

  it('keeps old objects and missing promised blobs out of READY', () => {
    expect(check({ inventory: { ...inventory, legacyBlobCount: 1 } }).state).toBe('BOOTSTRAPPING');
    expect(check({ inventory: { ...inventory, missingPromisedBlobCount: 1 } }).state).toBe('CATCHING_UP');
    expect(check({ inventory: { ...inventory, commitStreamComplete: 0 } }).state).toBe('VERIFYING');
  });

  it('requires background cursors and a recent successful pass even after a live directory match', () => {
    expect(check({ links: [{ ...link, pushSeq: 2 }] }).state).toBe('CATCHING_UP');
    expect(check({ inventory: { ...inventory, commitCount: 1 },
      links: [{ ...link, localHeadSeq: 5, pushSeq: 3 }] }).state).toBe('CATCHING_UP');
    expect(check({ links: [{ ...link, pullBlobSweepAt: undefined }] }).state).toBe('CATCHING_UP');
    expect(check({ links: [{ ...link, lastSuccessAt: new Date(Date.now() - 120_000).toISOString() }] }).state)
      .toBe('CATCHING_UP');
  });
});
