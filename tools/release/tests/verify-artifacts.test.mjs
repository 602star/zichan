import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { verifyReleaseArtifacts } from '../../../scripts/release/verify-artifacts.mjs';

async function fixture(version = '1.2.3') {
  const root = await mkdtemp(join(tmpdir(), 'zichan-portable-artifact-'));
  const name = `资产生命周期_${version}_windows-x64_portable.zip`;
  const artifact = join(root, name);
  const bytes = Buffer.from('fixture portable zip bytes');
  const hash = createHash('sha256').update(bytes).digest('hex');
  await writeFile(artifact, bytes);
  await writeFile(`${artifact}.sha256`, `${hash}  ${name}\n`);
  return { root, artifact, hash, bytes };
}

test('accepts an exact portable name and matching SHA-256 sidecar', async () => {
  const value = await fixture();
  try {
    const result = await verifyReleaseArtifacts({ artifact: value.artifact, version: '1.2.3', skipContents: true });
    assert.equal(result.bytes, value.bytes.length);
    assert.equal(result.sha256, value.hash);
  } finally {
    await rm(value.root, { recursive: true, force: true });
  }
});

test('rejects a renamed portable artifact and sidecar pointing at another file', async () => {
  const value = await fixture('1.2.4');
  try {
    await writeFile(`${value.artifact}.sha256`, `${value.hash}  another.zip\n`);
    await assert.rejects(
      verifyReleaseArtifacts({ artifact: value.artifact, version: '1.2.3', skipContents: true }),
      (error) => {
        assert.match(error.message, /must be named 资产生命周期_1\.2\.3_windows-x64_portable\.zip/);
        assert.match(error.message, /sidecar references another\.zip/);
        return true;
      },
    );
  } finally {
    await rm(value.root, { recursive: true, force: true });
  }
});

test('rejects an altered ZIP and malformed sidecar', async () => {
  const value = await fixture();
  try {
    await writeFile(value.artifact, 'changed');
    await assert.rejects(verifyReleaseArtifacts({ artifact: value.artifact, version: '1.2.3', skipContents: true }), /SHA-256 mismatch/);
    await writeFile(`${value.artifact}.sha256`, 'not-a-sidecar\n');
    await assert.rejects(verifyReleaseArtifacts({ artifact: value.artifact, version: '1.2.3', skipContents: true }), /64 hex/);
  } finally {
    await rm(value.root, { recursive: true, force: true });
  }
});
