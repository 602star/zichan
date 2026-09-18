/**
 * Administrator second factor: enrollment, verification and the login challenge.
 *
 * The store keeps rows; this module owns the rules. Three of them are worth stating, because
 * each one is a way MFA implementations commonly go wrong:
 *
 * - An **unconfirmed** enrollment never gates login. A half-finished setup would otherwise lock
 *   the only administrator out of the console that would fix it.
 * - The TOTP secret is stored **encrypted** with a key derived from `server.secret`, which lives
 *   in its own file. A leaked database copy therefore does not yield working codes; a leaked
 *   full backup still does, because a backup is meant to be restorable.
 * - Recovery codes are stored as hashes and consumed one at a time, so a lost phone does not
 *   mean a lost server and a database copy does not reveal the codes.
 */
import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';
import type { SyncServerStore } from './store.js';
import {
  generateMfaSecret,
  generateRecoveryCodes,
  hashRecoveryCode,
  looksLikeRecoveryCode,
  otpauthUrl,
  verifyTotp,
} from './totp.js';

/** Five minutes is one login attempt, not a session: the password has to be proven again after. */
const CHALLENGE_TTL_MS = 5 * 60 * 1000;
/** A single challenge accepts a handful of typos, then it is dead. */
const MAX_CHALLENGE_ATTEMPTS = 5;
const SECRET_VERSION = 'v1';

export interface MfaChallengeResult {
  ok: boolean;
  reason?: 'expired' | 'consumed' | 'attempts' | 'invalid' | 'not-enrolled';
  /** Set when a code was accepted, so the caller can log how the factor was satisfied. */
  method?: 'totp' | 'recovery';
  username?: string;
}

export interface MfaServiceDeps {
  store: SyncServerStore;
  /** Deployment secret; the MFA secret key is derived from it. */
  serverSecret: string;
  issuer?: string;
  now?: () => Date;
}

/**
 * Key derivation is a single hash on purpose: the input is a 32-byte random deployment secret,
 * not a password, so a slow KDF would only add latency without adding strength.
 */
function deriveKey(serverSecret: string): Buffer {
  return createHash('sha256').update(`zichan-mfa-secret:${serverSecret}`).digest();
}

function encryptSecret(secret: string, serverSecret: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', deriveKey(serverSecret), iv);
  const ciphertext = Buffer.concat([cipher.update(secret, 'utf8'), cipher.final()]);
  return [SECRET_VERSION, iv.toString('base64'), cipher.getAuthTag().toString('base64'), ciphertext.toString('base64')].join(':');
}

/** Throws when the value was not produced by this deployment (or was altered). */
function decryptSecret(value: string, serverSecret: string): string {
  const [version, iv, tag, ciphertext] = value.split(':');
  if (version !== SECRET_VERSION || !iv || !tag || !ciphertext) throw new Error('unsupported MFA secret format');
  const decipher = createDecipheriv('aes-256-gcm', deriveKey(serverSecret), Buffer.from(iv, 'base64'));
  decipher.setAuthTag(Buffer.from(tag, 'base64'));
  return Buffer.concat([decipher.update(Buffer.from(ciphertext, 'base64')), decipher.final()]).toString('utf8');
}

