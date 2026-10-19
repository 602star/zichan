import { canonicalJson } from '@zichan/core';
import { verifyNodeSignature, type NodeIdentity } from './node-identity.js';

/** An issuer signs its own credential before a coordinator relays it to another node. */
export interface FederatedCredentialBundle {
  v: 1;
  ledgerId: string;
  issuerNodeId: string;
  subjectAccountId: string;
  username: string;
  displayName: string;
  registrationRecord: string;
  serverSetup: string;
  disabled: boolean;
  revision: number;
}

export function credentialBytes(bundle: FederatedCredentialBundle): Uint8Array {
  return Buffer.from(canonicalJson(bundle));
}

export function signFederatedCredential(identity: NodeIdentity, bundle: FederatedCredentialBundle): string {
  if (bundle.issuerNodeId !== identity.nodeId) throw new Error('账号凭据签发节点不匹配');
  return identity.sign(credentialBytes(bundle));
}

export function parseFederatedCredential(value: unknown): FederatedCredentialBundle {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('账号凭据格式无效');
  const bundle = value as Partial<FederatedCredentialBundle>;
  if (bundle.v !== 1 || typeof bundle.ledgerId !== 'string'
    || !/^[A-Za-z0-9_-]{16,128}$/.test(bundle.ledgerId)
    || typeof bundle.issuerNodeId !== 'string'
    || !/^[A-Za-z0-9_-]{8,128}$/.test(bundle.issuerNodeId)
    || typeof bundle.subjectAccountId !== 'string'
    || !/^[A-Za-z0-9_-]{8,160}$/.test(bundle.subjectAccountId)
    || typeof bundle.username !== 'string'
    || !/^[\p{L}\p{N}_.-]{2,64}$/u.test(bundle.username)
    || typeof bundle.displayName !== 'string' || !bundle.displayName
    || Array.from(bundle.displayName).length > 24 || /[\p{Cc}\p{Cf}]/u.test(bundle.displayName)
    || typeof bundle.registrationRecord !== 'string' || !bundle.registrationRecord
    || bundle.registrationRecord.length > 16_384
    || typeof bundle.serverSetup !== 'string' || !bundle.serverSetup
    || bundle.serverSetup.length > 16_384
    || typeof bundle.disabled !== 'boolean'
    || !Number.isSafeInteger(bundle.revision) || Number(bundle.revision) < 1) {
    throw new Error('账号凭据格式无效');
  }
  return bundle as FederatedCredentialBundle;
}

export function verifyFederatedCredential(bundle: FederatedCredentialBundle,
  signature: string, issuerPublicKey: string): boolean {
  return /^[A-Za-z0-9_-]{80,100}$/.test(signature)
    && verifyNodeSignature(issuerPublicKey, credentialBytes(bundle), signature);
}
