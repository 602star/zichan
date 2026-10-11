import { resolve, join } from 'node:path';
import { createSyncServer } from '../../apps/sync-server/dist/server.js';
import { SyncServerStore } from '../../apps/sync-server/dist/store.js';
import { loginAccount, registerAccount } from '../../packages/db/dist/index.js';
import { accountSigningPublicKey, createAccountEncryptionKey, createLedgerCryptoSession,
  signLedgerControlEvent, wrapLedgerCryptoSessionForMember } from '../../packages/core/dist/index.js';

const dataDir = resolve('.runtime/desktop-profile-e2e/server');
const url = 'http://127.0.0.1:19343';
const password = 'native-profile-account-password';
const keyPassword = 'native-profile-member-key-password';
const server = createSyncServer({ dataDir, registrationMode: 'open',
  ownerSetupToken: 'native-profile-setup-token-0000000000', allowInsecureHttp: true });
let store;
try {
  await server.ready;
  await new Promise((done) => server.server.listen(19343, '127.0.0.1', done));
  await registerAccount(url, 'owner', password,
    { ownerSetupToken: 'native-profile-setup-token-0000000000' });
  await registerAccount(url, 'alice', password);
  store = new SyncServerStore(join(dataDir, 'server.sqlite'), 'open', server.serverId);
  await store.ready;
  const owner = await store.getUser('owner');
  const alice = await store.getUser('alice');
  if (!owner || !alice) throw new Error('test accounts missing');
  const aliceSession = await loginAccount(url, 'alice', password);
  const personal = await fetch(`${url}/api/v3/protection/initialize`, { method: 'POST',
    headers: { Authorization: `Bearer ${aliceSession.accessToken}`,
      'Content-Type': 'application/json' }, body: JSON.stringify({ mode: 'managed' }) });
  if (!personal.ok) throw new Error(`personal ledger initialization failed: ${personal.status}`);
  const personalLedgerId = (await personal.json()).replica.ledgerId;

  const sharedLedgerId = 'ledger-native-shared-0001';
  await store.bindReplica('owner', sharedLedgerId);
  const ownerKey = await createAccountEncryptionKey(server.serverId, owner.accountId, keyPassword);
  const aliceKey = await createAccountEncryptionKey(server.serverId, alice.accountId, keyPassword);
  await store.putAccountEncryptionKey(server.serverId, owner.accountId,
    ownerKey.envelope.publicKey, ownerKey.envelope, 0);
  await store.putAccountEncryptionKey(server.serverId, alice.accountId,
    aliceKey.envelope.publicKey, aliceKey.envelope, 0);
  const actor = { issuerNodeId: server.serverId, accountId: owner.accountId };
  const target = { issuerNodeId: server.serverId, accountId: alice.accountId };
  const ownerSession = await loginAccount(url, 'owner', password);
  const headers = { Authorization: `Bearer ${ownerSession.accessToken}`,
    'Content-Type': 'application/json' };
  const control = async (path, body) => {
    const response = await fetch(`${url}${path}`, { method: 'POST', headers,
      body: JSON.stringify(body) });
    if (!response.ok) throw new Error(`${path}: ${response.status} ${await response.text()}`);
    return response.json();
  };
  const genesis = signLedgerControlEvent(ownerKey.privateKey,
    { v: 1, ledgerId: sharedLedgerId, seq: 1, previousHash: null, keyEpoch: 1,
      kind: 'MemberGenesis', actor, target: actor, role: 'OWNER',
      signingPublicKey: accountSigningPublicKey(ownerKey.privateKey),
      encryptionPublicKey: ownerKey.envelope.publicKey });
  const first = await control('/api/v4/ledger/control', { event: genesis });
  const sharedSession = createLedgerCryptoSession(sharedLedgerId);
  const ownerEnvelope = await wrapLedgerCryptoSessionForMember(sharedSession,
    { ...actor, recipientPublicKey: ownerKey.envelope.publicKey, keyEpoch: 1 });
  const envelopeResponse = await fetch(`${url}/api/v4/ledger/member-envelope`, {
    method: 'PUT', headers, body: JSON.stringify({ envelope: ownerEnvelope }),
  });
  if (!envelopeResponse.ok) throw new Error(`owner envelope: ${envelopeResponse.status}`);
  const added = signLedgerControlEvent(ownerKey.privateKey,
    { v: 1, ledgerId: sharedLedgerId, seq: 2, previousHash: first.state.headHash,
      keyEpoch: 1, kind: 'MemberAdded', actor, target, role: 'EDITOR',
      signingPublicKey: accountSigningPublicKey(aliceKey.privateKey),
      encryptionPublicKey: aliceKey.envelope.publicKey });
  const aliceEnvelope = await wrapLedgerCryptoSessionForMember(sharedSession,
    { ...target, recipientPublicKey: aliceKey.envelope.publicKey, keyEpoch: 1 });
  await control('/api/v4/ledger/control/events', { event: added, envelopes: [aliceEnvelope] });
  ownerKey.privateKey.fill(0);
  aliceKey.privateKey.fill(0);
  await import('./native-seed-shared.mjs');
  const me = await fetch(`${url}/api/auth/me`, {
    headers: { Authorization: `Bearer ${aliceSession.accessToken}` },
  });
  if (!me.ok || !(await me.json()).ledgers?.some((entry) => entry.ledgerId === sharedLedgerId)) {
    throw new Error('second ledger not selectable');
  }
  console.log(JSON.stringify({ url, personalLedgerId, sharedLedgerId }));
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', async (value) => {
    if (value.trim() !== 'shutdown') return;
    await store.close();
    server.server.closeAllConnections();
    await server.close();
    process.exit(0);
  });
  process.stdin.resume();
} catch (error) {
  console.error(error);
  await store?.close();
  await server.close();
  process.exitCode = 1;
}
