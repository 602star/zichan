import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';
import { test } from 'node:test';
import { inspectThreeNodes } from './three-node-preflight.mjs';

const urls = ['https://public.example.test/ledger', 'https://home.example.test/ledger',
  'https://office.example.test/ledger'];
const keys = urls.map(() => generateKeyPairSync('ed25519').publicKey
  .export({ format: 'der', type: 'spki' }).toString('base64url'));

function fetcher(options = {}) {
  return async (input) => {
    const url = new URL(input);
    const index = urls.findIndex((value) => new URL(value).hostname === url.hostname);
    if (index < 0) throw new Error('unexpected URL');
    const serverId = options.duplicateId && index === 2 ? 'server-node-1' : `server-node-${index + 1}`;
    const body = url.pathname.endsWith('/api/health') ? {
      ok: true, serverId, nodePublicKey: keys[index], claimed: true, syncEnabled: true,
      webEnabled: true, basePath: '/ledger', protocols: [3],
      capabilities: ['node-replication-v1', 'portable-blobs-v2', 'encrypted-commits-v3'],
    } : { ok: !options.unready || index !== 1, serverId,
      database: { schemaVersion: options.mixedSchema && index === 2 ? 24 : 25 } };
    return new Response(JSON.stringify(body), { status: 200 });
  };
}

test('accepts three independent ready nodes at the same schema', async () => {
  const result = await inspectThreeNodes(urls, { fetcher: fetcher() });
  assert.equal(result.ok, true);
  assert.equal(result.nodes.length, 3);
  assert.equal(result.nodes[0].nodeKeySha256.length, 64);
});

test('rejects cloned identities and unready nodes, but reports an optional schema difference', async () => {
  const result = await inspectThreeNodes(urls, { fetcher: fetcher({ duplicateId: true,
    mixedSchema: true, unready: true }) });
  assert.equal(result.ok, false);
  assert.match(result.issues.join(' '), /Node IDs are not distinct/);
  assert.match(result.warnings.join(' '), /schema versions differ/);
  assert.match(result.issues.join(' '), /health and readiness do not agree/);
});

test('permits a plain HTTP public URL only for a loopback rehearsal', async () => {
  const local = ['http://127.0.0.1:10001/ledger', urls[1], urls[2]];
  const localFetcher = async (input) => fetcher()(String(input).replace('http://127.0.0.1:10001',
    'https://public.example.test'));
  assert.equal((await inspectThreeNodes(local, { fetcher: localFetcher })).ok, false);
  assert.equal((await inspectThreeNodes(local, { fetcher: localFetcher, allowLocalHttp: true })).ok, true);
  const remoteHttp = ['http://public.example.test/ledger', urls[1], urls[2]];
  const remoteFetcher = async (input) => fetcher()(String(input).replace('http://public.example.test',
    'https://public.example.test'));
  assert.equal((await inspectThreeNodes(remoteHttp, { fetcher: remoteFetcher, allowLocalHttp: true })).ok, false);
});
