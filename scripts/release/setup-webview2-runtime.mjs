import { createHash } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { access, cp, lstat, mkdir, readFile, readdir, rename, rm, stat, writeFile } from 'node:fs/promises';
import { constants } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { pipeline } from 'node:stream/promises';
import { Readable } from 'node:stream';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { readWebView2RuntimeLock } from './webview2-runtime.mjs';

const scriptPath = fileURLToPath(import.meta.url);
const repositoryRoot = resolve(dirname(scriptPath), '..', '..');
const defaultLockPath = join(repositoryRoot, 'scripts', 'release', 'webview2-runtime.lock.json');

async function exists(path) {
  try {
    await access(path, constants.R_OK);
    return true;
  } catch {
    return false;
  }
}

async function sha256(path) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest('hex');
}

export async function runtimeTreeDigest(directory) {
  const root = resolve(directory);
  const files = [];
  async function visit(current, prefix) {
    for (const entry of await readdir(current, { withFileTypes: true })) {
      const path = join(current, entry.name);
      const relativePath = prefix ? `${prefix}/${entry.name}` : entry.name;
      const info = await lstat(path);
      if (info.isSymbolicLink()) throw new Error(`WebView2 runtime contains a symbolic link: ${relativePath}`);
      if (info.isDirectory()) await visit(path, relativePath);
      else if (info.isFile() && relativePath !== '.zichan-webview2-runtime.json') files.push({ path, relativePath });
      else if (!info.isFile()) throw new Error(`WebView2 runtime contains an unsupported filesystem entry: ${relativePath}`);
    }
  }
  await visit(root, '');
  files.sort((a, b) => a.relativePath.localeCompare(b.relativePath, 'en'));
  const manifestHash = createHash('sha256');
  for (const file of files) manifestHash.update(`${await sha256(file.path)}  ${file.relativePath}\n`, 'utf8');
  return { sha256: manifestHash.digest('hex'), fileCount: files.length };
}

async function download(url, destination) {
  const response = await fetch(url, { redirect: 'follow' });
  if (!response.ok || !response.body) throw new Error(`Microsoft download returned HTTP ${response.status}`);
  await mkdir(dirname(destination), { recursive: true });
  const partial = `${destination}.partial-${process.pid}`;
  try {
    await pipeline(Readable.fromWeb(response.body), createWriteStream(partial, { flags: 'wx' }));
    await rename(partial, destination);
  } finally {
    await rm(partial, { force: true });
  }
}

function run(command, args) {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(command, args, { stdio: 'inherit', windowsHide: true });
    child.once('error', reject);
    child.once('exit', (code, signal) => {
      if (code === 0) resolvePromise();
      else reject(new Error(`${command} failed with ${signal ? `signal ${signal}` : `exit code ${code}`}`));
    });
  });
}

async function findRuntimeRoot(directory) {
  const matches = [];
  async function visit(current, depth) {
    if (depth > 3) return;
    if (await exists(join(current, 'msedgewebview2.exe'))) matches.push(current);
    for (const entry of await readdir(current, { withFileTypes: true })) {
      if (entry.isDirectory()) await visit(join(current, entry.name), depth + 1);
    }
  }
  await visit(directory, 0);
  if (matches.length !== 1) throw new Error(`Expected one extracted WebView2 runtime root, found ${matches.length}`);
  return matches[0];
}

export async function verifyPreparedRuntime(directory, lock) {
  const required = ['msedgewebview2.exe', 'msedge.dll', 'icudtl.dat', '.zichan-webview2-runtime.json'];
  for (const file of required) {
    const path = join(directory, file);
    if (!await exists(path) || !(await stat(path)).isFile()) throw new Error(`Prepared WebView2 runtime is missing ${file}: ${directory}`);
  }
  const metadata = JSON.parse(await readFile(join(directory, '.zichan-webview2-runtime.json'), 'utf8'));
  const tree = await runtimeTreeDigest(directory);
  if (metadata.runtimeVersion !== lock.runtimeVersion
    || metadata.architecture !== lock.architecture
    || metadata.cabSha256 !== lock.sha256
    || metadata.runtimeTreeSha256 !== lock.runtimeTreeSha256
    || metadata.runtimeFileCount !== tree.fileCount) {
    throw new Error('Prepared WebView2 runtime metadata does not match the locked version, architecture, CAB hash, and runtime tree.');
  }
  if (tree.sha256 !== lock.runtimeTreeSha256) {
    throw new Error(`Prepared WebView2 runtime tree SHA-256 mismatch: expected ${lock.runtimeTreeSha256}, received ${tree.sha256}`);
  }
  return { directory, metadata, tree };
}

