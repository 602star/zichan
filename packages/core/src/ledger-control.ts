import { ed25519 } from '@noble/curves/ed25519.js';
import { hkdf } from '@noble/hashes/hkdf.js';
import { sha256 } from '@noble/hashes/sha2.js';
import { canonicalJson } from './crypto.js';

const encoder = new TextEncoder();
const identityPattern = /^[A-Za-z0-9_-]{8,160}$/;
const ledgerPattern = /^[A-Za-z0-9_-]{16,128}$/;
const hashPattern = /^[a-f0-9]{64}$/;

export interface LedgerMemberIdentity {
  issuerNodeId: string;
  accountId: string;
}

export type LedgerMemberRole = 'OWNER' | 'EDITOR' | 'VIEWER';
export type LedgerControlKind = 'MemberGenesis' | 'MemberAdded' | 'MemberRemoved' | 'MemberRoleChanged'
  | 'RejectedCommitResolved';

export interface LedgerControlPayload {
  v: 1;
  ledgerId: string;
  seq: number;
  previousHash: string | null;
  keyEpoch: number;
  kind: LedgerControlKind;
  actor: LedgerMemberIdentity;
  target: LedgerMemberIdentity;
  role?: LedgerMemberRole;
  signingPublicKey?: string;
  encryptionPublicKey?: string;
  rejectedCommitId?: string;
  rejectedContentHash?: string;
  decision?: 'replay' | 'discard';
  replacementCommitId?: string;
  replacementContentHash?: string;
}

export interface LedgerControlEvent extends LedgerControlPayload {
  signature: string;
}

export interface LedgerMember extends LedgerMemberIdentity {
  role: LedgerMemberRole;
  signingPublicKey: string;
  encryptionPublicKey: string;
  removed: boolean;
}

export interface LedgerControlState {
  ledgerId: string;
  seq: number;
  headHash: string;
  keyEpoch: number;
  members: Record<string, LedgerMember>;
}

