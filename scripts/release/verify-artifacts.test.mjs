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
  const msiUpdater = `Zichan_${version}_x64_en-US.msi.zip`;
  const nsisUpdater = `Zichan_${version}_x64-setup.nsis.zip`;
  await writeFile(join(msiDirectory, msi), 'installer');
  await writeFile(join(nsisDirectory, nsis), 'installer');
  await writeFile(join(msiDirectory, msiUpdater), 'msi archive');
  await writeFile(join(msiDirectory, `${msiUpdater}.sig`), 'msi-signed-value\n');
  await writeFile(join(nsisDirectory, nsisUpdater), 'nsis archive');
  await writeFile(join(nsisDirectory, `${nsisUpdater}.sig`), 'nsis-signed-value\n');
  const manifest = join(root, 'latest.json');
  await writeFile(manifest, `${JSON.stringify({
    version,
    notes: 'Release notes.',
    platforms: {
      'windows-x86_64-msi': {
        signature: 'msi-signed-value',
        url: `https://github.com/owner/repo/releases/download/v${version}/${msiUpdater}`,
      },
      'windows-x86_64-nsis': {
        signature: 'nsis-signed-value',
        url: `https://github.com/owner/repo/releases/download/v${version}/${nsisUpdater}`,
      },
      'windows-x86_64': {
        signature: 'nsis-signed-value',
        url: `https://github.com/owner/repo/releases/download/v${version}/${nsisUpdater}`,
      },
    },
  }, null, 2)}\n`);
  return { root, manifest };
}

test('accepts structurally matching installer, manifest, tag, and detached signature files', async () => {
  const value = await fixture();
  try {
    const result = await verifyReleaseArtifacts({ bundleDir: value.root, manifest: value.manifest, version: '1.2.3', tag: 'v1.2.3' });
    assert.deepEqual(result, { installerCount: 2, updaterCount: 2, platformCount: 3 });
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

test('rejects releases missing either Windows updater format', async () => {
  const cases = [
    ['msi', 'Zichan_1.2.3_x64_en-US.msi.zip', /MSI updater archive is missing/],
    ['nsis', 'Zichan_1.2.3_x64-setup.nsis.zip', /NSIS updater archive is missing/],
  ];
  for (const [directory, archive, message] of cases) {
    const value = await fixture();
    try {
      await rm(join(value.root, directory, archive));
      await rm(join(value.root, directory, `${archive}.sig`));
      await assert.rejects(
        verifyReleaseArtifacts({ bundleDir: value.root, manifest: value.manifest, version: '1.2.3', tag: 'v1.2.3' }),
        message,
      );
    } finally {
      await rm(value.root, { recursive: true, force: true });
    }
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
