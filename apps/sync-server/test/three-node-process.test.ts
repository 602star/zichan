import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { randomInt } from 'node:crypto';
import { once } from 'node:events';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { buildSync } from 'esbuild';
import { encryptJson, sha256Json, unlockLedgerKeyEnvelope, type LedgerKeyEnvelope } from '@zichan/core';
import { loginAccount, registerAccount } from '@zichan/db';

interface RunningNode {
  child: ChildProcessWithoutNullStreams;
  dataDir: string;
  port: number;
  url: string;
  output: () => string;
  identity: { serverId: string; nodePublicKey: string };
}

async function availablePort(excluded: Set<number>): Promise<number> {
  for (let attempt = 0; attempt < 40; attempt += 1) {
    const port = randomInt(20_000, 49_000);
    if (excluded.has(port)) continue;
    const socket = createServer();
    try {
      socket.listen(port, '127.0.0.1');
      await once(socket, 'listening');
      await new Promise<void>((done) => socket.close(() => done()));
      excluded.add(port);
      return port;
    } catch (error) {
      socket.close();
      if ((error as NodeJS.ErrnoException).code !== 'EADDRINUSE') throw error;
    }
  }
  throw new Error('no free process test port');
}

async function waitUntil<T>(check: () => Promise<T | undefined>, description: string,
  timeoutMs = 60_000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const result = await check();
    if (result !== undefined) return result;
    await new Promise<void>((done) => setTimeout(done, 200));
  }
  throw new Error(`timed out waiting for ${description}`);
}

async function startNode(entry: string, dataDir: string, port: number): Promise<RunningNode> {
  const url = `http://127.0.0.1:${port}`;
  const child = spawn(process.execPath, [entry], {
    env: { ...process.env, DATA_DIR: dataDir, PORT: String(port), HOST: '127.0.0.1',
      REGISTRATION_MODE: 'open', CONTROL_STDIN: '1', ENABLE_WEB: '0', ALLOW_INSECURE_HTTP: '1',
      ADMIN_BACKUP_AUTO: 'off' },
    stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true,
  });
  let output = '';
  const record = (chunk: Buffer) => { output = `${output}${chunk.toString()}`.slice(-12_000); };
  child.stdout.on('data', record);
  child.stderr.on('data', record);
  try {
    const identity = await waitUntil(async () => {
      if (child.exitCode !== null) throw new Error(`server exited before readiness: ${output}`);
      try {
        const response = await fetch(`${url}/api/health`, { signal: AbortSignal.timeout(1_000) });
        if (!response.ok) return;
        const health = await response.json() as { serverId: string; nodePublicKey: string };
        return health.serverId && health.nodePublicKey
          ? { serverId: health.serverId, nodePublicKey: health.nodePublicKey } : undefined;
      } catch { return; }
    }, `server ${dataDir}`, 30_000);
    return { child, dataDir, port, url, output: () => output, identity };
  } catch (error) {
    child.kill();
    throw error;
  }
}

async function stopNode(node: RunningNode): Promise<void> {
  if (node.child.exitCode !== null || node.child.signalCode !== null) return;
  const exited = once(node.child, 'exit');
  node.child.stdin.write('shutdown\n');
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      exited,
      new Promise<never>((_, reject) => {
        timeout = setTimeout(() => reject(new Error(`shutdown timed out: ${node.output()}`)), 15_000);
      }),
    ]);
  } finally { if (timeout) clearTimeout(timeout); }
  expect(node.child.exitCode).toBe(0);
}

