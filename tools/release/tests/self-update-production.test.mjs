import assert from 'node:assert/strict';
import { generateKeyPairSync, verify } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { gunzipSync } from 'node:zlib';
import { test } from 'node:test';
import { verifiedPreUpdateBackup } from '../../../apps/sync-server/scripts/pre-update-backup.mjs';

const root = resolve(import.meta.dirname, '../../..');

test('v1 update packing compresses public assets while preserving entry files and original resource bytes', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'zichan-update-assets-'));
  try {
    for (const path of ['scripts/release', 'apps/sync-server/src', 'apps/sync-server/dist', 'apps/web/dist/assets', 'apps/web/dist/ocr']) await mkdir(join(directory, path), { recursive: true });
    await writeFile(join(directory, 'scripts/release/create-update-package.mjs'), await readFile(join(root, 'scripts/release/create-update-package.mjs')));
    await writeFile(join(directory, 'apps/sync-server/package.json'), '{"version":"0.7.5"}');
    await writeFile(join(directory, 'apps/sync-server/src/store.ts'), "export const CURRENT_SERVER_SCHEMA = 27;\nexport const CURRENT_SERVER_SCHEMA_NAME = 'fixture';");
    for (const name of ['server', 'maintenance']) await writeFile(join(directory, `apps/sync-server/dist/${name}.mjs`), 'export {};');
    await writeFile(join(directory, 'apps/web/dist/index.html'), '<title>fixture</title>');
    await writeFile(join(directory, 'apps/web/dist/ocr/manifest.json'), '{}');
    const resource = Buffer.alloc(4 * 1024 * 1024, 0x5a);
    await writeFile(join(directory, 'apps/web/dist/assets/worker.js'), resource);
    execFileSync(process.execPath, [join(directory, 'scripts/release/create-update-package.mjs'), '--unsigned', join(directory, 'output')]);
    const packed = JSON.parse(await readFile(join(directory, 'output/zichan-0.7.5.json'), 'utf8'));
    assert.equal(packed.format, 'zichan-release-v1');
    assert.ok(packed.files.some((row) => row.path === 'web-dist/index.html'));
    assert.ok(packed.files.some((row) => row.path === 'web-dist/ocr/manifest.json'));
    assert.equal(packed.files.some((row) => row.path === 'web-dist/assets/worker.js'), false);
    const compressed = Buffer.from(packed.files.find((row) => row.path === 'web-dist/assets/worker.js.gz').data, 'base64');
    assert.ok(compressed.length < resource.length / 10);
    assert.deepEqual(gunzipSync(compressed), resource);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('production update verifies an offline backup before starting the target and rechecks it after interruption', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'zichan-update-backup-'));
  try {
    const backupRoot = join(directory, 'backups');
    await mkdir(backupRoot);
    const update = { taskId: '11111111-1111-4111-8111-111111111111', from: 'releases/v0.3.4', operation: 'update' };
    const calls = [];
    const maintenance = async (entry, command, dataDir, options) => {
      calls.push({ entry, command, dataDir, options });
      if (command === 'backup') await mkdir(options[1]);
      if (command === 'verify-backup') assert.equal(options[1], calls[0].options[1]);
    };
    const parameters = { runtime: join(directory, 'runtime'), update, backupRoot,
      dataDir: join(directory, 'state', 'server'), maintenance };
    const backup = await verifiedPreUpdateBackup(parameters);
    assert.deepEqual(calls.map((call) => call.command), ['backup', 'verify-backup']);
    assert.ok(calls[0].entry.endsWith(join('releases', 'v0.3.4', 'dist', 'maintenance.mjs')));
    assert.equal(backup, join(backupRoot, `pre-update-${update.taskId}`));
    calls.length = 0;
    await verifiedPreUpdateBackup(parameters);
    assert.deepEqual(calls.map((call) => call.command), ['verify-backup']);
    await assert.rejects(verifiedPreUpdateBackup({ ...parameters,
      maintenance: async () => { throw new Error('corrupt backup'); } }), /corrupt backup/);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('signing job signs only a version-matched candidate with an Ed25519 key', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'zichan-release-sign-'));
  try {
    const { privateKey, publicKey } = generateKeyPairSync('ed25519');
    const key = join(directory, 'key.pem');
    const artifact = join(directory, 'zichan-0.4.1.json');
    await writeFile(key, privateKey.export({ type: 'pkcs8', format: 'pem' }));
    await writeFile(artifact, JSON.stringify({ format: 'zichan-release-v1', version: '0.4.1',
      schema: { version: 27, name: 'single_user_replica_storage_v27' }, files: [
        { path: 'dist/server.mjs', data: 'c2VydmVy' },
        { path: 'dist/maintenance.mjs', data: 'bWFpbnRlbmFuY2U=' },
        { path: 'web-dist/index.html', data: 'aA==' },
      ] }));
    const script = join(root, 'scripts', 'release', 'sign-update-package.mjs');
    execFileSync(process.execPath, [script, 'v0.4.1', key, artifact, directory]);
    const publicPath = join(directory, 'public.pem');
    await writeFile(publicPath, publicKey.export({ type: 'spki', format: 'pem' }));
    execFileSync(process.execPath, [join(root, 'scripts', 'release', 'verify-update-package.mjs'),
      publicPath, join(directory, 'latest.json'), artifact]);
    const feed = JSON.parse(await readFile(join(directory, 'latest.json'), 'utf8'));
    assert.equal(feed.version, '0.4.1');
    assert.equal(verify(null, Buffer.from(`${feed.format}\n${feed.version}\n${feed.artifact}\n${feed.sha256}\n`),
      publicKey, Buffer.from(feed.signature, 'base64')), true);
    assert.throws(() => execFileSync(process.execPath, [script, 'v0.4.0', key, artifact, directory],
      { stdio: 'pipe' }), /候选包文件名与标签不一致/);
  } finally { await rm(directory, { recursive: true, force: true }); }
});


