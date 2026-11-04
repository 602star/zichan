import assert from 'node:assert/strict';
import { execFile as execFileCallback } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { promisify } from 'node:util';
import { compressPortablePaths, createWindowsPortable as createWindowsPortableActual, validatePortableDirectory } from '../../../scripts/release/create-windows-portable.mjs';
import { verifyReleaseArtifacts } from '../../../scripts/release/verify-artifacts.mjs';
import { runtimeTreeDigest } from '../../../scripts/release/setup-webview2-runtime.mjs';

const VERSION = '0.1.0';
const RUNTIME_VERSION = '151.0.4129.101';
const NODE_VERSION = '26.13.0';
const HASH = 'a'.repeat(64);
const execFile = promisify(execFileCallback);
const createWindowsPortable = (options) => createWindowsPortableActual({ inspectNodeVersion: () => NODE_VERSION, ...options });

async function expandPortableArchive(archive, destination) {
  await execFile('powershell.exe', [
    '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command',
    'Expand-Archive -LiteralPath $env:ZICHAN_TEST_ARCHIVE -DestinationPath $env:ZICHAN_TEST_EXTRACTED -Force',
  ], {
    env: { ...process.env, ZICHAN_TEST_ARCHIVE: archive, ZICHAN_TEST_EXTRACTED: destination },
  });
}

async function rewriteOuterHash(archive) {
  const bytes = await readFile(archive);
  const hash = createHash('sha256').update(bytes).digest('hex');
  await writeFile(`${archive}.sha256`, `${hash}  ${archive.split(/[\\/]/).at(-1)}\n`);
}

function pe(machine = 0x8664) {
  const bytes = Buffer.alloc(128);
  bytes.write('MZ', 0, 'ascii');
  bytes.writeUInt32LE(64, 0x3c);
  bytes.writeUInt32LE(0x00004550, 64);
  bytes.writeUInt16LE(machine, 68);
  return bytes;
}

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'zichan-portable-package-'));
  const resources = join(root, 'resources');
  const runtime = join(root, 'runtime');
  const docs = join(root, 'docs');
  const executable = join(root, 'zichan.exe');
  const output = join(root, 'output');
  const lock = join(root, 'runtime-lock.json');
  await mkdir(join(resources, 'web'), { recursive: true });
  await mkdir(runtime, { recursive: true });
  await mkdir(docs, { recursive: true });
  await writeFile(join(root, 'package.json'), `${JSON.stringify({ version: VERSION })}\n`);
  await writeFile(join(root, '.node-version'), `${NODE_VERSION}\n`);
  await writeFile(executable, pe());
  await writeFile(join(resources, 'node.exe'), pe());
  await writeFile(join(resources, 'node-LICENSE.txt'), 'Node.js license');
  await writeFile(join(resources, 'server.mjs'), 'server');
  await writeFile(join(resources, 'web', 'index.html'), '<!doctype html>');
  await writeFile(join(runtime, 'msedgewebview2.exe'), pe());
  await writeFile(join(runtime, 'msedge.dll'), 'dll');
  await writeFile(join(runtime, 'icudtl.dat'), 'data');
  const tree = await runtimeTreeDigest(runtime);
  await writeFile(join(runtime, '.zichan-webview2-runtime.json'), `${JSON.stringify({
    schemaVersion: 1,
    runtimeVersion: RUNTIME_VERSION,
    architecture: 'x64',
    cabSha256: HASH,
    runtimeTreeSha256: tree.sha256,
    runtimeFileCount: tree.fileCount,
  })}\n`);
  for (const name of ['README-便携版.txt', 'NOTICE.txt']) await writeFile(join(docs, name), name);
  await writeFile(lock, `${JSON.stringify({
    schemaVersion: 1,
    runtimeVersion: RUNTIME_VERSION,
    architecture: 'x64',
    downloadUrl: 'https://download.microsoft.com/webview2.cab',
    sha256: HASH,
    runtimeTreeSha256: tree.sha256,
    sourcePage: 'https://developer.microsoft.com/en-us/microsoft-edge/webview2/',
  })}\n`);
  return { root, resources, runtime, docs, executable, output, lock };
}

