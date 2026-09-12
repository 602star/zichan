import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';

/** Separate deployment key; never derive it from an account password or auth secret. */
export function loadCustodyKey(path: string, required: boolean): Buffer {
  if (!existsSync(path)) {
    if (required) throw new Error('托管主密钥缺失，不能生成替代密钥；请恢复原 custody.key');
    writeFileSync(path, randomBytes(32).toString('hex'), { flag: 'wx', mode: 0o600 });
  }
  const value = readFileSync(path, 'utf8').trim();
  if (!/^[a-f0-9]{64}$/.test(value)) throw new Error('托管主密钥格式无效');
  return Buffer.from(value, 'hex');
}

export function sealCustodySecret(key: Buffer, scope: string, secret: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  cipher.setAAD(Buffer.from(scope));
  const ciphertext = Buffer.concat([cipher.update(secret, 'utf8'), cipher.final()]);
  return Buffer.concat([iv, cipher.getAuthTag(), ciphertext]).toString('base64');
}

export function openCustodySecret(key: Buffer, scope: string, sealed: string): string {
  const value = Buffer.from(sealed, 'base64');
  const decipher = createDecipheriv('aes-256-gcm', key, value.subarray(0, 12));
  decipher.setAAD(Buffer.from(scope));
  decipher.setAuthTag(value.subarray(12, 28));
  return Buffer.concat([decipher.update(value.subarray(28)), decipher.final()]).toString('utf8');
}