export function createMfaService(deps: MfaServiceDeps) {
  const { store, serverSecret } = deps;
  const issuer = deps.issuer ?? 'Zichan 记账';
  const now = (): Date => deps.now?.() ?? new Date();
  const tokenHash = (token: string): string => createHash('sha256').update(token).digest('hex');

  const status = async (username: string): Promise<{
    enabled: boolean;
    pending: boolean;
    enabledAt?: string;
    recoveryCodesRemaining: number;
  }> => {
    const record = await store.getMfa(username);
    if (!record) return { enabled: false, pending: false, recoveryCodesRemaining: 0 };
    return {
      enabled: record.confirmed,
      pending: !record.confirmed,
      ...(record.confirmed ? { enabledAt: record.enabledAt } : {}),
      recoveryCodesRemaining: record.confirmed ? record.recoveryHashes.length : 0,
    };
  };

  /** Starts (or restarts) enrollment. The secret is stored encrypted but stays inactive. */
  const beginEnrollment = async (username: string, enrolledBy: string): Promise<{ secret: string; otpauthUrl: string }> => {
    const secret = generateMfaSecret();
    const at = now().toISOString();
    await store.saveMfa({
      username,
      secretCipher: encryptSecret(secret, serverSecret),
      enabledAt: at,
      confirmed: false,
      lastStep: -1,
      recoveryHashes: [],
      enrolledBy,
    });
    return { secret, otpauthUrl: otpauthUrl({ issuer, account: username, secret }) };
  };

  /**
   * Finishes enrollment with a code from the authenticator. Only here does the factor become
   * active, and the recovery codes are returned exactly once.
   */
  const confirmEnrollment = async (username: string, code: string): Promise<
    { ok: true; recoveryCodes: string[] } | { ok: false; reason: 'not-enrolled' | 'invalid' }
  > => {
    const record = await store.getMfa(username);
    if (!record) return { ok: false, reason: 'not-enrolled' };
    let secret: string;
    try {
      secret = decryptSecret(record.secretCipher, serverSecret);
    } catch {
      // An undecryptable secret (different deployment secret) is not a reason to accept a code.
      return { ok: false, reason: 'invalid' };
    }
    const match = verifyTotp(secret, code, now().getTime(), -1);
    if (!match) return { ok: false, reason: 'invalid' };
    const { codes, hashes } = generateRecoveryCodes();
    await store.saveMfa({
      username,
      secretCipher: record.secretCipher,
      enabledAt: record.enabledAt,
      confirmed: true,
      // The confirming step is consumed too, so the same code cannot then be replayed at login.
      lastStep: match.step,
      recoveryHashes: hashes,
      enrolledBy: record.enrolledBy ?? username,
    });
    return { ok: true, recoveryCodes: codes };
  };

  /** Verifies a code against an enrolled account, consuming the step or the recovery code. */
  const verify = async (username: string, code: string): Promise<{ ok: boolean; method?: 'totp' | 'recovery' }> => {
    const record = await store.getMfa(username);
    if (!record?.confirmed) return { ok: false };
    if (looksLikeRecoveryCode(code)) {
      const consumed = await store.consumeMfaRecoveryCode(username, hashRecoveryCode(code));
      return consumed ? { ok: true, method: 'recovery' } : { ok: false };
    }
    let secret: string;
    try {
      secret = decryptSecret(record.secretCipher, serverSecret);
    } catch {
      return { ok: false };
    }
    const match = verifyTotp(secret, code, now().getTime(), record.lastStep);
    if (!match) return { ok: false };
    // The step is claimed in the database: two concurrent requests cannot both accept it.
    const claimed = await store.recordMfaStep(username, match.step);
    return claimed ? { ok: true, method: 'totp' } : { ok: false };
  };

  const disable = async (username: string, code: string): Promise<{ ok: boolean; reason?: 'invalid' }> => {
    // `verify` answers with an object, so a truthiness test here would accept every wrong code.
    const verified = await verify(username, code);
    if (!verified.ok) return { ok: false, reason: 'invalid' };
    await store.deleteMfa(username);
    return { ok: true };
  };

  const regenerateRecoveryCodes = async (username: string, code: string): Promise<
    { ok: true; recoveryCodes: string[] } | { ok: false; reason: 'invalid' }
  > => {
    const record = await store.getMfa(username);
    if (!record?.confirmed) return { ok: false, reason: 'invalid' };
    const verified = await verify(username, code);
    if (!verified.ok) return { ok: false, reason: 'invalid' };
    // Re-read the record: `verify` just claimed a time step, and writing back the value read
    // before it would hand that step back to whoever still holds the code.
    const claimed = await store.getMfa(username);
    const { codes, hashes } = generateRecoveryCodes();
    await store.saveMfa({
      username,
      secretCipher: record.secretCipher,
      enabledAt: record.enabledAt,
      confirmed: true,
      lastStep: claimed?.lastStep ?? record.lastStep,
      recoveryHashes: hashes,
      enrolledBy: record.enrolledBy ?? username,
    });
    return { ok: true, recoveryCodes: codes };
  };

  /** Opens a short-lived challenge after the password step, instead of issuing a session. */
  const createChallenge = async (username: string, manage: boolean, ip?: string): Promise<{ challenge: string; expiresAt: string }> => {
    const token = randomBytes(24).toString('base64url');
    const expiresAt = new Date(now().getTime() + CHALLENGE_TTL_MS).toISOString();
    // The transport the challenge was issued for travels in the id prefix, so the code step can
    // refuse a challenge answered from a different context (a ledger session is not a management
    // session, and only management logins get a challenge in the first place).
    const context = manage ? 'admin' : 'ledger';
    const id = `mfa-${context}-${randomBytes(12).toString('hex')}`;
    await store.createMfaChallenge({
      id,
      username,
      tokenHash: tokenHash(token),
      ...(ip ? { ip } : {}),
      expiresAt,
    });
    // The id is only useful with the token, and the token is only useful with the id: both are
    // needed to reach the row, so leaking either half proves nothing.
    return { challenge: `${token}.${id}`, expiresAt };
  };

  const verifyChallenge = async (challenge: string, code: string, manage: boolean): Promise<MfaChallengeResult> => {
    // Exactly two parts, and nothing else: a longer string must not be trimmed into something
    // that matches a row.
    const parts = challenge.split('.');
    if (parts.length !== 2) return { ok: false, reason: 'invalid' };
    const [token, id] = parts as [string, string];
    if (!token || !id) return { ok: false, reason: 'invalid' };
    if (!id.startsWith(`mfa-${manage ? 'admin' : 'ledger'}-`)) return { ok: false, reason: 'invalid' };
    const row = await store.getMfaChallenge(id);
    if (!row || row.tokenHash !== tokenHash(token)) return { ok: false, reason: 'invalid' };
    if (row.consumedAt) return { ok: false, reason: 'consumed' };
    if (row.expiresAt <= now().toISOString()) return { ok: false, reason: 'expired' };
    if (row.attempts >= MAX_CHALLENGE_ATTEMPTS) return { ok: false, reason: 'attempts' };
    const result = await verify(row.username, code);
    if (!result.ok) {
      const attempts = await store.noteMfaChallengeAttempt(id);
      return { ok: false, reason: attempts >= MAX_CHALLENGE_ATTEMPTS ? 'attempts' : 'invalid' };
    }
    await store.consumeMfaChallenge(id);
    return { ok: true, method: result.method, username: row.username };
  };

  /**
   * Whether login must ask for a code for this account. Enforced for management sessions and,
   * when the deployment asks for it, for every administrator — never for ledger logins, which
   * have no way to prompt for a second factor.
   */
  const requiredFor = async (username: string, options: { manage: boolean; policy: boolean }): Promise<boolean> => {
    if (!options.manage) return false;
    const record = await store.getMfa(username);
    if (record?.confirmed) return true;
    return options.policy;
  };

  /** Administrators that still have to enroll before a deployment can require MFA. */
  const administratorsWithoutMfa = async (): Promise<string[]> => {
    const rows = await store.listAdminUsernames();
    const missing: string[] = [];
    for (const username of rows) {
      const record = await store.getMfa(username);
      if (!record?.confirmed) missing.push(username);
    }
    return missing;
  };

  return {
    status,
    beginEnrollment,
    confirmEnrollment,
    verify,
    disable,
    regenerateRecoveryCodes,
    createChallenge,
    verifyChallenge,
    requiredFor,
    administratorsWithoutMfa,
  };
}

export type MfaService = ReturnType<typeof createMfaService>;
