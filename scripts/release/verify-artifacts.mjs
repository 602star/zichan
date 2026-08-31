import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { mkdtemp, open, readFile, readdir, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { validatePortableDirectory } from './create-windows-portable.mjs';
import { readWebView2RuntimeLock } from './webview2-runtime.mjs';

const scriptPath = fileURLToPath(import.meta.url);
const repositoryRoot = resolve(dirname(scriptPath), '..', '..');

async function sha256(path) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest('hex');
}

async function zipEntries(path) {
  const handle = await open(path, 'r');
  try {
    const info = await handle.stat();
    const tailSize = Math.min(info.size, 65_557);
    const tail = Buffer.alloc(tailSize);
    await handle.read(tail, 0, tail.length, info.size - tailSize);
    let endOffset = -1;
    for (let offset = tail.length - 22; offset >= 0; offset -= 1) {
      if (tail.readUInt32LE(offset) === 0x06054b50) {
        endOffset = offset;
        break;
      }
    }
    if (endOffset < 0) throw new Error('ZIP end-of-central-directory record is missing');
    const disk = tail.readUInt16LE(endOffset + 4);
    const centralDisk = tail.readUInt16LE(endOffset + 6);
    const diskEntries = tail.readUInt16LE(endOffset + 8);
    const totalEntries = tail.readUInt16LE(endOffset + 10);
    const centralSize = tail.readUInt32LE(endOffset + 12);
    const centralOffset = tail.readUInt32LE(endOffset + 16);
    if (disk !== 0 || centralDisk !== 0 || diskEntries !== totalEntries) throw new Error('multi-disk ZIP files are not supported');
    if (totalEntries === 0xffff || centralSize === 0xffffffff || centralOffset === 0xffffffff) throw new Error('ZIP64 portable artifacts are not supported');
    if (totalEntries > 10_000) throw new Error(`portable ZIP contains too many entries: ${totalEntries}`);
    if (centralSize > 64 * 1024 * 1024 || centralOffset + centralSize > info.size) throw new Error('ZIP central directory bounds are invalid');
    const central = Buffer.alloc(centralSize);
    await handle.read(central, 0, central.length, centralOffset);
    const entries = [];
    let totalUncompressedBytes = 0;
    let offset = 0;
    for (let index = 0; index < totalEntries; index += 1) {
      if (offset + 46 > central.length || central.readUInt32LE(offset) !== 0x02014b50) throw new Error(`ZIP central directory entry ${index} is invalid`);
      const flags = central.readUInt16LE(offset + 8);
      if ((flags & 0x0001) !== 0) throw new Error('encrypted ZIP entries are not supported');
      const uncompressedBytes = central.readUInt32LE(offset + 24);
      if (uncompressedBytes === 0xffffffff) throw new Error('ZIP64 portable entries are not supported');
      totalUncompressedBytes += uncompressedBytes;
      if (totalUncompressedBytes > 2 * 1024 * 1024 * 1024) throw new Error('portable ZIP expands beyond the 2 GiB verification limit');
      const nameLength = central.readUInt16LE(offset + 28);
      const extraLength = central.readUInt16LE(offset + 30);
      const commentLength = central.readUInt16LE(offset + 32);
      const end = offset + 46 + nameLength + extraLength + commentLength;
      if (end > central.length) throw new Error(`ZIP central directory entry ${index} exceeds its bounds`);
      const name = central.subarray(offset + 46, offset + 46 + nameLength).toString('utf8').replaceAll('\\', '/');
      entries.push(name);
      offset = end;
    }
    if (offset !== central.length) throw new Error('ZIP central directory contains trailing or unparsed data');
    return entries;
  } finally {
    await handle.close();
  }
}

function validateZipEntryNames(entries, expectedTopLevel) {
  if (entries.length === 0) throw new Error('portable ZIP contains no entries');
  const seen = new Set();
  for (const name of entries) {
    if (!name || name.startsWith('/') || name.startsWith('//') || /^[a-z]:/i.test(name)) throw new Error(`portable ZIP contains an absolute entry path: ${name}`);
    const parts = name.split('/').filter((part, index, all) => part || index === all.length - 1);
    if (parts.some((part) => part === '.' || part === '..')) throw new Error(`portable ZIP contains path traversal: ${name}`);
    if (parts[0] !== expectedTopLevel) throw new Error(`portable ZIP must contain exactly one top-level directory named ${expectedTopLevel}; found ${parts[0] || name}`);
    const key = name.toLowerCase();
    if (seen.has(key)) throw new Error(`portable ZIP contains duplicate Windows path: ${name}`);
    seen.add(key);
  }
}