async function request(node: RunningNode, headers: Record<string, string>, path: string,
  body?: unknown): Promise<Record<string, unknown>> {
  const response = await fetch(`${node.url}${path}`, {
    method: body === undefined ? 'GET' : 'POST',
    headers: { ...headers, ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const result = await response.json() as Record<string, unknown>;
  expect(response.status, `${path} on ${node.identity.serverId}: ${JSON.stringify(result)}`).toBeLessThan(300);
  return result;
}

describe('independent three-node processes', () => {
  it('keeps writing during hub outage and converges through background work after restart', async () => {
    const root = mkdtempSync(join(tmpdir(), 'zichan-process-replica-'));
    const entry = join(root, 'server.mjs');
    const nodes: RunningNode[] = [];
    const ports = new Set<number>();
    try {
      buildSync({ entryPoints: [fileURLToPath(new URL('../src/main.ts', import.meta.url))],
        outfile: entry, bundle: true, platform: 'node', target: 'node26', format: 'esm',
        banner: { js: "import { createRequire } from 'node:module';\nconst require = createRequire(import.meta.url);" } });
      const locations = ['hub', 'home', 'office'];
      for (const location of locations) {
        nodes.push(await startNode(entry, join(root, location), await availablePort(ports)));
      }
      let [hub, home, office] = nodes as [RunningNode, RunningNode, RunningNode];
      const hubIdentity = hub.identity;
      const password = 'process-replica-password';
      const headers: Record<string, string>[] = [];
      for (const node of nodes) {
        const ownerSetupToken = readFileSync(join(node.dataDir, 'owner-setup.secret'), 'utf8').trim();
        await registerAccount(node.url, 'owner', password, { ownerSetupToken });
        const login = await loginAccount(node.url, 'owner', password);
        headers.push({ Authorization: `Bearer ${login.accessToken}` });
      }
      const [hubAuth, homeAuth, officeAuth] = headers as [Record<string, string>, Record<string, string>, Record<string, string>];
      const initialized = await request(hub, hubAuth, '/api/v3/protection/initialize', { mode: 'managed' });
      const envelope = initialized['envelope'] as LedgerKeyEnvelope;
      const ledgerId = (initialized['replica'] as { ledgerId: string }).ledgerId;
      const key = await unlockLedgerKeyEnvelope(initialized['secret'] as string, envelope);
      for (const [node, auth] of [[home, homeAuth], [office, officeAuth]] as const) {
        await request(node, auth, '/api/v3/protection/initialize', { mode: 'managed', envelope,
          secret: initialized['secret'] });
        const grant = await request(hub, hubAuth, '/api/v4/replication/grants', {
          peerNodeId: node.identity.serverId, peerPublicKey: node.identity.nodePublicKey,
          expiresAt: new Date(Date.now() + 86_400_000).toISOString(),
        });
        await request(node, auth, '/api/v4/replication/links', {
          peerUrl: hub.url, peerNodeId: hub.identity.serverId,
          peerPublicKey: hub.identity.nodePublicKey, grantId: grant['grantId'],
        });
      }
      const write = async (node: RunningNode, auth: Record<string, string>, commitId: string) => {
        const commit = { protocol: 2, ledgerId, commitId, originDeviceId: node.identity.serverId,
          createdAt: new Date().toISOString(), parentCommitIds: [], revisions: [] };
        const contentHash = await sha256Json(commit);
        const encCommit = await encryptJson(key, commit, { protocol: 2, ledgerId, commitId, contentHash });
        await request(node, auth, '/api/v3/commits', {
          commits: [{ commitId, ledgerId, contentHash, encCommit }],
        });
      };
      const ids = async (node: RunningNode, auth: Record<string, string>) => {
        const page = await request(node, auth, '/api/v3/commits?after=0');
        return (page['commits'] as { commitId: string }[]).map((item) => item.commitId).sort();
      };
      await write(hub, hubAuth, 'process-hub-before-outage-0001');
      await waitUntil(async () => {
        const seen = await Promise.all([ids(home, homeAuth), ids(office, officeAuth)]);
        return seen.every((items) => items.includes('process-hub-before-outage-0001')) ? true : undefined;
      }, 'initial background replication');

      await stopNode(hub);
      await expect(fetch(`${hub.url}/api/health`, { signal: AbortSignal.timeout(1_000) })).rejects.toThrow();
      await Promise.all([
        write(home, homeAuth, 'process-home-offline-0000001'),
        write(office, officeAuth, 'process-office-offline-00001'),
      ]);
      expect(await ids(home, homeAuth)).toContain('process-home-offline-0000001');
      expect(await ids(office, officeAuth)).toContain('process-office-offline-00001');
      hub = await startNode(entry, hub.dataDir, hub.port);
      nodes[0] = hub;
      expect(hub.identity).toEqual(hubIdentity);
      const expected = ['process-home-offline-0000001', 'process-hub-before-outage-0001',
        'process-office-offline-00001'];
      await waitUntil(async () => {
        const seen = await Promise.all([ids(hub, hubAuth), ids(home, homeAuth), ids(office, officeAuth)]);
        return seen.every((items) => JSON.stringify(items) === JSON.stringify(expected)) ? true : undefined;
      }, 'three-process convergence after hub restart', 90_000);
      for (const [node, auth] of [[hub, hubAuth], [home, homeAuth], [office, officeAuth]] as const) {
        expect(await ids(node, auth)).toEqual(expected);
      }
    } finally {
      for (const node of nodes) {
        try { await stopNode(node); }
        catch { node.child.kill(); }
      }
      const safePrefix = `${resolve(tmpdir())}${sep}zichan-process-replica-`;
      if (!resolve(root).startsWith(safePrefix)) throw new Error('unsafe temporary process test directory');
      rmSync(root, { recursive: true, force: true });
    }
  }, 150_000);
});
