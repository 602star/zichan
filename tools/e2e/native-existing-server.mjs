import { resolve } from 'node:path';
import { createSyncServer } from '../../apps/sync-server/dist/server.js';

const server = createSyncServer({
  dataDir: resolve('.runtime/desktop-profile-e2e/server'), registrationMode: 'open',
  ownerSetupToken: 'native-profile-setup-token-0000000000', allowInsecureHttp: true,
});
await server.ready;
await new Promise((done) => server.server.listen(19343, '127.0.0.1', done));
console.log('native profile server resumed at http://127.0.0.1:19343');
