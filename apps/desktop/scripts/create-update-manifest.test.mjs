import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { createUpdateManifest, parseManifestArgs } from './create-update-manifest.mjs';

test('parses strict key/value manifest arguments', () => {
  assert.deepEqual(parseManifestArgs([
    '--bundle-dir', 'bundle',
    '--output', 'latest.json',
    '--tag', 'v1.2.3',
    '--repository', 'owner/repo',
    '--version', '1.2.3',
  ]), {
    'bundle-dir': 'bundle',
    output: 'latest.json',
    tag: 'v1.2.3',
    repository: 'owner/repo',
    version: '1.2.3',
  });
});

test('creates installer-specific and fallback entries from signed updater artifacts', async () => {
  const root = await mkdtemp(join(tmpdir(), 'zichan-updater-'));
  try {
    const nsis = join(root, 'nsis');
    const msi = join(root, 'msi');
    await mkdir(nsis);
    await mkdir(msi);
    const nsisName = 'Zichan_1.2.3_x64-setup.nsis.zip';
    const msiName = 'Zichan_1.2.3_x64_en-US.msi.zip';
    await writeFile(join(nsis, nsisName), 'nsis');
    await writeFile(join(nsis, `${nsisName}.sig`), 'NSIS-SIGNATURE\n');
    await writeFile(join(msi, msiName), 'msi');
    await writeFile(join(msi, `${msiName}.sig`), 'MSI-SIGNATURE\n');
    const notesPath = join(root, 'notes.md');
    await writeFile(notesPath, 'Fixed ledger correctness.');

    const result = await createUpdateManifest({
      'bundle-dir': root,
      output: join(root, 'latest.json'),
      tag: 'v1.2.3',
      repository: 'owner/ledger',
      version: '1.2.3',
      'notes-file': notesPath,
      'pub-date': '2026-07-23T00:00:00Z',
    });
    assert.equal(result.version, '1.2.3');
    assert.equal(result.notes, 'Fixed ledger correctness.');
    assert.equal(result.platforms['windows-x86_64-nsis'].signature, 'NSIS-SIGNATURE');
    assert.equal(result.platforms['windows-x86_64-msi'].signature, 'MSI-SIGNATURE');
    assert.equal(result.platforms['windows-x86_64'].signature, 'NSIS-SIGNATURE');
    assert.match(result.platforms['windows-x86_64'].url, /releases\/download\/v1.2.3\//);
    await readFile(join(nsis, `${nsisName}.sig`));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
