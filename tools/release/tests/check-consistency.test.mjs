import assert from 'node:assert/strict';
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { checkReleaseConsistency } from '../../../scripts/release/check-consistency.mjs';

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const repositoryVersion = JSON.parse(await readFile(join(repositoryRoot, 'package.json'), 'utf8')).version;
const driftVersion = repositoryVersion === '9.9.9' ? '9.9.8' : '9.9.9';

function escapeRegex(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'zichan-release-check-'));
  for (const path of ['package.json', 'package-lock.json', 'apps/desktop/package.json', 'apps/web/package.json', 'apps/sync-server/package.json', 'packages/core/package.json', 'packages/db/package.json', 'packages/logger/package.json', 'apps/desktop/src-tauri/tauri.conf.json', 'apps/desktop/src-tauri/tauri.windows.conf.json', 'apps/desktop/src-tauri/Cargo.toml', 'apps/desktop/src-tauri/Cargo.lock', 'apps/desktop/src-tauri/src/portable.rs', 'packages/db/src/migrations.ts', 'packages/db/test/schema-baseline.test.ts', 'apps/web/test/sqljs-driver.test.ts', 'apps/web/test/tauri-sql-driver.test.ts', 'scripts/release/webview2-runtime.lock.json', 'docs/portable/README-便携版.txt', 'docs/portable/NOTICE.txt', 'docs/db.md', 'docs/release-notes.md']) {
    await cp(join(repositoryRoot, ...path.split('/')), join(root, ...path.split('/')), { recursive: true });
  }
  const migrations = await readFile(join(root, 'packages', 'db', 'src', 'migrations.ts'), 'utf8');
  const schemaVersion = migrations.match(/CURRENT_SCHEMA_VERSION\s*=\s*(\d+)/)?.[1];
  const schemaName = migrations.match(/CURRENT_SCHEMA_NAME\s*=\s*'([^']+)'/)?.[1];
  await writeFile(join(root, 'docs', 'db.md'), `${schemaName} (version ${schemaVersion})\n`);
  return root;
}

test('accepts the repository release metadata and exact version tag', async () => {
  const root = await fixture();
  try {
    const result = await checkReleaseConsistency(root, { tag: `v${repositoryVersion}` });
    assert.equal(result.version, repositoryVersion);
    assert.ok(Number.isSafeInteger(result.schemaVersion) && result.schemaVersion > 0);
    assert.equal(result.webview2RuntimeVersion, '151.0.4129.101');
    assert.equal(result.webview2LockComplete, true);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('reports workspace, tag, notes, and schema documentation drift together', async () => {
  const root = await fixture();
  try {
    const webPackagePath = join(root, 'apps', 'web', 'package.json');
    const webPackage = JSON.parse(await readFile(webPackagePath, 'utf8'));
    webPackage.version = driftVersion;
    await writeFile(webPackagePath, `${JSON.stringify(webPackage, null, 2)}\n`);
    await writeFile(join(root, 'docs', 'release-notes.md'), `# ${driftVersion}\n\nNo list.\n`);
    await writeFile(join(root, 'docs', 'db.md'), 'outdated schema documentation\n');

    await assert.rejects(
      checkReleaseConsistency(root, { tag: `release-${repositoryVersion}` }),
      (error) => {
        assert.match(error.message, new RegExp(`apps[\\\\/]web[\\\\/]package\\.json is ${escapeRegex(driftVersion)}`));
        assert.match(error.message, new RegExp(`release tag must be exactly v${escapeRegex(repositoryVersion)}`));
        assert.match(error.message, new RegExp(`release-notes\\.md title is ${escapeRegex(driftVersion)}`));
        assert.match(error.message, /must contain at least one release-note item/);
        assert.match(error.message, /does not name current schema version \d+/);
        return true;
      },
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('accepts the separate admin UI and invite-only registration default', async () => {
  const root = await fixture();
  try {
    const path = join(root, 'apps/desktop/scripts/current.mjs');
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, "process.env.REGISTRATION_MODE ||= 'invite'; const route = '/admin/';");
    await checkReleaseConsistency(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('rejects non-portable bundling, automatic WebView installation, early window creation, and an incomplete runtime lock', async () => {
  const root = await fixture();
  try {
    const tauriPath = join(root, 'apps', 'desktop', 'src-tauri', 'tauri.conf.json');
    const tauri = JSON.parse(await readFile(tauriPath, 'utf8'));
    tauri.bundle.active = true;
    tauri.bundle.windows.webviewInstallMode = { type: 'downloadBootstrapper' };
    await writeFile(tauriPath, `${JSON.stringify(tauri, null, 2)}\n`);

    const windowsPath = join(root, 'apps', 'desktop', 'src-tauri', 'tauri.windows.conf.json');
    const windows = JSON.parse(await readFile(windowsPath, 'utf8'));
    windows.app.windows[0].create = true;
    await writeFile(windowsPath, `${JSON.stringify(windows, null, 2)}\n`);

    const lockPath = join(root, 'scripts', 'release', 'webview2-runtime.lock.json');
    const lock = JSON.parse(await readFile(lockPath, 'utf8'));
    lock.sha256 = null;
    await writeFile(lockPath, `${JSON.stringify(lock, null, 2)}\n`);

    const portablePath = join(root, 'apps', 'desktop', 'src-tauri', 'src', 'portable.rs');
    const portable = await readFile(portablePath, 'utf8');
    await writeFile(
      portablePath,
      portable
        .replace('../../../../scripts/release/webview2-runtime.lock.json', 'duplicated-runtime-version.json')
        .replace('PORTABLE_FORMAT_VERSION: u32 = 1;', 'PORTABLE_FORMAT_VERSION: u32 = 2;'),
    );

    await assert.rejects(
      checkReleaseConsistency(root),
      (error) => {
        assert.match(error.message, /must disable Tauri bundling/);
        assert.match(error.message, /webviewInstallMode\.type to skip/);
        assert.match(error.message, /main window with create=false/);
        assert.match(error.message, /downloadUrl and sha256 must either both be filled/);
        assert.match(error.message, /must embed the tracked WebView2 runtime lock/);
        assert.match(error.message, /portable format version 1/);
        return true;
      },
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('rejects removed manual management credentials in desktop release documentation', async () => {
  const root = await fixture();
  try {
    const path = join(root, 'docs', 'desktop.md');
    await writeFile(path, 'Set ADMIN_TOKEN before starting the desktop server.\n');
    await assert.rejects(
      checkReleaseConsistency(root),
      /docs[\\/]desktop\.md still references removed manual management credentials/,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('rejects removed sync profiles, old management routes, and open defaults in production sources', async () => {
  const cases = [
    ['apps/web/src/legacy.ts', `const key = '${['zichan.sync.server', 'Profiles.v3'].join('')}';`, /removed sync configuration/],
    ['apps/sync-server/src/legacy.ts', "const route = '/admin/status';", /removed \/admin route/],
    ['apps/desktop/scripts/legacy.mjs', "process.env.REGISTRATION_MODE ||= 'open';", /defaults registration to open/],
  ];
  for (const [relativePath, source, expected] of cases) {
    const root = await fixture();
    try {
      const path = join(root, ...relativePath.split('/'));
      await mkdir(dirname(path), { recursive: true });
      await writeFile(path, source);
      await assert.rejects(checkReleaseConsistency(root), expected);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }
});
