import { createPrivateKey, createPublicKey, generateKeyPairSync, sign, verify, type KeyObject } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export const NODE_SIGNING_KEY_FILE = 'node-signing.key';

export interface NodeIdentity {
  nodeId: string;
  publicKey: string;
  sign(payload: Uint8Array): string;
}

function publicKeyText(key: KeyObject): string {
  return createPublicKey(key).export({ format: 'der', type: 'spki' }).toString('base64url');
}

export function verifyNodeSignature(publicKey: string, payload: Uint8Array, signature: string): boolean {
  try {
    const key = createPublicKey({ key: Buffer.from(publicKey, 'base64url'), format: 'der', type: 'spki' });
    if (key.asymmetricKeyType !== 'ed25519') return false;
    return verify(null, payload, key, Buffer.from(signature, 'base64url'));
  } catch {
    return false;
  }
}

/** A pre-existing binding makes a missing key a hard failure, never a new identity. */
export function loadNodeIdentity(dataDir: string, nodeId: string, expectedPublicKey?: string): NodeIdentity {
  const path = join(dataDir, NODE_SIGNING_KEY_FILE);
  if (!existsSync(path)) {
    if (expectedPublicKey) throw new Error('节点签名私钥缺失；请恢复原 node-signing.key，不能重建节点身份');
    const { privateKey } = generateKeyPairSync('ed25519');
    const pem = privateKey.export({ format: 'pem', type: 'pkcs8' });
    try {
      writeFileSync(path, pem, { mode: 0o600, flag: 'wx' });
    } catch (error) {
      if (!existsSync(path)) throw error;
    }
  }
  let privateKey: KeyObject;
  try {
    privateKey = createPrivateKey(readFileSync(path));
    if (privateKey.asymmetricKeyType !== 'ed25519') throw new Error('not Ed25519');
  } catch {
    throw new Error('节点签名私钥损坏或类型不支持；请恢复原 node-signing.key');
  }
  const publicKey = publicKeyText(privateKey);
  if (expectedPublicKey && expectedPublicKey !== publicKey) {
    throw new Error('节点签名私钥与服务器数据库记录不一致；已拒绝改变节点身份');
  }
  return {
    nodeId,
    publicKey,
    sign: (payload) => sign(null, payload, privateKey).toString('base64url'),
  };
}
