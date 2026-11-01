import { createSyncServer } from '../../apps/sync-server/dist/server.js';
import { loginAccount, registerAccount } from '../../packages/db/dist/index.js';
import { resolve } from 'node:path';
import { closeTestSyncServer } from './safe-listen.mjs';
const setup = 'native-acceptance-only-owner-00000000000';
const server = createSyncServer({ dataDir: resolve('.runtime/native-acceptance-server'), registrationMode: 'open', ownerSetupToken: setup });
await server.ready;
await new Promise((done) => server.server.listen(19342, '127.0.0.1', done));
const url = 'http://127.0.0.1:19342';
try { await loginAccount(url, 'native-test', 'native-test-password'); }
catch {
  await registerAccount(url, 'owner', 'owner-test-password', { ownerSetupToken: setup });
  await registerAccount(url, 'native-test', 'native-test-password');
}
console.log('Native acceptance fixture ready at http://127.0.0.1:19342');
process.stdin.setEncoding('utf8');
process.stdin.on('data', async (value) => { if (value.trim() === 'shutdown') { await closeTestSyncServer(server); process.exit(0); } });
process.stdin.resume();