export async function prepareWebView2Runtime(options = {}) {
  if (process.platform !== 'win32') throw new Error('WebView2 Fixed Version preparation is supported only on Windows.');
  const root = resolve(options.repositoryRoot ?? repositoryRoot);
  const lockPath = resolve(options.lockPath ?? join(root, 'scripts', 'release', 'webview2-runtime.lock.json'));
  const lock = await readWebView2RuntimeLock(lockPath, { requireDownload: true });
  const runtimeDirectory = resolve(options.runtimeDirectory ?? join(root, '.tools', 'webview2-fixed', lock.runtimeVersion, lock.architecture));

  if (options.check === true) return verifyPreparedRuntime(runtimeDirectory, lock);
  if (options.force !== true && await exists(join(runtimeDirectory, '.zichan-webview2-runtime.json'))) {
    return verifyPreparedRuntime(runtimeDirectory, lock);
  }

  const downloadDirectory = join(root, '.tools', 'webview2-fixed', lock.runtimeVersion);
  const cabPath = options.cab
    ? resolve(options.cab)
    : join(downloadDirectory, `Microsoft.WebView2.FixedVersionRuntime.${lock.runtimeVersion}.${lock.architecture}.cab`);
  if (!options.cab && !await exists(cabPath)) await download(lock.downloadUrl, cabPath);
  if (!await exists(cabPath)) throw new Error(`WebView2 CAB does not exist: ${cabPath}`);
  const actualHash = await sha256(cabPath);
  if (actualHash !== lock.sha256) {
    throw new Error(`WebView2 CAB SHA-256 mismatch: expected ${lock.sha256}, received ${actualHash}`);
  }

  const staging = join(root, '.tools', 'webview2-fixed', `.extract-${process.pid}`);
  const normalized = `${runtimeDirectory}.staging-${process.pid}`;
  await rm(staging, { recursive: true, force: true });
  await rm(normalized, { recursive: true, force: true });
  await mkdir(staging, { recursive: true });
  try {
    await run('expand.exe', [cabPath, '-F:*', staging]);
    const extractedRoot = await findRuntimeRoot(staging);
    await cp(extractedRoot, normalized, { recursive: true, errorOnExist: true });
    const tree = await runtimeTreeDigest(normalized);
    if (tree.sha256 !== lock.runtimeTreeSha256) {
      throw new Error(`Extracted WebView2 runtime tree SHA-256 mismatch: expected ${lock.runtimeTreeSha256}, received ${tree.sha256}`);
    }
    await writeFile(join(normalized, '.zichan-webview2-runtime.json'), `${JSON.stringify({
      schemaVersion: 1,
      runtimeVersion: lock.runtimeVersion,
      architecture: lock.architecture,
      cabSha256: lock.sha256,
      runtimeTreeSha256: tree.sha256,
      runtimeFileCount: tree.fileCount,
      source: lock.sourcePage,
    }, null, 2)}\n`, 'utf8');
    await verifyPreparedRuntime(normalized, lock);
    await rm(runtimeDirectory, { recursive: true, force: true });
    await mkdir(dirname(runtimeDirectory), { recursive: true });
    await rename(normalized, runtimeDirectory);
  } finally {
    await rm(staging, { recursive: true, force: true });
    await rm(normalized, { recursive: true, force: true });
  }
  return verifyPreparedRuntime(runtimeDirectory, lock);
}

function parseArgs(argv) {
  const options = {};
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === '--force' || argument === '--check') {
      options[argument.slice(2)] = true;
      continue;
    }
    if (argument === '--cab' || argument === '--root' || argument === '--lock' || argument === '--runtime-dir') {
      const value = argv[index + 1];
      if (!value) throw new Error(`Missing value for ${argument}`);
      const key = argument === '--root' ? 'repositoryRoot' : argument === '--lock' ? 'lockPath' : argument === '--runtime-dir' ? 'runtimeDirectory' : 'cab';
      options[key] = value;
      index += 1;
      continue;
    }
    throw new Error(`Unknown argument: ${argument}`);
  }
  return options;
}

if (process.argv[1] && resolve(process.argv[1]) === scriptPath) {
  const result = await prepareWebView2Runtime(parseArgs(process.argv.slice(2)));
  console.log(`WebView2 Fixed Version ready: ${result.directory}`);
}
