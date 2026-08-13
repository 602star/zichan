import assert from 'node:assert/strict';
import { cp, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { checkReleaseConsistency } from './check-consistency.mjs';

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const repositoryVersion = JSON.parse(await readFile(join(repositoryRoot, 'package.json'), 'utf8')).version;
const driftVersion = repositoryVersion === '9.9.9' ? '9.9.8' : '9.9.9';

function escapeRegex(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'zichan-release-check-'));
  for (const path of ['package.json', 'package-lock.json', 'apps/desktop/package.json', 'apps/web/package.json', 'apps/sync-server/package.json', 'packages/core/package.json', 'packages/db/package.json', 'packages/logger/package.json', 'apps/desktop/src-tauri/tauri.conf.json', 'apps/desktop/src-tauri/Cargo.toml', 'apps/desktop/src-tauri/Cargo.lock', 'packages/db/src/migrations.ts', 'packages/db/test/schema-baseline.test.ts', 'apps/web/test/sqljs-driver.test.ts', 'apps/web/test/tauri-sql-driver.test.ts', 'docs/db.md', 'docs/release-notes.md']) {
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

test('rejects desktop bundling config that targets a helper binary or incompatible installer locales', async () => {
  const root = await fixture();
  try {
    const cargoPath = join(root, 'apps', 'desktop', 'src-tauri', 'Cargo.toml');
    const cargo = await readFile(cargoPath, 'utf8');
    await writeFile(
      cargoPath,
      cargo
        .replace('default-run = "zichan"', 'default-run = "verify-updater-signature"')
        .replace('release-verifier = ["dep:base64", "dep:minisign-verify"]', '')
        .replace('required-features = ["release-verifier"]', 'required-features = []'),
    );

    const tauriPath = join(root, 'apps', 'desktop', 'src-tauri', 'tauri.conf.json');
    const tauri = JSON.parse(await readFile(tauriPath, 'utf8'));
    tauri.mainBinaryName = 'verify-updater-signature';
    tauri.bundle.active = false;
    tauri.bundle.targets = [];
    tauri.bundle.windows.wix.language = ['zh-CN', 'en-US'];
    tauri.bundle.windows.nsis.languages = ['SimpChinese'];
    await writeFile(tauriPath, `${JSON.stringify(tauri, null, 2)}\n`);

    await assert.rejects(
      checkReleaseConsistency(root),
      (error) => {
        assert.match(error.message, /default-run is verify-updater-signature, expected zichan/);
        assert.match(error.message, /mainBinaryName is verify-updater-signature, expected zichan/);
        assert.match(error.message, /must enable desktop bundling/);
        assert.match(error.message, /bundle targets must include msi/);
        assert.match(error.message, /bundle targets must include nsis/);
        assert.match(error.message, /must declare the release-verifier feature/);
        assert.match(error.message, /must gate verify-updater-signature behind the release-verifier feature/);
        assert.match(error.message, /must build the MSI only with zh-CN/);
        assert.match(error.message, /must include SimpChinese and English/);
        return true;
      },
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
