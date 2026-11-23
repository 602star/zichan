import type { EncryptedBinary, LedgerKeyEnvelope } from '@zichan/core';

export interface LedgerStartupProtection {
  mode: 'managed' | 'relay' | null;
  version: number;
  defaultMode: 'managed';
  custodyEnabled: boolean;
  secret: string | null;
  envelope: LedgerKeyEnvelope | null;
  replica: { serverId: string; ledgerId: string; replicaId: string; streamEpoch: string; headSeq: number } | null;
}

/** The complete database includes the causal graph, conflicts and acknowledged cursors. */
export interface LedgerOpenManifest {
  version: 1;
  schemaVersion: number;
  serverId: string;
  accountId: string;
  ledgerId: string;
  replicaId: string;
  streamEpoch: string;
  headSeq: number;
  keyringId: string;
  generation: number;
  plainBytes: number;
  sha256: string;
}

export interface LedgerOpenSnapshot {
  manifest: LedgerOpenManifest;
  payload: EncryptedBinary;
}

export const MAX_LEDGER_OPEN_BYTES = 256 * 1024 * 1024;
export function ledgerOpenContext(manifest: LedgerOpenManifest): unknown {
  return { purpose: 'zichan-ledger-open-v1', ...manifest };
}
