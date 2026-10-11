import { createHash, randomBytes } from 'node:crypto';
import { verifyNodeSignature, type NodeIdentity } from './node-identity.js';

export interface NodeRequestProof {
  v: 1;
  nodeId: string;
  grantId: string;
  method: string;
  path: string;
  bodySha256: string;
  issuedAt: string;
  nonce: string;
  signature: string;
}

function bodyHash(body: Uint8Array): string {
  return createHash('sha256').update(body).digest('hex');
}

function payload(proof: Omit<NodeRequestProof, 'signature'>): Uint8Array {
  return Buffer.from(JSON.stringify([
    proof.v, proof.nodeId, proof.grantId, proof.method, proof.path,
    proof.bodySha256, proof.issuedAt, proof.nonce,
  ]));
}

export function signNodeRequest(
  identity: NodeIdentity,
  grantId: string,
  method: string,
  path: string,
  body: Uint8Array = new Uint8Array(),
  issuedAt = new Date(),
): NodeRequestProof {
  const unsigned: Omit<NodeRequestProof, 'signature'> = {
    v: 1,
    nodeId: identity.nodeId,
    grantId,
    method: method.toUpperCase(),
    path,
    bodySha256: bodyHash(body),
    issuedAt: issuedAt.toISOString(),
    nonce: randomBytes(16).toString('base64url'),
  };
  return { ...unsigned, signature: identity.sign(payload(unsigned)) };
}

/** The caller must atomically consume the nonce in durable storage after this check. */
export function verifyNodeRequest(
  proof: NodeRequestProof,
  publicKey: string,
  method: string,
  path: string,
  body: Uint8Array,
  now = Date.now(),
): boolean {
  if (proof.v !== 1 || !proof.nodeId || !proof.grantId || !/^[A-Za-z0-9_-]{20,64}$/.test(proof.nonce)
    || proof.method !== method.toUpperCase() || proof.path !== path || proof.bodySha256 !== bodyHash(body)) return false;
  const at = Date.parse(proof.issuedAt);
  if (!Number.isFinite(at) || Math.abs(now - at) > 5 * 60_000) return false;
  const { signature, ...unsigned } = proof;
  return verifyNodeSignature(publicKey, payload(unsigned), signature);
}

/** Bind a successful response to the request nonce and exact response bytes. */
export function signNodeResponse(identity: NodeIdentity, requestNonce: string, body: Uint8Array): string {
  return identity.sign(Buffer.from(JSON.stringify([1, requestNonce, bodyHash(body)])));
}

export function verifyNodeResponse(publicKey: string, requestNonce: string, body: Uint8Array, signature: string): boolean {
  return verifyNodeSignature(publicKey, Buffer.from(JSON.stringify([1, requestNonce, bodyHash(body)])), signature);
}
