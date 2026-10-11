import { createSyncServer, type SyncServerOptions } from '../../src/server.js';
import { randomInt } from 'node:crypto';

// Explicit test-only deployment secret. Production always generates a random file.
export const OWNER_SETUP_TOKEN = 'test-only-owner-setup-token-0000000000000000';

export function createTestSyncServer(options: SyncServerOptions = {}) {
  const instance = createSyncServer({ registrationMode: 'open', ...options, ownerSetupToken: OWNER_SETUP_TOKEN });
  const listen = instance.server.listen.bind(instance.server) as (...args: unknown[]) => typeof instance.server;
  // Windows on this host allocates port 0 in a range that includes Fetch's
  // forbidden ports. Keep test HTTP listeners above that range and retry when
  // another local process already owns the selected port.
  instance.server.listen = ((...args: unknown[]) => {
    if (args[0] !== 0) return listen(...args);
    const callback = typeof args[args.length - 1] === 'function' ? args.pop() as () => void : undefined;
    if (callback) instance.server.once('listening', callback);
    let attempts = 0;
    const tryListen = () => {
      attempts += 1;
      const onError = (error: NodeJS.ErrnoException) => {
        instance.server.off('listening', onListening);
        if (error.code === 'EADDRINUSE' && attempts < 20) {
          tryListen();
          return;
        }
        process.nextTick(() => instance.server.emit('error', error));
      };
      const onListening = () => instance.server.off('error', onError);
      instance.server.once('error', onError);
      instance.server.once('listening', onListening);
      listen(randomInt(20_000, 49_000), ...args.slice(1));
    };
    tryListen();
    return instance.server;
  }) as typeof instance.server.listen;
  return instance;
}
