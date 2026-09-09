import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { access, cp, lstat, mkdir, open, readFile, readdir, rename, rm, stat, writeFile } from 'node:fs/promises';
import { constants } from 'node:fs';
import { basename, dirname, join, relative, resolve, sep } from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { readWebView2RuntimeLock } from './webview2-runtime.mjs';
import { verifyPreparedRuntime } from './setup-webview2-runtime.mjs';

const scriptPath = fileURLToPath(import.meta.url);
const defaultRepositoryRoot = resolve(dirname(scriptPath), '..', '..');
const FORBIDDEN_NAMES = new Set([
  '.env',
  '.env.local',
  '.npmrc',
  'admin-token.txt',
  'credentials.json',
  'opaque.server-setup',
  'secrets.json',
  'server-id',
  'server.pid',
  'server.secret',
  'stronghold-salt.txt',
  'sync-vault.hold',
  'latest.json',
  'update-state.json',
]);
const FORBIDDEN_DIRECTORIES = new Set(['data', 'node_modules', '.git', '.runtime', '.tools']);
const FORBIDDEN_SUFFIXES = [
  '.pdb',
  '.map',
  '.zcbak',
  '.hold',
  '.sqlite',
  '.sqlite-wal',
  '.sqlite-shm',
  '.db',
  '.db-wal',
  '.db-shm',
  '.jks',
  '.kdbx',
  '.key',
  '.keystore',
  '.nsis.zip',
  '.p12',
  '.p8',
  '.pem',
  '.pfx',
  '.msi.zip',
];
const LEGACY_ADMIN_TOKEN_PATTERN = /\b(?:ADMIN_TOKEN|PERSIST_ADMIN_TOKEN|X-Admin-Token)\b|admin-token\.txt/i;
const LEGACY_SYNC_CONFIGURATION_PATTERN = /zichan\.sync\.(?:serverProfiles|sessionCredentials)\.v3|\bSyncServerProfile\b|\bopaquePublicKey\b/;
const LEGACY_ADMIN_ROUTE_PATTERN = /(?:^|[^A-Za-z0-9/])\/admin\/(?:status|users|logs|devices|invites|registration|quotas|database)(?:[/?]|['"`])/m;
const OPEN_REGISTRATION_DEFAULT_PATTERN = /REGISTRATION_MODE\s*(?:\|\|=|\?\?=|[:=])\s*['"]open['"]|registrationMode\s*\?\?\s*['"]open['"]/;

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

function normalizedRelative(root, path) {
  return relative(root, path).split(sep).join('/');
}

function isForbidden(relativePath, directory, options = {}) {
  const parts = relativePath.toLowerCase().split('/');
  const name = parts.at(-1);
  if (directory && parts.some((part) => FORBIDDEN_DIRECTORIES.has(part))) return `contains forbidden state or development directory ${name}`;
  if (name.startsWith('.env.')) return `contains forbidden environment file ${name}`;
  if (FORBIDDEN_NAMES.has(name)) return `contains forbidden state or secret file ${name}`;
  if (FORBIDDEN_SUFFIXES.some((suffix) => name.endsWith(suffix))) return `contains forbidden release file ${name}`;
  const runtimeSignature = options.allowRuntimeSignatures === true || relativePath.toLowerCase().startsWith('runtime/webview2/');
  if (name.endsWith('.sig') && !runtimeSignature) return `contains forbidden updater signature ${name}`;
  return null;
}

async function filesUnder(directory, options = {}) {
  const root = resolve(directory);
  const files = [];
  async function visit(current) {
    for (const entry of await readdir(current, { withFileTypes: true })) {
      const path = join(current, entry.name);
      const relativePath = normalizedRelative(root, path);
      const info = await lstat(path);
      if (info.isSymbolicLink()) throw new Error(`${options.label ?? 'Portable source'} contains a symbolic link: ${relativePath}`);
      const forbidden = isForbidden(relativePath, info.isDirectory(), options);
      if (forbidden) throw new Error(`${options.label ?? 'Portable source'} ${forbidden}: ${relativePath}`);
      if (info.isDirectory()) await visit(path);
      else if (info.isFile()) files.push({ path, relativePath, size: info.size });
      else throw new Error(`${options.label ?? 'Portable source'} contains an unsupported filesystem entry: ${relativePath}`);
    }
  }
  await visit(root);
  return files.sort((a, b) => a.relativePath.localeCompare(b.relativePath, 'en'));
}

async function requireFile(path, label) {
  if (!await exists(path) || !(await stat(path)).isFile()) throw new Error(`${label} is missing: ${path}`);
}

async function rejectLegacyAdminTokenSource(path, label) {
  const source = await readFile(path, 'utf8');
  if (LEGACY_ADMIN_TOKEN_PATTERN.test(source)) {
    throw new Error(`${label} still contains the removed administrator-token implementation: ${path}`);
  }
}

async function rejectLegacySyncSource(path, label) {
  const source = await readFile(path, 'utf8');
  if (LEGACY_SYNC_CONFIGURATION_PATTERN.test(source)) {
    throw new Error(`${label} still contains a removed sync configuration contract: ${path}`);
  }
  if (LEGACY_ADMIN_ROUTE_PATTERN.test(source)) {
    throw new Error(`${label} still contains the removed /admin management route: ${path}`);
  }
  if (OPEN_REGISTRATION_DEFAULT_PATTERN.test(source)) {
    throw new Error(`${label} still defaults registration to open instead of invite: ${path}`);
  }
}

async function rejectLegacySyncTree(directory, label) {
  for (const file of await filesUnder(directory, { label })) {
    if (!/\.(?:html|js|mjs)$/i.test(file.relativePath)) continue;
    await rejectLegacyAdminTokenSource(file.path, label);
    await rejectLegacySyncSource(file.path, label);
  }
}

export async function readPeMachine(path) {
  const handle = await open(path, 'r');
  try {
    const info = await handle.stat();
    if (info.size < 70) throw new Error('file is too small to contain a PE header');
    const dos = Buffer.alloc(64);
    await handle.read(dos, 0, dos.length, 0);
    if (dos[0] !== 0x4d || dos[1] !== 0x5a) throw new Error('DOS MZ signature is missing');
    const peOffset = dos.readUInt32LE(0x3c);
    if (peOffset < 64 || peOffset > info.size - 6) throw new Error(`invalid PE header offset ${peOffset}`);
    const pe = Buffer.alloc(6);
    await handle.read(pe, 0, pe.length, peOffset);
    if (pe.readUInt32LE(0) !== 0x00004550) throw new Error('PE signature is missing');
    return pe.readUInt16LE(4);
  } finally {
    await handle.close();
  }
}

async function requirePeX64(path, label) {
  let machine;
  try {
    machine = await readPeMachine(path);
  } catch (error) {
    throw new Error(`${label} is not a valid Windows PE executable: ${error.message}`);
  }
  if (machine !== 0x8664) throw new Error(`${label} PE Machine is 0x${machine.toString(16)}, expected x64 0x8664`);
}

async function copySafeTree(source, destination, label, options = {}) {
  await filesUnder(source, { label, ...options });
  await cp(source, destination, { recursive: true, errorOnExist: true });
}

async function generateFileManifest(directory, metadata) {
  const manifestPath = join(directory, 'portable-files.json');
  const files = await filesUnder(directory, { label: 'Portable package' });
  const rows = [];
  for (const file of files) {
    if (file.path === manifestPath) continue;
    rows.push({ path: file.relativePath, bytes: file.size, sha256: await sha256(file.path) });
  }
  await writeFile(manifestPath, `${JSON.stringify({
    formatVersion: 1,
    product: '资产生命周期',
    appVersion: metadata.version,
    architecture: 'x64',
    webview2RuntimeVersion: metadata.runtimeVersion,
    files: rows,
  }, null, 2)}\n`, 'utf8');
  return manifestPath;
}

export async function validatePortableDirectory(directory, expected) {
  const root = resolve(directory);
  const required = [
    'zichan.exe',
    'portable-mode.json',
    'README-便携版.txt',
    'NOTICE.txt',
    'server/node.exe',
    'server/node-LICENSE.txt',
    'server/server.mjs',
    'server/web/index.html',
    'runtime/webview2/msedgewebview2.exe',
    'runtime/webview2/msedge.dll',
    'runtime/webview2/icudtl.dat',
    'portable-files.json',
  ];
  for (const relativePath of required) await requireFile(join(root, ...relativePath.split('/')), `Portable package file ${relativePath}`);
  if (await exists(join(root, 'data'))) throw new Error('Portable release must not contain a data directory.');
  await rejectLegacyAdminTokenSource(join(root, 'server', 'server.mjs'), 'Portable bundled server');
  await rejectLegacySyncSource(join(root, 'server', 'server.mjs'), 'Portable bundled server');
  await rejectLegacySyncTree(join(root, 'server', 'web'), 'Portable bundled Web');
  await filesUnder(root, { label: 'Portable package' });

  const marker = JSON.parse(await readFile(join(root, 'portable-mode.json'), 'utf8'));
  const expectedMarker = { formatVersion: 1, appVersion: expected.version, architecture: 'x64', dataDirectory: 'data' };
  for (const [key, value] of Object.entries(expectedMarker)) {
    if (marker[key] !== value) throw new Error(`portable-mode.json ${key} is ${String(marker[key])}, expected ${String(value)}`);
  }

  const manifest = JSON.parse(await readFile(join(root, 'portable-files.json'), 'utf8'));
  if (manifest.formatVersion !== 1
    || manifest.appVersion !== expected.version
    || manifest.architecture !== 'x64'
    || manifest.webview2RuntimeVersion !== expected.runtimeVersion
    || !Array.isArray(manifest.files)) {
    throw new Error('portable-files.json metadata does not match the portable release.');
  }
  const manifestPaths = new Set();
  for (const row of manifest.files) {
    if (!row || typeof row.path !== 'string' || !Number.isSafeInteger(row.bytes) || !/^[a-f0-9]{64}$/.test(row.sha256)) {
      throw new Error('portable-files.json contains an invalid file row.');
    }
    if (manifestPaths.has(row.path)) throw new Error(`portable-files.json contains duplicate path ${row.path}`);
    manifestPaths.add(row.path);
    const path = join(root, ...row.path.split('/'));
    await requireFile(path, `Manifest file ${row.path}`);
    const info = await stat(path);
    if (info.size !== row.bytes || await sha256(path) !== row.sha256) throw new Error(`Portable file hash mismatch: ${row.path}`);
  }
  const actualFiles = await filesUnder(root, { label: 'Portable package' });
  const expectedPaths = actualFiles.map((file) => file.relativePath).filter((path) => path !== 'portable-files.json');
  if (expectedPaths.length !== manifestPaths.size || expectedPaths.some((path) => !manifestPaths.has(path))) {
    throw new Error('portable-files.json does not cover every packaged file exactly once.');
  }
  return { fileCount: manifest.files.length, marker, manifest };
}

export function compressPortablePaths(paths, archivePath) {
  if (process.platform !== 'win32') throw new Error('Windows portable ZIP creation must run on Windows.');
  if (!Array.isArray(paths) || paths.length === 0) throw new Error('At least one portable source path is required.');
  const command = [
    '$ErrorActionPreference = "Stop"',
    'Import-Module (Join-Path $env:SystemRoot "System32\\WindowsPowerShell\\v1.0\\Modules\\Microsoft.PowerShell.Archive\\Microsoft.PowerShell.Archive.psd1") -ErrorAction Stop',
    '$portableSources = @($env:ZICHAN_PORTABLE_SOURCES -split "`n")',
    'Compress-Archive -LiteralPath $portableSources -DestinationPath $env:ZICHAN_PORTABLE_ARCHIVE -CompressionLevel Optimal -Force',
  ].join('; ');
  return new Promise((resolvePromise, reject) => {
    const powershell = join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
    const child = spawn(powershell, ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', command], {
      stdio: 'inherit',
      windowsHide: true,
      env: {
        ...process.env,
        ZICHAN_PORTABLE_SOURCES: paths.join('\n'),
        ZICHAN_PORTABLE_ARCHIVE: archivePath,
      },
    });
    child.once('error', reject);
    child.once('exit', (code, signal) => {
      if (code === 0) resolvePromise();
      else reject(new Error(`Compress-Archive failed with ${signal ? `signal ${signal}` : `exit code ${code}`}`));
    });
  });
}

function compressDirectory(directory, archivePath) {
  return compressPortablePaths([directory], archivePath);
}

export async function createWindowsPortable(options = {}) {
  const root = resolve(options.repositoryRoot ?? defaultRepositoryRoot);
  const rootPackage = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));
  const version = options.version ?? rootPackage.version;
  if (version !== rootPackage.version) throw new Error(`Requested version ${version} does not match package.json ${rootPackage.version}`);

  const lockPath = resolve(options.lockPath ?? join(root, 'scripts', 'release', 'webview2-runtime.lock.json'));
  const runtimeLock = await readWebView2RuntimeLock(lockPath, { requireDownload: options.allowIncompleteLock !== true });
  const executable = resolve(options.executable ?? join(root, 'apps', 'desktop', 'src-tauri', 'target', 'release', 'zichan.exe'));
  const resources = resolve(options.resources ?? join(root, 'apps', 'desktop', 'resources'));
  const runtime = resolve(options.runtime ?? join(root, '.tools', 'webview2-fixed', runtimeLock.runtimeVersion, runtimeLock.architecture));
  const outputDirectory = resolve(options.outputDirectory ?? join(root, 'apps', 'desktop', 'src-tauri', 'target', 'release', 'portable'));
  const docsDirectory = resolve(options.docsDirectory ?? join(root, 'docs', 'portable'));
  const folderName = `资产生命周期_${version}_windows-x64_portable`;
  const finalDirectory = join(outputDirectory, folderName);
  const staging = join(outputDirectory, `.${folderName}.staging-${process.pid}`);
  const archive = join(outputDirectory, `${folderName}.zip`);

  await requireFile(executable, 'Desktop executable');
  for (const relativePath of ['node.exe', 'node-LICENSE.txt', 'server.mjs', 'web/index.html']) {
    await requireFile(join(resources, ...relativePath.split('/')), `Desktop server resource ${relativePath}`);
  }
  await rejectLegacyAdminTokenSource(join(resources, 'server.mjs'), 'Desktop bundled server resource');
  await rejectLegacySyncSource(join(resources, 'server.mjs'), 'Desktop bundled server resource');
  await rejectLegacySyncTree(join(resources, 'web'), 'Desktop bundled Web resource');
  await verifyPreparedRuntime(runtime, runtimeLock);
  await requirePeX64(executable, 'Desktop executable');
  await requirePeX64(join(resources, 'node.exe'), 'Bundled Node.js runtime');
  await requirePeX64(join(runtime, 'msedgewebview2.exe'), 'Bundled WebView2 runtime');
  for (const file of ['README-便携版.txt', 'NOTICE.txt']) await requireFile(join(docsDirectory, file), `Portable documentation ${file}`);

  await mkdir(outputDirectory, { recursive: true });
  await rm(staging, { recursive: true, force: true });
  try {
    await mkdir(join(staging, 'server'), { recursive: true });
    await mkdir(join(staging, 'runtime'), { recursive: true });
    await cp(executable, join(staging, 'zichan.exe'), { errorOnExist: true });
    await copySafeTree(resources, join(staging, 'server'), 'Desktop server resources');
    await copySafeTree(runtime, join(staging, 'runtime', 'webview2'), 'WebView2 runtime', { allowRuntimeSignatures: true });
    for (const file of ['README-便携版.txt', 'NOTICE.txt']) await cp(join(docsDirectory, file), join(staging, file), { errorOnExist: true });
    await writeFile(join(staging, 'portable-mode.json'), `${JSON.stringify({
      formatVersion: 1,
      appVersion: version,
      architecture: 'x64',
      dataDirectory: 'data',
    }, null, 2)}\n`, 'utf8');
    await generateFileManifest(staging, { version, runtimeVersion: runtimeLock.runtimeVersion });
    const validation = await validatePortableDirectory(staging, { version, runtimeVersion: runtimeLock.runtimeVersion });

    if (await exists(join(finalDirectory, 'data'))) {
      throw new Error(`Refusing to replace a portable directory that contains user data: ${finalDirectory}. Exit the app and preserve or move its data/ directory before rebuilding, or choose another --output directory.`);
    }
    await rm(finalDirectory, { recursive: true, force: true });
    await rename(staging, finalDirectory);
    if (options.archive === false) return { directory: finalDirectory, archive: null, sha256: null, ...validation };

    await rm(archive, { force: true });
    await rm(`${archive}.sha256`, { force: true });
    await (options.compress ?? compressDirectory)(finalDirectory, archive);
    await requireFile(archive, 'Portable ZIP');
    const archiveHash = await sha256(archive);
    await writeFile(`${archive}.sha256`, `${archiveHash}  ${basename(archive)}\n`, 'utf8');
    if (options.keepDirectory !== true) await rm(finalDirectory, { recursive: true, force: true });
    return { directory: options.keepDirectory === true ? finalDirectory : null, archive, sha256: archiveHash, ...validation };
  } finally {
    await rm(staging, { recursive: true, force: true });
  }
}

function parseArgs(argv) {
  const options = {};
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === '--keep-directory' || argument === '--no-archive') {
      if (argument === '--keep-directory') options.keepDirectory = true;
      else options.archive = false;
      continue;
    }
    const keys = {
      '--root': 'repositoryRoot',
      '--lock': 'lockPath',
      '--executable': 'executable',
      '--resources': 'resources',
      '--runtime': 'runtime',
      '--output': 'outputDirectory',
      '--docs': 'docsDirectory',
      '--version': 'version',
    };
    const key = keys[argument];
    if (!key) throw new Error(`Unknown argument: ${argument}`);
    const value = argv[index + 1];
    if (!value) throw new Error(`Missing value for ${argument}`);
    options[key] = value;
    index += 1;
  }
  return options;
}

if (process.argv[1] && resolve(process.argv[1]) === scriptPath) {
  const result = await createWindowsPortable(parseArgs(process.argv.slice(2)));
  if (result.archive) console.log(`Portable ZIP created: ${result.archive}\nSHA-256: ${result.sha256}`);
  else console.log(`Portable directory created: ${result.directory}`);
}