test('stages a complete portable directory with marker and exact file hashes but no data directory', async () => {
  const value = await fixture();
  try {
    const result = await createWindowsPortable({
      repositoryRoot: value.root,
      resources: value.resources,
      runtime: value.runtime,
      docsDirectory: value.docs,
      executable: value.executable,
      outputDirectory: value.output,
      lockPath: value.lock,
      archive: false,
    });
    assert.equal(result.marker.dataDirectory, 'data');
    assert.equal(result.manifest.webview2RuntimeVersion, RUNTIME_VERSION);
    assert.equal(result.manifest.nodeVersion, NODE_VERSION);
    assert.ok(result.fileCount >= 11);
    const marker = JSON.parse(await readFile(join(result.directory, 'portable-mode.json'), 'utf8'));
    assert.deepEqual(marker, { formatVersion: 1, appVersion: VERSION, architecture: 'x64', dataDirectory: 'data' });
    await validatePortableDirectory(result.directory, { version: VERSION, runtimeVersion: RUNTIME_VERSION });
  } finally {
    await rm(value.root, { recursive: true, force: true });
  }
});

test('rejects a bundled Node.js version that differs from the release pin', async () => {
  const value = await fixture();
  try {
    await assert.rejects(createWindowsPortable({
      repositoryRoot: value.root,
      resources: value.resources,
      runtime: value.runtime,
      docsDirectory: value.docs,
      executable: value.executable,
      outputDirectory: value.output,
      lockPath: value.lock,
      archive: false,
      inspectNodeVersion: () => '26.3.0',
    }), /Bundled Node\.js runtime is 26\.3\.0, expected 26\.13\.0/);
  } finally {
    await rm(value.root, { recursive: true, force: true });
  }
});

test('rejects release sources containing user data, secrets, databases, or debug symbols', async () => {
  for (const relativePath of [
    'data/ledger.sqlite',
    'server.secret',
    'server.pid',
    'stronghold-salt.txt',
    '.env.production',
    '.npmrc',
    'signing.pfx',
    'updater-private.pem',
    'server.key',
    'credentials.json',
    'backup.zcbak',
    'node_modules/module.js',
    '.git/config',
    '.runtime/state',
    '.tools/cache',
    'source.js.map',
    'latest.json',
    'updater.sig',
    'debug.pdb',
  ]) {
    const value = await fixture();
    try {
      const path = join(value.resources, ...relativePath.split('/'));
      await mkdir(join(path, '..'), { recursive: true });
      await writeFile(path, 'forbidden');
      await assert.rejects(createWindowsPortable({
        repositoryRoot: value.root,
        resources: value.resources,
        runtime: value.runtime,
        docsDirectory: value.docs,
        executable: value.executable,
        outputDirectory: value.output,
        lockPath: value.lock,
        archive: false,
      }), /forbidden|data directory/);
    } finally {
      await rm(value.root, { recursive: true, force: true });
    }
  }
});

test('rejects a bundled server that still contains the removed administrator-token implementation', async () => {
  for (const legacySource of ['process.env.ADMIN_TOKEN', 'process.env.PERSIST_ADMIN_TOKEN', "'X-Admin-Token'", "'admin-token.txt'"]) {
    const value = await fixture();
    try {
      await writeFile(join(value.resources, 'server.mjs'), legacySource);
      await assert.rejects(createWindowsPortable({
        repositoryRoot: value.root,
        resources: value.resources,
        runtime: value.runtime,
        docsDirectory: value.docs,
        executable: value.executable,
        outputDirectory: value.output,
        lockPath: value.lock,
        archive: false,
      }), /removed administrator-token implementation/);
    } finally {
      await rm(value.root, { recursive: true, force: true });
    }
  }
});

