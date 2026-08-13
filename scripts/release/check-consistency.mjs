import { access, readFile, readdir } from 'node:fs/promises';
import { constants } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const SEMVER = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;

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

function cargoPackageVersion(source) {
  const packageBlock = source.match(/(?:^|\n)\[package\]\s*\n([\s\S]*?)(?=\n\[|$)/)?.[1];
  return packageBlock?.match(/^version\s*=\s*"([^"]+)"\s*$/m)?.[1];
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

  const cargoTomlPath = join(root, 'apps', 'desktop', 'src-tauri', 'Cargo.toml');
  const cargoVersion = cargoPackageVersion(await readFile(cargoTomlPath, 'utf8'));
  if (cargoVersion !== version) failures.push(`apps/desktop/src-tauri/Cargo.toml is ${String(cargoVersion)}, expected ${version}`);

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

  if (failures.length) throw new Error(`Release consistency check failed:\n- ${failures.join('\n- ')}`);
  return { version, schemaVersion: Number(baseline.version), workspaceCount: workspaceFiles.length };
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
  console.log(`release consistency ok: version=${result.version} schema=${result.schemaVersion} workspaces=${result.workspaceCount}`);
}
