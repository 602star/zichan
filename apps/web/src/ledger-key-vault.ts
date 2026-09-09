import { accountLocalStorage } from './account-storage.js';
import {
  changeLedgerPassphrase,
  createLedgerKeyEnvelope,
  rotateLedgerDataKey,
  unlockLedgerKeyEnvelope,
  type LedgerCryptoSession,
  type LedgerKeyEnvelope,
} from '@zichan/core';

export const LEDGER_KEY_ENVELOPE_KEY = 'zichan.ledger.keyEnvelope.v1';
export const LEDGER_KEY_STATE_CHANGED_EVENT = 'zichan:ledger-key-state-changed';

export interface LedgerKeyState {
  initialized: boolean;
  unlocked: boolean;
  ledgerId?: string;
  keyringId?: string;
  generation?: number;
  activeKeyId?: string;
}

let session: LedgerCryptoSession | undefined;

function emit(): void {
  globalThis.dispatchEvent?.(new CustomEvent(LEDGER_KEY_STATE_CHANGED_EVENT));
}

function validEnvelope(value: unknown): value is LedgerKeyEnvelope {
  if (!value || typeof value !== 'object') return false;
  const row = value as Partial<LedgerKeyEnvelope>;
  return row.v === 1 && row.kdf === 'argon2id'
    && typeof row.ledgerId === 'string' && typeof row.keyringId === 'string'
    && Number.isSafeInteger(row.generation) && typeof row.salt === 'string'
    && typeof row.iv === 'string' && typeof row.ct === 'string';
}

export function storedLedgerKeyEnvelope(): LedgerKeyEnvelope | undefined {
  try {
    const raw = accountLocalStorage?.getItem(LEDGER_KEY_ENVELOPE_KEY);
    if (!raw) return undefined;
    const parsed = JSON.parse(raw) as unknown;
    return validEnvelope(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
}

function persist(envelope: LedgerKeyEnvelope): void {
  accountLocalStorage?.setItem(LEDGER_KEY_ENVELOPE_KEY, JSON.stringify(envelope));
}

export function ledgerKeyState(): LedgerKeyState {
  const envelope = storedLedgerKeyEnvelope();
  return {
    initialized: !!envelope,
    unlocked: !!session,
    ledgerId: session?.ledgerId ?? envelope?.ledgerId,
    keyringId: session?.keyringId ?? envelope?.keyringId,
    generation: session?.generation ?? envelope?.generation,
    activeKeyId: session?.activeKeyId,
  };
}

export function runtimeLedgerCryptoSession(): LedgerCryptoSession | undefined {
  return session;
}

export function requireLedgerCryptoSession(ledgerId?: string): LedgerCryptoSession {
  if (!session) throw new Error('请先解锁账本加密密钥');
  if (ledgerId && session.ledgerId !== ledgerId) throw new Error(`已解锁的是其他账本密钥：${session.ledgerId}`);
  return session;
}

export async function initializeLedgerKey(ledgerId: string, passphrase: string): Promise<LedgerKeyState> {
  if (storedLedgerKeyEnvelope()) throw new Error('本机已经存在账本密钥包');
  const created = await createLedgerKeyEnvelope(ledgerId, passphrase);
  session = created.session;
  persist(created.envelope);
  emit();
  return ledgerKeyState();
}

export async function unlockLedgerKey(passphrase: string): Promise<LedgerKeyState> {
  const envelope = storedLedgerKeyEnvelope();
  if (!envelope) throw new Error('本机没有账本密钥包，请先创建或从同步服务器获取');
  session = await unlockLedgerKeyEnvelope(passphrase, envelope);
  emit();
  return ledgerKeyState();
}

export function lockLedgerKey(): void {
  session = undefined;
  emit();
}

/** Forget every local reference to the current ledger key after a full data reset. */
export function clearLedgerKey(): void {
  session = undefined;
  accountLocalStorage?.removeItem(LEDGER_KEY_ENVELOPE_KEY);
  emit();
}

export async function updateLedgerPassphrase(newPassphrase: string): Promise<LedgerKeyState> {
  const current = requireLedgerCryptoSession();
  const changed = await changeLedgerPassphrase(current, newPassphrase);
  session = changed.session;
  persist(changed.envelope);
  emit();
  return ledgerKeyState();
}

export async function rotateLedgerKey(passphrase: string): Promise<LedgerKeyState> {
  const current = requireLedgerCryptoSession();
  const rotated = await rotateLedgerDataKey(current, passphrase);
  session = rotated.session;
  persist(rotated.envelope);
  emit();
  return ledgerKeyState();
}

/** Store a remote wrapped keyring. It remains locked until its passphrase is entered. */
export function adoptLedgerKeyEnvelope(envelope: LedgerKeyEnvelope, replace = false): LedgerKeyState {
  if (!validEnvelope(envelope)) throw new Error('服务器返回的账本密钥包无效');
  const current = storedLedgerKeyEnvelope();
  if (current && !replace && current.keyringId !== envelope.keyringId) throw new Error('本机已有另一个账本密钥包');
  if (current && current.keyringId === envelope.keyringId && current.generation > envelope.generation) {
    throw new Error('服务器上的账本密钥包比本机旧');
  }
  persist(envelope);
  session = undefined;
  emit();
  return ledgerKeyState();
}

/** Persist an envelope that has already been successfully unlocked and keep that session active. */
export function adoptUnlockedLedgerKeyEnvelope(
  envelope: LedgerKeyEnvelope,
  unlocked: LedgerCryptoSession,
  replace = false,
): LedgerKeyState {
  if (!validEnvelope(envelope)) throw new Error('备份中的账本密钥包无效');
  if (unlocked.ledgerId !== envelope.ledgerId
    || unlocked.keyringId !== envelope.keyringId
    || unlocked.generation !== envelope.generation) {
    throw new Error('备份密钥包与已解锁会话不一致');
  }
  const current = storedLedgerKeyEnvelope();
  if (current && !replace && current.keyringId !== envelope.keyringId) throw new Error('本机已有另一个账本密钥包');
  persist(envelope);
  session = unlocked;
  emit();
  return ledgerKeyState();
}
