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