function base64(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function decodeBase64(value: string, length: number): Uint8Array {
  if (typeof value !== 'string' || !/^[A-Za-z0-9+/]+={0,2}$/.test(value)) throw new Error('成员公钥或签名编码无效');
  let binary: string;
  try { binary = atob(value); } catch { throw new Error('成员公钥或签名编码无效'); }
  if (binary.length !== length || base64(Uint8Array.from(binary, (char) => char.charCodeAt(0))) !== value) {
    throw new Error('成员公钥或签名长度无效');
  }
  return Uint8Array.from(binary, (char) => char.charCodeAt(0));
}

function memberId(identity: LedgerMemberIdentity): string {
  return `${identity.issuerNodeId}/${identity.accountId}`;
}

function validIdentity(value: LedgerMemberIdentity): boolean {
  return !!value && typeof value === 'object'
    && Object.keys(value).sort().join(',') === 'accountId,issuerNodeId'
    && identityPattern.test(value.issuerNodeId) && identityPattern.test(value.accountId);
}

function validRole(value: unknown): value is LedgerMemberRole {
  return value === 'OWNER' || value === 'EDITOR' || value === 'VIEWER';
}

function assertPayload(payload: LedgerControlPayload): void {
  if (!payload || payload.v !== 1 || !ledgerPattern.test(payload.ledgerId)
    || !Number.isSafeInteger(payload.seq) || payload.seq < 1
    || !Number.isSafeInteger(payload.keyEpoch) || payload.keyEpoch < 1
    || !validIdentity(payload.actor) || !validIdentity(payload.target)
    || (payload.previousHash !== null && !hashPattern.test(payload.previousHash))) {
    throw new Error('账本成员事件无效');
  }
  const keys = Object.keys(payload).sort().join(',');
  const common = ['actor', 'keyEpoch', 'kind', 'ledgerId', 'previousHash', 'seq', 'target', 'v'];
  if (payload.kind === 'MemberGenesis' || payload.kind === 'MemberAdded') {
    if (keys !== [...common, 'role', 'signingPublicKey', 'encryptionPublicKey'].sort().join(',')
      || !validRole(payload.role)) throw new Error('成员授权字段无效');
    decodeBase64(payload.signingPublicKey!, 32);
    decodeBase64(payload.encryptionPublicKey!, 32);
  } else if (payload.kind === 'MemberRoleChanged') {
    if (keys !== [...common, 'role'].sort().join(',') || !validRole(payload.role)) throw new Error('成员角色事件无效');
  } else if (payload.kind === 'MemberRemoved') {
    if (keys !== common.sort().join(',')) throw new Error('移除成员事件无效');
  } else if (payload.kind === 'RejectedCommitResolved') {
    const extras = ['decision', 'rejectedCommitId', 'rejectedContentHash',
      ...(payload.decision === 'replay' ? ['replacementCommitId', 'replacementContentHash'] : [])];
    if (keys !== [...common, ...extras].sort().join(',')
      || (payload.decision !== 'replay' && payload.decision !== 'discard')
      || memberId(payload.actor) !== memberId(payload.target)
      || typeof payload.rejectedCommitId !== 'string'
      || !/^[A-Za-z0-9_-]{16,160}$/.test(payload.rejectedCommitId)
      || typeof payload.rejectedContentHash !== 'string' || !hashPattern.test(payload.rejectedContentHash)
      || payload.decision === 'replay' && (typeof payload.replacementCommitId !== 'string'
        || !/^[A-Za-z0-9_-]{16,160}$/.test(payload.replacementCommitId)
        || payload.replacementCommitId === payload.rejectedCommitId
        || typeof payload.replacementContentHash !== 'string'
        || !hashPattern.test(payload.replacementContentHash))) throw new Error('隔离提交处置字段无效');
  } else {
    throw new Error('成员事件类型无效');
  }
}

function signingSeed(accountEncryptionPrivateKey: Uint8Array): Uint8Array {
  if (accountEncryptionPrivateKey.length !== 32) throw new Error('账号私钥长度无效');
  return hkdf(sha256, accountEncryptionPrivateKey, new Uint8Array(32),
    encoder.encode('zichan-ledger-control-signing-v1'), 32);
}

/** Domain-separated signing identity derived from the locally unlocked account key. */
export function accountSigningPublicKey(accountEncryptionPrivateKey: Uint8Array): string {
  const seed = signingSeed(accountEncryptionPrivateKey);
  try { return base64(ed25519.getPublicKey(seed)); }
  finally { seed.fill(0); }
}

export function signLedgerControlEvent(accountEncryptionPrivateKey: Uint8Array,
  payload: LedgerControlPayload): LedgerControlEvent {
  assertPayload(payload);
  const seed = signingSeed(accountEncryptionPrivateKey);
  try {
    const signature = ed25519.sign(encoder.encode(canonicalJson(payload)), seed);
    return { ...payload, signature: base64(signature) };
  } finally { seed.fill(0); }
}

export function ledgerControlEventHash(event: LedgerControlEvent): string {
  return [...sha256(encoder.encode(canonicalJson(event)))].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

/** The first event requires an independently pinned owner identity and signing key. */
export function applyLedgerControlEvent(state: LedgerControlState | undefined,
  event: LedgerControlEvent, pinnedOwner?: LedgerMemberIdentity & { signingPublicKey: string }): LedgerControlState {
  const extraFields = event?.kind === 'MemberGenesis' || event?.kind === 'MemberAdded' ? 3
    : event?.kind === 'MemberRoleChanged' ? 1
      : event?.kind === 'RejectedCommitResolved' ? event.decision === 'replay' ? 5 : 3 : 0;
  if (!event || typeof event !== 'object' || Object.keys(event).length !== 9 + extraFields) {
    throw new Error('成员事件字段无效');
  }
  const { signature, ...payload } = event;
  assertPayload(payload);
  const signatureBytes = decodeBase64(signature, 64);
  const targetId = memberId(event.target);
  let signingPublicKey: string;
  let members: Record<string, LedgerMember>;
  if (!state) {
    if (!pinnedOwner || !validIdentity({ issuerNodeId: pinnedOwner.issuerNodeId, accountId: pinnedOwner.accountId })
      || event.kind !== 'MemberGenesis'
      || event.seq !== 1 || event.previousHash !== null || event.keyEpoch !== 1
      || event.role !== 'OWNER' || memberId(event.actor) !== targetId
      || memberId(pinnedOwner) !== targetId || pinnedOwner.signingPublicKey !== event.signingPublicKey) {
      throw new Error('账本初始所有者与受信任身份不符');
    }
    signingPublicKey = pinnedOwner.signingPublicKey;
    members = {};
  } else {
    if (event.kind === 'MemberGenesis' || event.ledgerId !== state.ledgerId || event.seq !== state.seq + 1
      || event.previousHash !== state.headHash) throw new Error('成员控制链不连续');
    const actor = state.members[memberId(event.actor)];
    if (!actor || actor.removed || actor.role !== 'OWNER') throw new Error('仅账本所有者可以更改成员');
    signingPublicKey = actor.signingPublicKey;
    members = { ...state.members };
    if (event.keyEpoch !== state.keyEpoch + (event.kind === 'MemberRemoved' ? 1 : 0)) {
      throw new Error('成员密钥代次不连续');
    }
  }
  if (!ed25519.verify(signatureBytes, encoder.encode(canonicalJson(payload)),
    decodeBase64(signingPublicKey, 32), { zip215: false })) throw new Error('成员事件签名无效');
  const target = members[targetId];
  if (event.kind === 'MemberGenesis' || event.kind === 'MemberAdded') {
    if (target && !target.removed) throw new Error('成员已经存在');
    members[targetId] = { ...event.target, role: event.role!, signingPublicKey: event.signingPublicKey!,
      encryptionPublicKey: event.encryptionPublicKey!, removed: false };
  } else if (event.kind !== 'RejectedCommitResolved') {
    if (!target || target.removed) throw new Error('目标不是有效成员');
    if (event.kind === 'MemberRemoved') members[targetId] = { ...target, removed: true };
    else members[targetId] = { ...target, role: event.role! };
  }
  if (!Object.values(members).some((member) => !member.removed && member.role === 'OWNER')) {
    throw new Error('账本必须保留所有者');
  }
  return { ledgerId: event.ledgerId, seq: event.seq, headHash: ledgerControlEventHash(event),
    keyEpoch: event.keyEpoch, members };
}
