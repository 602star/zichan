import { requestJson } from '@zichan/db';
import { unlockAccountEncryptionKey, unlockLedgerKeyEnvelope, wrapAccountEncryptionKey,
  wrapLedgerCryptoSession, type AccountEncryptionKeyEnvelope, type LedgerKeyEnvelope } from '@zichan/core';

interface AccountRecord { envelope: AccountEncryptionKeyEnvelope; revision: number }
interface LedgerRecord { envelope: LedgerKeyEnvelope; revision: number }

async function request<T>(baseUrl: string, token: string, path: string, method = 'GET', body?: unknown): Promise<T> {
  const response = await requestJson(`${baseUrl}${path}`, { method, cache: 'no-store',
    redirect: 'error', credentials: 'omit', headers: { Authorization: `Bearer ${token}`,
      ...(body ? { 'Content-Type': 'application/json' } : {}) },
    ...(body ? { body: JSON.stringify(body) } : {}) });
  const result = await response.json() as T & { error?: string };
  if (!response.ok) throw new Error(result.error ?? '密钥密码更新失败');
  return result;
}

/** Rewrap client-only keys before OPAQUE changes; caller rolls back if the credential update fails. */
export async function rewrapAccountKeysForPasswordChange(baseUrl: string, token: string,
  oldPassword: string, nextPassword: string): Promise<() => Promise<void>> {
  const rollbacks: Array<() => Promise<void>> = [];
  try {
    const key = await request<{ record: AccountRecord | null }>(baseUrl, token, '/api/v4/account/encryption-key');
    if (key.record) {
      const current = key.record;
      const privateKey = await unlockAccountEncryptionKey(oldPassword, current.envelope);
      try {
        const next = await wrapAccountEncryptionKey(privateKey, current.envelope.issuerNodeId,
          current.envelope.accountId, nextPassword);
        await request(baseUrl, token, '/api/v4/account/encryption-key', 'PUT',
          { envelope: next, expectedRevision: current.revision });
        rollbacks.push(async () => { await request(baseUrl, token, '/api/v4/account/encryption-key', 'PUT',
          { envelope: current.envelope, expectedRevision: current.revision + 1 }); });
      } finally { privateKey.fill(0); }
    }
    const ledger = await request<{ record: LedgerRecord | null }>(baseUrl, token, '/api/v4/ledger/password-envelope')
      .catch(() => ({ record: null }));
    if (ledger.record) {
      const current = ledger.record;
      const session = await unlockLedgerKeyEnvelope(oldPassword, current.envelope);
      const next = await wrapLedgerCryptoSession(session, nextPassword);
      await request(baseUrl, token, '/api/v4/ledger/password-envelope', 'PUT',
        { envelope: next, expectedRevision: current.revision });
      rollbacks.push(async () => { await request(baseUrl, token, '/api/v4/ledger/password-envelope', 'PUT',
        { envelope: current.envelope, expectedRevision: current.revision + 1 }); });
    }
  } catch (error) {
    for (const rollback of rollbacks.reverse()) await rollback().catch(() => undefined);
    throw error;
  }
  return async () => {
    for (const rollback of rollbacks.reverse()) await rollback();
  };
}
