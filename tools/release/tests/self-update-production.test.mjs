import assert from 'node:assert/strict';
import { generateKeyPairSync, verify } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { test } from 'node:test';
import { verifiedPreUpdateBackup } from '../../../apps/sync-server/scripts/pre-update-backup.mjs';

const root = resolve(import.meta.dirname, '../../..');

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
        { path: 'web-dist/index.html', data: 'd2Vi' },
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
