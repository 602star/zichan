import { access, readFile, readdir } from 'node:fs/promises';
import { constants } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readWebView2RuntimeLock } from './webview2-runtime.mjs';

const SEMVER = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;
const TEXT_SOURCE_EXTENSIONS = new Set(['.cmd', '.cjs', '.js', '.json', '.md', '.mjs', '.ps1', '.rs', '.sh', '.toml', '.ts', '.tsx', '.txt', '.yaml', '.yml']);
const REMOVED_MANAGEMENT_CREDENTIAL_MARKERS = [
  ['ADMIN', 'TOKEN'].join('_'),
  ['PERSIST', 'ADMIN', 'TOKEN'].join('_'),
  ['X', 'Admin', 'Token'].join('-'),
  ['admin', 'token.txt'].join('-'),
];
const REMOVED_SYNC_CONFIGURATION_MARKERS = [
  ['zichan.sync.server', 'Profiles.v3'].join(''),
  ['zichan.sync.session', 'Credentials.v3'].join(''),
  ['Sync', 'Server', 'Profile'].join(''),
  ['opaque', 'PublicKey'].join(''),
];
const REMOVED_ADMIN_ROUTE = /(?:^|[^A-Za-z0-9/])\/admin\/(?:status|users|logs|devices|invites|registration|quotas|database)(?:[/?]|['"`])/m;
const OPEN_REGISTRATION_DEFAULT = new RegExp([
  // Shell/Node defaults, plus Compose and shell parameter expansion forms such as
  // `${REGISTRATION_MODE:-open}` that the previous quoted-literal pattern missed.
  String.raw`REGISTRATION_MODE\s*(?:\|\|=|\?\?=|=|:)\s*-?\s*['"]?open['"]?`,
  String.raw`registrationMode\s*\?\?\s*['"]open['"]`,
].join('|'));

async function json(path) {
  return JSON.parse(await readFile(path, 'utf8'));
}

async function exists(path) {
  try {
    await access(path, constants.R_OK);
    return true;
  } catch {
    return false;
  }
}

async function workspacePackageFiles(root, patterns) {
  const files = [];
  for (const pattern of patterns) {
    if (!pattern.endsWith('/*') || pattern.slice(0, -2).includes('*')) {
      throw new Error(`Unsupported workspace pattern: ${pattern}`);
    }
    const directory = resolve(root, pattern.slice(0, -2));
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const packageFile = join(directory, entry.name, 'package.json');
      if (await exists(packageFile)) files.push(packageFile);
    }
  }
  return files.sort();
}

async function sourceFilesUnder(root, relativeRoot) {
  const directory = join(root, ...relativeRoot.split('/'));
  if (!await exists(directory)) return [];
  const files = [];
  async function visit(current) {
    for (const entry of await readdir(current, { withFileTypes: true })) {
      if (entry.isDirectory() && ['dist', 'node_modules', 'resources', 'target', 'test', 'tests'].includes(entry.name)) continue;
      const path = join(current, entry.name);
      if (entry.isDirectory()) {
        await visit(path);
        continue;
      }
      const extension = entry.name.includes('.') ? `.${entry.name.split('.').at(-1).toLowerCase()}` : '';
      if (entry.isFile() && (TEXT_SOURCE_EXTENSIONS.has(extension) || entry.name === 'Dockerfile')) files.push(path);
    }
  }
  await visit(directory);
  return files;
}

async function findRemovedManagementCredentials(root) {
  const ignored = new Set([
    join(root, 'scripts', 'release', 'create-windows-portable.mjs').toLowerCase(),
  ]);
  const files = (await Promise.all([
    sourceFilesUnder(root, '.github'),
    sourceFilesUnder(root, 'apps/desktop'),
    sourceFilesUnder(root, 'apps/sync-server/src'),
    sourceFilesUnder(root, 'apps/web/src'),
    sourceFilesUnder(root, 'docs'),
    sourceFilesUnder(root, 'scripts'),
  ])).flat();
  const findings = [];
  for (const path of files) {
    if (ignored.has(path.toLowerCase())) continue;
    const source = await readFile(path, 'utf8');
    const relativePath = path.slice(root.length + 1);
    const documentation = relativePath.toLowerCase().startsWith(`docs${process.platform === 'win32' ? '\\' : '/'}`);
    const marker = REMOVED_MANAGEMENT_CREDENTIAL_MARKERS.find((value) => source.split(/\r?\n/).some((line) => {
      if (!line.toLowerCase().includes(value.toLowerCase())) return false;
      return !documentation || !/删除|移除|不再|不读取|不迁移|禁用|旧|removed|legacy/i.test(line);
    }));
    if (marker) findings.push(`${path.slice(root.length + 1)} still references removed manual management credentials`);
  }
  return findings;
}

async function findRemovedSyncImplementations(root) {
  const files = (await Promise.all([
    sourceFilesUnder(root, 'apps/desktop/scripts'),
    sourceFilesUnder(root, 'apps/sync-server'),
    sourceFilesUnder(root, 'apps/web/src'),
    sourceFilesUnder(root, 'scripts/windows'),
  ])).flat();
  const findings = [];
  for (const path of files) {
    const source = await readFile(path, 'utf8');
    const marker = REMOVED_SYNC_CONFIGURATION_MARKERS.find((value) => source.includes(value));
    if (marker) {
      findings.push(`${path.slice(root.length + 1)} still references removed sync configuration ${marker}`);
      continue;
    }
    if (REMOVED_ADMIN_ROUTE.test(source)) {
      findings.push(`${path.slice(root.length + 1)} still exposes the removed /admin route`);
      continue;
    }
    if (OPEN_REGISTRATION_DEFAULT.test(source)) {
      findings.push(`${path.slice(root.length + 1)} still defaults registration to open instead of invite`);
    }
  }
  return findings;
}

function cargoPackageMetadata(source) {
  const packageBlock = source.match(/(?:^|\n)\[package\]\s*\n([\s\S]*?)(?=\n\[|$)/)?.[1];
  return {
    version: packageBlock?.match(/^version\s*=\s*"([^"]+)"\s*$/m)?.[1],
    defaultRun: packageBlock?.match(/^default-run\s*=\s*"([^"]+)"\s*$/m)?.[1],
  };
}