function expandArchive(archive, destination) {
  if (process.platform !== 'win32') throw new Error('Windows portable ZIP content verification must run on Windows.');
  const command = [
    '$ErrorActionPreference = "Stop"',
    'Import-Module (Join-Path $env:SystemRoot "System32\\WindowsPowerShell\\v1.0\\Modules\\Microsoft.PowerShell.Archive\\Microsoft.PowerShell.Archive.psd1") -ErrorAction Stop',
    'Expand-Archive -LiteralPath $env:ZICHAN_PORTABLE_ARCHIVE -DestinationPath $env:ZICHAN_PORTABLE_VERIFY_DIR -Force',
  ].join('; ');
  const powershell = join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  return new Promise((resolvePromise, reject) => {
    const child = spawn(powershell, ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', command], {
      stdio: 'inherit',
      windowsHide: true,
      env: {
        ...process.env,
        ZICHAN_PORTABLE_ARCHIVE: archive,
        ZICHAN_PORTABLE_VERIFY_DIR: destination,
      },
    });
    child.once('error', reject);
    child.once('exit', (code, signal) => {
      if (code === 0) resolvePromise();
      else reject(new Error(`Expand-Archive failed with ${signal ? `signal ${signal}` : `exit code ${code}`}`));
    });
  });
}

async function verifyPortableZipContents(artifact, expected) {
  const topLevel = `资产生命周期_${expected.version}_windows-x64_portable`;
  validateZipEntryNames(await zipEntries(artifact), topLevel);
  const temporary = await mkdtemp(join(tmpdir(), 'zichan-portable-verify-'));
  try {
    await expandArchive(artifact, temporary);
    const topEntries = await readdir(temporary, { withFileTypes: true });
    if (topEntries.length !== 1 || topEntries[0].name !== topLevel || !topEntries[0].isDirectory()) {
      throw new Error(`portable ZIP extraction must contain exactly the ${topLevel} directory`);
    }
    return await validatePortableDirectory(join(temporary, topLevel), expected);
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
}

export async function verifyReleaseArtifacts(options) {
  const artifact = resolve(options.artifact);
  const sidecar = resolve(options.sha256File ?? `${artifact}.sha256`);
  const version = options.version;
  const expectedName = `资产生命周期_${version}_windows-x64_portable.zip`;
  const failures = [];
  const fileName = basename(artifact);
  if (fileName !== expectedName) failures.push(`portable ZIP must be named ${expectedName}, received ${fileName}`);

  let bytes = 0;
  try {
    const info = await stat(artifact);
    if (!info.isFile()) failures.push('portable artifact is not a regular file');
    bytes = info.size;
    if (bytes === 0) failures.push('portable ZIP is empty');
  } catch (error) {
    failures.push(`portable ZIP is missing or unreadable: ${error.message}`);
  }

  let expectedHash = '';
  try {
    const line = (await readFile(sidecar, 'utf8')).trim();
    const match = line.match(/^([a-f0-9]{64}) {2}(.+)$/i);
    if (!match) failures.push('SHA-256 sidecar must use "<64 hex>  <file name>" format');
    else {
      expectedHash = match[1].toLowerCase();
      if (match[2] !== fileName) failures.push(`SHA-256 sidecar references ${match[2]}, expected ${fileName}`);
    }
  } catch (error) {
    failures.push(`SHA-256 sidecar is missing or unreadable: ${error.message}`);
  }

  let actualHash = '';
  if (bytes > 0) {
    actualHash = await sha256(artifact);
    if (expectedHash && actualHash !== expectedHash) failures.push(`portable ZIP SHA-256 mismatch: expected ${expectedHash}, received ${actualHash}`);
  }

  let contents = null;
  if (failures.length === 0 && options.skipContents !== true) {
    try {
      const runtimeVersion = options.runtimeVersion
        ?? (await readWebView2RuntimeLock(options.lockPath ?? join(repositoryRoot, 'scripts', 'release', 'webview2-runtime.lock.json'))).runtimeVersion;
      contents = await verifyPortableZipContents(artifact, { version, runtimeVersion });
    } catch (error) {
      failures.push(`portable ZIP content verification failed: ${error.message}`);
    }
  }

  if (failures.length) throw new Error(`Portable artifact verification failed:\n- ${[...new Set(failures)].join('\n- ')}`);
  return { artifact, bytes, sha256: actualHash, contents };
}

function parseArgs(argv) {
  const result = {};
  for (let index = 0; index < argv.length; index += 2) {
    const key = argv[index];
    const value = argv[index + 1];
    if (!key?.startsWith('--') || !value) throw new Error(`Invalid argument near ${key ?? 'end'}`);
    result[key.slice(2)] = value;
  }
  for (const required of ['artifact', 'version']) {
    if (!result[required]) throw new Error(`Missing --${required}`);
  }
  return result;
}

if (process.argv[1] && resolve(process.argv[1]) === scriptPath) {
  const args = parseArgs(process.argv.slice(2));
  const result = await verifyReleaseArtifacts({
    artifact: args.artifact,
    sha256File: args.sha256,
    version: args.version,
    runtimeVersion: args['runtime-version'],
  });
  console.log(`portable artifact ok: bytes=${result.bytes} sha256=${result.sha256}`);
}