test('rejects bundled server or Web resources containing removed sync contracts', async () => {
  const cases = [
    ['web/app.js', `const key = '${['zichan.sync.server', 'Profiles.v3'].join('')}';`, /removed sync configuration contract/],
    ['server.mjs', "const route = '/admin/status';", /removed \/admin management route/],
    ['server.mjs', "process.env.REGISTRATION_MODE ||= 'open';", /defaults registration to open/],
  ];
  for (const [relativePath, source, expected] of cases) {
    const value = await fixture();
    try {
      await writeFile(join(value.resources, ...relativePath.split('/')), source);
      await assert.rejects(createWindowsPortable({
        repositoryRoot: value.root,
        resources: value.resources,
        runtime: value.runtime,
        docsDirectory: value.docs,
        executable: value.executable,
        outputDirectory: value.output,
        lockPath: value.lock,
        archive: false,
      }), expected);
    } finally {
      await rm(value.root, { recursive: true, force: true });
    }
  }
});

test('detects files altered after manifest generation', async () => {
  const value = await fixture();
  try {
    const result = await createWindowsPortable({
      repositoryRoot: value.root,
      resources: value.resources,
      runtime: value.runtime,
      docsDirectory: value.docs,
      executable: value.executable,
      outputDirectory: value.output,
      lockPath: value.lock,
      archive: false,
    });
    await writeFile(join(result.directory, 'server', 'server.mjs'), 'altered');
    await assert.rejects(
      validatePortableDirectory(result.directory, { version: VERSION, runtimeVersion: RUNTIME_VERSION }),
      /hash mismatch/,
    );
  } finally {
    await rm(value.root, { recursive: true, force: true });
  }
});

test('refuses to replace any existing portable directory, preserving user data and other files', async () => {
  const value = await fixture();
  try {
    const options = {
      repositoryRoot: value.root,
      resources: value.resources,
      runtime: value.runtime,
      docsDirectory: value.docs,
      executable: value.executable,
      outputDirectory: value.output,
      lockPath: value.lock,
      archive: false,
    };
    const first = await createWindowsPortable(options);
    const database = join(first.directory, 'data', 'ledger', 'ledger.sqlite');
    const note = join(first.directory, 'personal-note.txt');
    await mkdir(join(first.directory, 'data', 'ledger'), { recursive: true });
    await writeFile(database, 'user ledger');
    await writeFile(note, 'keep this');

    await assert.rejects(
      createWindowsPortable(options),
      /Refusing to replace an existing portable directory/,
    );
    assert.equal(await readFile(database, 'utf8'), 'user ledger');
    assert.equal(await readFile(note, 'utf8'), 'keep this');
  } finally {
    await rm(value.root, { recursive: true, force: true });
  }
});

test('a failed compression leaves an existing ZIP and sidecar untouched', async () => {
  const value = await fixture();
  try {
    await mkdir(value.output, { recursive: true });
    const archive = join(value.output, `资产生命周期_${VERSION}_windows-x64_portable.zip`);
    await writeFile(archive, 'previous release');
    await writeFile(`${archive}.sha256`, 'previous sidecar');
    await assert.rejects(createWindowsPortable({
      repositoryRoot: value.root,
      resources: value.resources,
      runtime: value.runtime,
      docsDirectory: value.docs,
      executable: value.executable,
      outputDirectory: value.output,
      lockPath: value.lock,
      compress: async () => { throw new Error('compression failed'); },
    }), /compression failed/);
    assert.equal(await readFile(archive, 'utf8'), 'previous release');
    assert.equal(await readFile(`${archive}.sha256`, 'utf8'), 'previous sidecar');
  } finally {
    await rm(value.root, { recursive: true, force: true });
  }
});