function migrationBaseline(source) {
  return {
    version: source.match(/export const CURRENT_SCHEMA_VERSION\s*=\s*(\d+)\s*;/)?.[1],
    name: source.match(/export const CURRENT_SCHEMA_NAME\s*=\s*'([^']+)'\s*;/)?.[1],
  };
}

function releaseNotesVersion(source) {
  return source.match(/^#\s+v?([^\s]+)\s*$/m)?.[1];
}

export async function checkReleaseConsistency(rootDirectory, options = {}) {
  const root = resolve(rootDirectory);
  const failures = [];
  const rootPackagePath = join(root, 'package.json');
  const rootPackage = await json(rootPackagePath);
  const version = rootPackage.version;
  if (typeof version !== 'string' || !SEMVER.test(version)) failures.push(`package.json has invalid SemVer version: ${String(version)}`);
  const releaseNodeVersion = (await readFile(join(root, '.node-version'), 'utf8')).trim();
  if (!/^\d+\.\d+\.\d+$/.test(releaseNodeVersion)) failures.push(`.node-version must pin an exact Node.js version, received ${releaseNodeVersion}`);

  const workspaceFiles = await workspacePackageFiles(root, rootPackage.workspaces ?? []);
  for (const packageFile of workspaceFiles) {
    const workspacePackage = await json(packageFile);
    if (workspacePackage.version !== version) {
      failures.push(`${packageFile.slice(root.length + 1)} is ${String(workspacePackage.version)}, expected ${version}`);
    }
  }

  const tauriConfigPath = join(root, 'apps', 'desktop', 'src-tauri', 'tauri.conf.json');
  const tauriConfig = await json(tauriConfigPath);
  if (tauriConfig.version !== version) failures.push(`apps/desktop/src-tauri/tauri.conf.json is ${String(tauriConfig.version)}, expected ${version}`);
  if (tauriConfig.mainBinaryName !== 'zichan') {
    failures.push(`apps/desktop/src-tauri/tauri.conf.json mainBinaryName is ${String(tauriConfig.mainBinaryName)}, expected zichan`);
  }
  if (tauriConfig.bundle?.active !== false) failures.push('apps/desktop/src-tauri/tauri.conf.json must disable Tauri bundling for the portable ZIP build');
  if (tauriConfig.bundle?.windows?.webviewInstallMode?.type !== 'skip') {
    failures.push('apps/desktop/src-tauri/tauri.conf.json must set bundle.windows.webviewInstallMode.type to skip');
  }
  const updaterTestConfig = await json(join(root, 'apps', 'desktop', 'src-tauri', 'tauri.update-test.conf.json'));
  const updaterTestKey = (await readFile(join(root, 'apps', 'desktop', 'src-tauri', 'installer', 'update-test.pub'), 'utf8')).trim();
  if (updaterTestConfig.bundle?.createUpdaterArtifacts !== true
    || updaterTestConfig.plugins?.updater?.pubkey !== updaterTestKey
    || JSON.stringify(updaterTestConfig.plugins?.updater?.endpoints) !== '[]') {
    failures.push('tauri.update-test.conf.json must enable updater artifacts and match the committed test public key');
  }
  const installerConfig = await json(join(root, 'apps', 'desktop', 'src-tauri', 'tauri.installer.conf.json'));
  const installerMarker = await json(join(root, 'apps', 'desktop', 'src-tauri', 'installer', 'installed-mode.json'));
  if (installerMarker.formatVersion !== 1 || installerMarker.appVersion !== version || installerMarker.architecture !== 'x64') {
    failures.push('installed-mode.json must match the app version and x64 installed-mode format');
  }
  if (installerConfig.bundle?.active !== true
    || JSON.stringify(installerConfig.bundle?.targets) !== JSON.stringify(['msi', 'nsis'])
    || installerConfig.bundle?.windows?.webviewInstallMode?.type !== 'offlineInstaller'
    || installerConfig.bundle?.windows?.allowDowngrades !== false
    || installerConfig.bundle?.windows?.wix?.upgradeCode !== '687bf6a9-bf19-505b-81cc-864ac03395d5'
    || installerConfig.bundle?.windows?.wix?.language !== 'zh-CN'
    || installerConfig.bundle?.windows?.nsis?.installMode !== 'currentUser'
    || installerConfig.bundle?.windows?.nsis?.installerHooks !== 'installer/upgrade.nsh') {
    failures.push('tauri.installer.conf.json must enable MSI/NSIS, offline WebView2, stable Chinese MSI upgrades, current-user NSIS, and block downgrades');
  }
  const resources = installerConfig.bundle?.resources;
  if (resources?.['../resources/'] !== 'server/'
    || resources?.['installer/installed-mode.json'] !== 'installed-mode.json'
    || resources?.['installer/installed-files.json'] !== 'installed-files.json') {
    failures.push('tauri.installer.conf.json must place server resources and installed markers beside the installed executable');
  }
  const linuxConfig = await json(join(root, 'apps', 'desktop', 'src-tauri', 'tauri.linux-release.conf.json'));
  if (linuxConfig.productName !== 'Zichan'
    || linuxConfig.bundle?.active !== true
    || JSON.stringify(linuxConfig.bundle?.targets) !== JSON.stringify(['deb', 'appimage'])
    || linuxConfig.bundle?.resources?.['../resources/'] !== 'server/'
    || linuxConfig.bundle?.resources?.['installer/installed-files.json'] !== 'installed-files.json') {
    failures.push('tauri.linux-release.conf.json must build DEB/AppImage with an ASCII package name and verified bundled server resources');
  }
  const windowsConfigPath = join(root, 'apps', 'desktop', 'src-tauri', 'tauri.windows.conf.json');
  const windowsConfig = await json(windowsConfigPath);
  const mainWindow = windowsConfig.app?.windows?.find((window) => window.label === 'main');
  if (!mainWindow || mainWindow.create !== false) {
    failures.push('apps/desktop/src-tauri/tauri.windows.conf.json must declare the main window with create=false');
  }

  const cargoTomlPath = join(root, 'apps', 'desktop', 'src-tauri', 'Cargo.toml');
  const cargoSource = await readFile(cargoTomlPath, 'utf8');
  const cargoPackage = cargoPackageMetadata(cargoSource);
  if (cargoPackage.version !== version) failures.push(`apps/desktop/src-tauri/Cargo.toml is ${String(cargoPackage.version)}, expected ${version}`);
  if (cargoPackage.defaultRun !== 'zichan') {
    failures.push(`apps/desktop/src-tauri/Cargo.toml default-run is ${String(cargoPackage.defaultRun)}, expected zichan`);
  }

  const cargoLockPath = join(root, 'apps', 'desktop', 'src-tauri', 'Cargo.lock');
  const cargoLock = await readFile(cargoLockPath, 'utf8');
  const lockedProject = cargoLock.match(/\[\[package\]\]\s*\nname\s*=\s*"zichan"\s*\nversion\s*=\s*"([^"]+)"/);
  if (lockedProject?.[1] !== version) failures.push(`apps/desktop/src-tauri/Cargo.lock records zichan ${lockedProject?.[1] ?? 'missing'}, expected ${version}`);

  const packageLockPath = join(root, 'package-lock.json');
  const packageLock = await json(packageLockPath);
  if (packageLock.version !== version || packageLock.packages?.['']?.version !== version) {
    failures.push(`package-lock.json root version does not match ${version}`);
  }
  for (const packageFile of workspaceFiles) {
    const relativeDirectory = dirname(packageFile).slice(root.length + 1).replaceAll('\\', '/');
    const workspacePackage = await json(packageFile);
    if (packageLock.packages?.[relativeDirectory]?.version !== workspacePackage.version) {
      failures.push(`package-lock.json entry ${relativeDirectory} does not match ${workspacePackage.version}`);
    }
  }

  const notesPath = join(root, 'docs', 'release-notes.md');
  const notes = await readFile(notesPath, 'utf8');
  const notesVersion = releaseNotesVersion(notes);
  if (notesVersion !== version) failures.push(`docs/release-notes.md title is ${String(notesVersion)}, expected ${version}`);
  if (!notes.split(/\r?\n/).some((line) => /^\s*[-*]\s+\S/.test(line))) {
    failures.push('docs/release-notes.md must contain at least one release-note item');
  }

  if (options.tag !== undefined && options.tag !== `v${version}`) {
    failures.push(`release tag must be exactly v${version}, received ${options.tag}`);
  }

  const migrationsPath = join(root, 'packages', 'db', 'src', 'migrations.ts');
  const baseline = migrationBaseline(await readFile(migrationsPath, 'utf8'));
  const databaseDocs = await readFile(join(root, 'docs', 'db.md'), 'utf8');
  if (!baseline.version || !baseline.name) failures.push('packages/db/src/migrations.ts does not expose the current schema baseline');
  if (baseline.version && !databaseDocs.includes(`version ${baseline.version}`)) {
    failures.push(`docs/db.md does not name current schema version ${baseline.version}`);
  }
  if (baseline.name && !databaseDocs.includes(baseline.name)) {
    failures.push(`docs/db.md does not name current schema ${baseline.name}`);
  }

  const requiredDriverContracts = [
    'packages/db/test/schema-baseline.test.ts',
    'apps/web/test/sqljs-driver.test.ts',
    'apps/web/test/tauri-sql-driver.test.ts',
  ];
  for (const relativePath of requiredDriverContracts) {
    if (!await exists(join(root, ...relativePath.split('/')))) failures.push(`missing current-schema driver contract: ${relativePath}`);
  }

  let runtimeLock = null;
  try {
    runtimeLock = await readWebView2RuntimeLock(join(root, 'scripts', 'release', 'webview2-runtime.lock.json'));
  } catch (error) {
    failures.push(error.message);
  }
  const portableRust = await readFile(join(root, 'apps', 'desktop', 'src-tauri', 'src', 'portable.rs'), 'utf8');
  if (!portableRust.includes('include_str!("../../../../scripts/release/webview2-runtime.lock.json")')) {
    failures.push('apps/desktop/src-tauri/src/portable.rs must embed the tracked WebView2 runtime lock instead of duplicating its version');
  }
  if (!portableRust.includes('node_version: String')
    || !portableRust.includes('manifest.node_version != include_str!("../../../../.node-version")')) {
    failures.push('apps/desktop/src-tauri/src/portable.rs must accept and verify the pinned Node.js version in portable-files.json');
  }
  if (!/pub const PORTABLE_FORMAT_VERSION:\s*u32\s*=\s*1\s*;/.test(portableRust)) {
    failures.push('apps/desktop/src-tauri/src/portable.rs must keep portable format version 1 aligned with portable-mode.json');
  }
  for (const relativePath of ['docs/portable/README-便携版.txt', 'docs/portable/NOTICE.txt']) {
    if (!await exists(join(root, ...relativePath.split('/')))) failures.push(`missing portable release document: ${relativePath}`);
  }
  failures.push(...await findRemovedManagementCredentials(root));
  failures.push(...await findRemovedSyncImplementations(root));

  if (failures.length) throw new Error(`Release consistency check failed:\n- ${failures.join('\n- ')}`);
  return {
    version,
    schemaVersion: Number(baseline.version),
    workspaceCount: workspaceFiles.length,
    webview2RuntimeVersion: runtimeLock.runtimeVersion,
    webview2LockComplete: runtimeLock.complete,
    releaseNodeVersion,
  };
}

function parseArgs(argv) {
  const options = {};
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === '--root' || argument === '--tag') {
      const value = argv[index + 1];
      if (!value) throw new Error(`Missing value for ${argument}`);
      options[argument.slice(2)] = value;
      index += 1;
      continue;
    }
    throw new Error(`Unknown argument: ${argument}`);
  }
  return options;
}

const scriptPath = fileURLToPath(import.meta.url);
if (process.argv[1] && resolve(process.argv[1]) === scriptPath) {
  const options = parseArgs(process.argv.slice(2));
  const root = options.root ?? resolve(dirname(scriptPath), '..', '..');
  const result = await checkReleaseConsistency(root, { tag: options.tag });
  console.log(`release consistency ok: version=${result.version} schema=${result.schemaVersion} workspaces=${result.workspaceCount} node=${result.releaseNodeVersion} webview2=${result.webview2RuntimeVersion}`);
}
