import { randomInt } from 'node:crypto';

// Port 0 can select a Fetch-forbidden port on hosts with a low ephemeral range.
// Keep browser-facing test servers in a safe range and retry occupied ports.
export async function listenOnSafePort(server, host = '127.0.0.1') {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    try {
      await new Promise((resolve, reject) => {
        const cleanup = () => {
          server.off('listening', onListening);
          server.off('error', onError);
        };
        const onListening = () => { cleanup(); resolve(); };
        const onError = (error) => { cleanup(); reject(error); };
        server.once('listening', onListening);
        server.once('error', onError);
        try {
          server.listen(randomInt(20_000, 49_000), host);
        } catch (error) {
          cleanup();
          reject(error);
        }
      });
      return;
    } catch (error) {
      if (error?.code !== 'EADDRINUSE' || attempt === 19) throw error;
    }
  }
}

// createSyncServer.close() starts its HTTP close after draining background work.
// Force remaining test connections only once that HTTP close has started.
export async function closeTestSyncServer(instance) {
  const httpServer = instance.server;
  const originalClose = httpServer.close;
  httpServer.close = function (...args) {
    const result = originalClose.apply(this, args);
    httpServer.closeAllConnections();
    return result;
  };
  try {
    await instance.close();
  } finally {
    httpServer.close = originalClose;
  }
}