test('a ZIP that fails content verification cannot replace an existing release', async () => {
  const value = await fixture();
  try {
    await mkdir(value.output, { recursive: true });
    const archive = join(value.output, `资产生命周期_${VERSION}_windows-x64_portable.zip`);
    await writeFile(archive, 'previous release');
    await writeFile(`${archive}.sha256`, 'previous sidecar');
    await assert.rejects(createWindowsPortable({
      repositoryRoot: value.root,
      resources: value.resources,
      runtime: value.runtime,
      docsDirectory: value.docs,
      executable: value.executable,
      outputDirectory: value.output,
      lockPath: value.lock,
      compress: async (_directory, destination) => writeFile(destination, 'invalid ZIP'),
    }), /content verification failed/);
    assert.equal(await readFile(archive, 'utf8'), 'previous release');
    assert.equal(await readFile(`${archive}.sha256`, 'utf8'), 'previous sidecar');
  } finally {
    await rm(value.root, { recursive: true, force: true });
  }
});

test('concurrent builds cannot share one output directory', async () => {
  const value = await fixture();
  let enterCompression;
  let releaseCompression;
  const compressionStarted = new Promise((resolvePromise) => { enterCompression = resolvePromise; });
  const compressionGate = new Promise((resolvePromise) => { releaseCompression = resolvePromise; });
  try {
    const options = {
      repositoryRoot: value.root,
      resources: value.resources,
      runtime: value.runtime,
      docsDirectory: value.docs,
      executable: value.executable,
      outputDirectory: value.output,
      lockPath: value.lock,
      compress: async () => {
        enterCompression();
        await compressionGate;
        throw new Error('first build stopped');
      },
    };
    const first = createWindowsPortable(options);
    await compressionStarted;
    await assert.rejects(createWindowsPortable(options), /Another portable build may be using/);
    releaseCompression();
    await assert.rejects(first, /first build stopped/);
  } finally {
    releaseCompression();
    await rm(value.root, { recursive: true, force: true });
  }
});

test('rejects x86 or arm64 binaries before labeling a package x64', async () => {
  const cases = [
    ['zichan.exe', 0x014c, /Desktop executable PE Machine/],
    ['resources/node.exe', 0xaa64, /Bundled Node\.js runtime PE Machine/],
    ['runtime/msedgewebview2.exe', 0xaa64, /Bundled WebView2 runtime PE Machine/],
  ];
  for (const [relativePath, machine, message] of cases) {
    const value = await fixture();
    try {
      const roots = { 'zichan.exe': value.executable, 'resources/node.exe': join(value.resources, 'node.exe'), 'runtime/msedgewebview2.exe': join(value.runtime, 'msedgewebview2.exe') };
      await writeFile(roots[relativePath], pe(machine));
      if (relativePath === 'runtime/msedgewebview2.exe') {
        const tree = await runtimeTreeDigest(value.runtime);
        const metadataPath = join(value.runtime, '.zichan-webview2-runtime.json');
        const metadata = JSON.parse(await readFile(metadataPath, 'utf8'));
        metadata.runtimeTreeSha256 = tree.sha256;
        metadata.runtimeFileCount = tree.fileCount;
        await writeFile(metadataPath, `${JSON.stringify(metadata)}\n`);
        const lock = JSON.parse(await readFile(value.lock, 'utf8'));
        lock.runtimeTreeSha256 = tree.sha256;
        await writeFile(value.lock, `${JSON.stringify(lock)}\n`);
      }
      await assert.rejects(createWindowsPortable({
        repositoryRoot: value.root,
        resources: value.resources,
        runtime: value.runtime,
        docsDirectory: value.docs,
        executable: value.executable,
        outputDirectory: value.output,
        lockPath: value.lock,
        archive: false,
      }), message);
    } finally {
      await rm(value.root, { recursive: true, force: true });
    }
  }
});

