import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

export const PINNED_WEBVIEW2_VERSION = '151.0.4129.101';
export const PINNED_WEBVIEW2_ARCHITECTURE = 'x64';

const SHA256 = /^[a-f0-9]{64}$/i;

function isOfficialMicrosoftDownload(value) {
  try {
    const url = new URL(value);
    const host = url.hostname.toLowerCase();
    return url.protocol === 'https:'
      && (host === 'microsoft.com' || host.endsWith('.microsoft.com') || host === 'aka.ms');
  } catch {
    return false;
  }
}

export function validateWebView2RuntimeLock(lock, options = {}) {
  const failures = [];
  if (!lock || typeof lock !== 'object' || Array.isArray(lock)) {
    throw new Error('WebView2 runtime lock must be a JSON object.');
  }
  if (lock.schemaVersion !== 1) failures.push(`schemaVersion must be 1, received ${String(lock.schemaVersion)}`);
  if (lock.runtimeVersion !== PINNED_WEBVIEW2_VERSION) {
    failures.push(`runtimeVersion must be ${PINNED_WEBVIEW2_VERSION}, received ${String(lock.runtimeVersion)}`);
  }
  if (lock.architecture !== PINNED_WEBVIEW2_ARCHITECTURE) {
    failures.push(`architecture must be ${PINNED_WEBVIEW2_ARCHITECTURE}, received ${String(lock.architecture)}`);
  }
  if (typeof lock.sourcePage !== 'string' || !lock.sourcePage.startsWith('https://developer.microsoft.com/')) {
    failures.push('sourcePage must point to the official Microsoft WebView2 download page');
  }

  const hasUrl = typeof lock.downloadUrl === 'string' && lock.downloadUrl.length > 0;
  const hasHash = typeof lock.sha256 === 'string' && lock.sha256.length > 0;
  if (hasUrl !== hasHash) failures.push('downloadUrl and sha256 must either both be filled or both be null');
  if (hasUrl && !isOfficialMicrosoftDownload(lock.downloadUrl)) {
    failures.push('downloadUrl must be an official HTTPS Microsoft download URL');
  }
  if (hasHash && !SHA256.test(lock.sha256)) failures.push('sha256 must contain exactly 64 hexadecimal characters');
  if (typeof lock.runtimeTreeSha256 !== 'string' || !SHA256.test(lock.runtimeTreeSha256)) {
    failures.push('runtimeTreeSha256 must contain exactly 64 hexadecimal characters');
  }
  if (options.requireDownload === true && (!hasUrl || !hasHash)) {
    failures.push('downloadUrl and sha256 are pending maintainer verification; fill both from the official Microsoft download before preparing or packaging a release');
  }

  if (failures.length) throw new Error(`Invalid WebView2 runtime lock:\n- ${failures.join('\n- ')}`);
  return {
    ...lock,
    complete: hasUrl && hasHash,
    sha256: hasHash ? lock.sha256.toLowerCase() : null,
  };
}

export async function readWebView2RuntimeLock(path, options = {}) {
  const absolutePath = resolve(path);
  let parsed;
  try {
    parsed = JSON.parse(await readFile(absolutePath, 'utf8'));
  } catch (error) {
    throw new Error(`Cannot read WebView2 runtime lock at ${absolutePath}: ${error.message}`);
  }
  return validateWebView2RuntimeLock(parsed, options);
}
