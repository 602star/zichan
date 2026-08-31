import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import {
  PINNED_WEBVIEW2_ARCHITECTURE,
  PINNED_WEBVIEW2_VERSION,
  validateWebView2RuntimeLock,
} from '../../../scripts/release/webview2-runtime.mjs';
import { runtimeTreeDigest, verifyPreparedRuntime } from '../../../scripts/release/setup-webview2-runtime.mjs';

function completeLock() {
  return {
    schemaVersion: 1,
    runtimeVersion: PINNED_WEBVIEW2_VERSION,
    architecture: PINNED_WEBVIEW2_ARCHITECTURE,
    downloadUrl: `https://download.microsoft.com/webview2-${PINNED_WEBVIEW2_VERSION}.cab`,
    sha256: 'a'.repeat(64),
    runtimeTreeSha256: 'b'.repeat(64),
    sourcePage: 'https://developer.microsoft.com/en-us/microsoft-edge/webview2/',
  };
}

test('accepts a complete pinned Microsoft x64 runtime lock', () => {
  const lock = validateWebView2RuntimeLock(completeLock(), { requireDownload: true });
  assert.equal(lock.complete, true);
  assert.equal(lock.runtimeVersion, PINNED_WEBVIEW2_VERSION);
});

test('allows an explicitly pending URL and hash only for repository metadata checks', () => {
  const lock = completeLock();
  lock.downloadUrl = null;
  lock.sha256 = null;
  assert.equal(validateWebView2RuntimeLock(lock).complete, false);
  assert.throws(() => validateWebView2RuntimeLock(lock, { requireDownload: true }), /pending maintainer verification/);
});

test('rejects version drift, non-Microsoft downloads, partial locks, and malformed hashes', () => {
  assert.throws(() => validateWebView2RuntimeLock({ ...completeLock(), runtimeVersion: '999.0.0.0' }), /runtimeVersion must be/);
  assert.throws(() => validateWebView2RuntimeLock({ ...completeLock(), downloadUrl: 'https://example.com/runtime.cab' }), /official HTTPS Microsoft/);
  assert.throws(() => validateWebView2RuntimeLock({ ...completeLock(), sha256: null }), /must either both be filled/);
  assert.throws(() => validateWebView2RuntimeLock({ ...completeLock(), sha256: 'abc' }), /64 hexadecimal/);
});

test('detects a prepared runtime file changed after extraction even if metadata remains present', async () => {
  const root = await mkdtemp(join(tmpdir(), 'zichan-webview2-integrity-'));
  try {
    await writeFile(join(root, 'msedgewebview2.exe'), 'exe');
    await writeFile(join(root, 'msedge.dll'), 'dll');
    await writeFile(join(root, 'icudtl.dat'), 'data');
    const tree = await runtimeTreeDigest(root);
    const lock = { ...completeLock(), runtimeTreeSha256: tree.sha256 };
    await writeFile(join(root, '.zichan-webview2-runtime.json'), `${JSON.stringify({
      runtimeVersion: lock.runtimeVersion,
      architecture: lock.architecture,
      cabSha256: lock.sha256,
      runtimeTreeSha256: tree.sha256,
      runtimeFileCount: tree.fileCount,
    })}\n`);
    await verifyPreparedRuntime(root, lock);
    await writeFile(join(root, 'msedge.dll'), 'tampered');
    await assert.rejects(verifyPreparedRuntime(root, lock), /runtime tree SHA-256 mismatch/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
