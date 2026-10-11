import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { createFederatedLoginIntent, verifyFederatedLoginIntent } from '../src/federated-login.js';
import { loadNodeIdentity } from '../src/node-identity.js';

describe('federated browser login intent', () => {
  it('accepts a signed private LAN callback and rejects a plaintext public callback', () => {
    const root = mkdtempSync(join(tmpdir(), 'zichan-federation-intent-'));
    try {
      const target = loadNodeIdentity(root, 'srv-target');
      const issuerNodeId = 'srv-issuer';
      const grantId = 'grant-example';
      const privateIntent = createFederatedLoginIntent(target, issuerNodeId, grantId,
        'http://192.168.1.7:8787/api/auth/federation/callback');
      expect(verifyFederatedLoginIntent(privateIntent, target.publicKey, issuerNodeId, grantId)).toBe(true);
      const publicIntent = createFederatedLoginIntent(target, issuerNodeId, grantId,
        'http://ledger.example.com/api/auth/federation/callback');
      expect(verifyFederatedLoginIntent(publicIntent, target.publicKey, issuerNodeId, grantId)).toBe(false);
      expect(verifyFederatedLoginIntent({ ...privateIntent, callbackUrl: publicIntent.callbackUrl },
        target.publicKey, issuerNodeId, grantId)).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