test('signing accepts large base64 assets and rejects malformed payloads without a stack overflow', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'zichan-release-large-'));
  try {
    const { privateKey, publicKey } = generateKeyPairSync('ed25519');
    const key = join(directory, 'key.pem');
    const artifact = join(directory, 'zichan-0.4.1.json');
    const publicPath = join(directory, 'public.pem');
    await writeFile(key, privateKey.export({ type: 'pkcs8', format: 'pem' }));
    await writeFile(publicPath, publicKey.export({ type: 'spki', format: 'pem' }));
    const data = Buffer.alloc(8 * 1024 * 1024, 0x5a).toString('base64');
    const candidate = { format: 'zichan-release-v1', version: '0.4.1',
      schema: { version: 27, name: 'single_user_replica_storage_v27' }, files: [
        { path: 'dist/server.mjs', data: 'c2VydmVy' },
        { path: 'dist/maintenance.mjs', data: 'bWFpbnRlbmFuY2U=' },
        { path: 'web-dist/index.html', data: 'd2Vi' },
        { path: 'web-dist/assets/large-worker.mjs', data },
      ] };
    const script = join(root, 'scripts/release/sign-update-package.mjs');
    await writeFile(artifact, JSON.stringify(candidate));
    execFileSync(process.execPath, [script, 'v0.4.1', key, artifact, directory]);
    execFileSync(process.execPath, [join(root, 'scripts/release/verify-update-package.mjs'),
      publicPath, join(directory, 'latest.json'), artifact]);
    for (const invalid of ['A', 'AA=', 'AAA==', 'AA=A', 'AAAA\n', 'AAA\n', 'AAA\r', 'AAA\u2028', 'AAA\u2029', `${data.slice(0, -1)}!`, `${data}====`]) {
      candidate.files.at(-1).data = invalid;
      await writeFile(artifact, JSON.stringify(candidate));
      assert.throws(() => execFileSync(process.execPath, [script, 'v0.4.1', key, artifact, directory],
        { stdio: 'pipe' }), /候选包含有非法文件/);
    }
  } finally { await rm(directory, { recursive: true, force: true }); }
});
