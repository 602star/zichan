import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { verifyReleaseArtifacts } from './verify-artifacts.mjs';

async function fixture(version = '1.2.3') {
  const root = await mkdtemp(join(tmpdir(), 'zichan-release-artifacts-'));
  const msiDirectory = join(root, 'msi');
  const nsisDirectory = join(root, 'nsis');
  await mkdir(msiDirectory);
  await mkdir(nsisDirectory);
  const msi = `Zichan_${version}_x64_en-US.msi`;
  const nsis = `Zichan_${version}_x64-setup.exe`;
  const updater = `Zichan_${version}_x64-setup.nsis.zip`;
  await writeFile(join(msiDirectory, msi), 'installer');
  await writeFile(join(nsisDirectory, nsis), 'installer');
  await writeFile(join(nsisDirectory, updater), 'archive');
  await writeFile(join(nsisDirectory, `${updater}.sig`), 'signed-value\n');
  const manifest = join(root, 'latest.json');
  await writeFile(manifest, `${JSON.stringify({
    version,
    notes: 'Release notes.',
    platforms: {
      'windows-x86_64': {
        signature: 'signed-value',
        url: `https://github.com/owner/repo/releases/download/v${version}/${updater}`,
      },
    },
  }, null, 2)}\n`);
  return { root, manifest };
}

test('accepts structurally matching installer, manifest, tag, and detached signature files', async () => {
  const value = await fixture();
  try {
    const result = await verifyReleaseArtifacts({ bundleDir: value.root, manifest: value.manifest, version: '1.2.3', tag: 'v1.2.3' });
    assert.deepEqual(result, { installerCount: 2, updaterCount: 1, platformCount: 1 });
  } finally {
    await rm(value.root, { recursive: true, force: true });
  }
});

test('rejects a manifest signature that differs from its detached signature file', async () => {
  const value = await fixture();
  try {
    const manifest = JSON.parse(await readFile(value.manifest, 'utf8'));
    manifest.platforms['windows-x86_64'].signature = 'another-signature';
    await writeFile(value.manifest, `${JSON.stringify(manifest, null, 2)}\n`);
    await assert.rejects(
      verifyReleaseArtifacts({ bundleDir: value.root, manifest: value.manifest, version: '1.2.3', tag: 'v1.2.3' }),
      /manifest signature does not match/,
    );
  } finally {
    await rm(value.root, { recursive: true, force: true });
  }
});

test('rejects version drift and a manifest pointing at another release tag', async () => {
  const value = await fixture('1.2.4');
  try {
    await assert.rejects(
      verifyReleaseArtifacts({ bundleDir: value.root, manifest: value.manifest, version: '1.2.3', tag: 'v1.2.3' }),
      (error) => {
        assert.match(error.message, /does not contain release version 1\.2\.3/);
        assert.match(error.message, /manifest version is 1\.2\.4/);
        assert.match(error.message, /manifest URL does not target v1\.2\.3/);
        return true;
      },
    );
  } finally {
    await rm(value.root, { recursive: true, force: true });
  }
});