test('creates a ZIP with one portable top-level directory and a valid outer hash on Windows', { skip: process.platform !== 'win32' }, async () => {
  const value = await fixture();
  try {
    const result = await createWindowsPortable({
      repositoryRoot: value.root,
      resources: value.resources,
      runtime: value.runtime,
      docsDirectory: value.docs,
      executable: value.executable,
      outputDirectory: value.output,
      lockPath: value.lock,
    });
    assert.equal(result.directory, null);
    const verified = await verifyReleaseArtifacts({ artifact: result.archive, version: VERSION, runtimeVersion: RUNTIME_VERSION });
    assert.equal(verified.sha256, result.sha256);
    assert.equal(verified.contents.marker.appVersion, VERSION);
    const extracted = join(value.root, 'extracted');
    await mkdir(extracted);
    await expandPortableArchive(result.archive, extracted);
    const entries = await readdir(extracted);
    assert.deepEqual(entries, [`资产生命周期_${VERSION}_windows-x64_portable`]);
  } finally {
    await rm(value.root, { recursive: true, force: true });
  }
});

test('a verified ZIP can replace an older ZIP of the same version on Windows', { skip: process.platform !== 'win32' }, async () => {
  const value = await fixture();
  try {
    const options = {
      repositoryRoot: value.root,
      resources: value.resources,
      runtime: value.runtime,
      docsDirectory: value.docs,
      executable: value.executable,
      outputDirectory: value.output,
      lockPath: value.lock,
    };
    const first = await createWindowsPortable(options);
    await writeFile(join(value.resources, 'server.mjs'), 'updated server');
    const second = await createWindowsPortable(options);
    assert.notEqual(second.sha256, first.sha256);
    const verified = await verifyReleaseArtifacts({ artifact: second.archive, version: VERSION, runtimeVersion: RUNTIME_VERSION });
    assert.equal(verified.sha256, second.sha256);
  } finally {
    await rm(value.root, { recursive: true, force: true });
  }
});

test('rejects a ZIP with another top level, a missing required file, or content altered behind the manifest', { skip: process.platform !== 'win32' }, async () => {
  const value = await fixture();
  try {
    const result = await createWindowsPortable({
      repositoryRoot: value.root,
      resources: value.resources,
      runtime: value.runtime,
      docsDirectory: value.docs,
      executable: value.executable,
      outputDirectory: value.output,
      lockPath: value.lock,
    });
    const extracted = join(value.root, 'extracted');
    await mkdir(extracted);
    await expandPortableArchive(result.archive, extracted);
    const topLevel = `资产生命周期_${VERSION}_windows-x64_portable`;

    await writeFile(join(extracted, 'unexpected.txt'), 'extra top level');
    await rm(result.archive);
    await compressPortablePaths([join(extracted, topLevel), join(extracted, 'unexpected.txt')], result.archive);
    await rewriteOuterHash(result.archive);
    await assert.rejects(
      verifyReleaseArtifacts({ artifact: result.archive, version: VERSION, runtimeVersion: RUNTIME_VERSION }),
      /exactly one top-level directory/,
    );

    await rm(join(extracted, 'unexpected.txt'));
    await writeFile(join(extracted, topLevel, 'server', 'server.mjs'), 'tampered after manifest');
    await rm(result.archive);
    await compressPortablePaths([join(extracted, topLevel)], result.archive);
    await rewriteOuterHash(result.archive);
    await assert.rejects(
      verifyReleaseArtifacts({ artifact: result.archive, version: VERSION, runtimeVersion: RUNTIME_VERSION }),
      /Portable file hash mismatch: server\/server\.mjs/,
    );

    await rm(join(extracted, topLevel, 'server', 'server.mjs'));
    await rm(result.archive);
    await compressPortablePaths([join(extracted, topLevel)], result.archive);
    await rewriteOuterHash(result.archive);
    await assert.rejects(
      verifyReleaseArtifacts({ artifact: result.archive, version: VERSION, runtimeVersion: RUNTIME_VERSION }),
      /Portable package file server\/server\.mjs is missing/,
    );
  } finally {
    await rm(value.root, { recursive: true, force: true });
  }
});
