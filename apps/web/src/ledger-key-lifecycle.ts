import type { SqlLedgerStore } from '@zichan/db';
import {
  initializeLedgerKey,
  ledgerKeyState,
  unlockLedgerKey,
  type LedgerKeyState,
} from './ledger-key-vault.js';

/**
 * Ensure the currently opened ledger has an unlocked backup/sync keyring.
 *
 * New v0.1 ledgers deliberately reuse the already-entered device-storage
 * passphrase so automatic backups work immediately without a second setup
 * screen. Existing ledgers with a separately chosen passphrase remain
 * supported: callers may catch the unlock error and leave manual unlock to the
 * sync page, but a mismatched ledger id is always reported explicitly.
 */
export async function ensureLedgerKeyForStore(
  store: Pick<SqlLedgerStore, 'getLedgerId'>,
  passphrase: string,
): Promise<LedgerKeyState> {
  if (passphrase.length < 8) throw new Error('账本加密密码至少需要 8 个字符');
  const ledgerId = await store.getLedgerId();
  const state = ledgerKeyState();
  if (!state.initialized) return initializeLedgerKey(ledgerId, passphrase);
  if (state.ledgerId !== ledgerId) {
    throw new Error(`本机账本密钥属于其他账本：${state.ledgerId ?? '未知'}；当前账本：${ledgerId}`);
  }
  if (state.unlocked) return state;
  return unlockLedgerKey(passphrase);
}
