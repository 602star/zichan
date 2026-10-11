import { randomBytes } from 'node:crypto';
import { isIP } from 'node:net';
import { verifyNodeSignature, type NodeIdentity } from './node-identity.js';

export interface FederatedLoginIntent {
  v: 1;
  targetNodeId: string;
  issuerNodeId: string;
  grantId: string;
  callbackUrl: string;
  state: string;
  issuedAt: string;
  signature: string;
}

function payload(value: Omit<FederatedLoginIntent, 'signature'>): Uint8Array {
  return Buffer.from(JSON.stringify([value.v, value.targetNodeId, value.issuerNodeId,
    value.grantId, value.callbackUrl, value.state, value.issuedAt]));
}

function privateCallbackHost(hostname: string): boolean {
  if (hostname === 'localhost' || hostname === '::1' || hostname === '[::1]') return true;
  if (isIP(hostname) === 4) {
    const octets = hostname.split('.').map(Number);
    return octets[0] === 127 || octets[0] === 10 || octets[0] === 192 && octets[1] === 168
      || octets[0] === 172 && octets[1]! >= 16 && octets[1]! <= 31;
  }
  const normalized = hostname.replace(/^\[|\]$/g, '').toLowerCase();
  if (isIP(normalized) !== 6) return false;
  const first = Number.parseInt(normalized.split(':')[0] ?? '', 16);
  return first >= 0xfc00 && first <= 0xfdff || first >= 0xfe80 && first <= 0xfebf;
}

export function createFederatedLoginIntent(identity: NodeIdentity, issuerNodeId: string,
  grantId: string, callbackUrl: string): FederatedLoginIntent {
  const unsigned: Omit<FederatedLoginIntent, 'signature'> = {
    v: 1, targetNodeId: identity.nodeId, issuerNodeId, grantId, callbackUrl,
    state: randomBytes(32).toString('base64url'), issuedAt: new Date().toISOString(),
  };
  return { ...unsigned, signature: identity.sign(payload(unsigned)) };
}

export function verifyFederatedLoginIntent(value: FederatedLoginIntent, targetPublicKey: string,
  issuerNodeId: string, grantId: string, now = Date.now()): boolean {
  if (!value || value.v !== 1 || value.issuerNodeId !== issuerNodeId || value.grantId !== grantId
    || typeof value.targetNodeId !== 'string' || !/^[A-Za-z0-9_-]{8,128}$/.test(value.targetNodeId)
    || typeof value.state !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(value.state)
    || typeof value.callbackUrl !== 'string' || value.callbackUrl.length > 2048
    || typeof value.issuedAt !== 'string' || !Number.isFinite(Date.parse(value.issuedAt))
    || Math.abs(now - Date.parse(value.issuedAt)) > 5 * 60_000 || typeof value.signature !== 'string') return false;
  let callback: URL;
  try { callback = new URL(value.callbackUrl); } catch { return false; }
  if (callback.username || callback.password || callback.search || callback.hash
    || !callback.pathname.endsWith('/api/auth/federation/callback')
    || callback.protocol !== 'https:' && !(callback.protocol === 'http:' && privateCallbackHost(callback.hostname))) return false;
  const { signature, ...unsigned } = value;
  return verifyNodeSignature(targetPublicKey, payload(unsigned), signature);
}

export function encodeFederatedLoginIntent(intent: FederatedLoginIntent): string {
  return Buffer.from(JSON.stringify(intent)).toString('base64url');
}

export function decodeFederatedLoginIntent(encoded: string): FederatedLoginIntent | undefined {
  if (!/^[A-Za-z0-9_-]{1,4096}$/.test(encoded)) return undefined;
  try {
    const value: unknown = JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8'));
    return value && typeof value === 'object' && !Array.isArray(value) ? value as FederatedLoginIntent : undefined;
  } catch { return undefined; }
}
