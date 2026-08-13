import { readFile, readdir } from 'node:fs/promises';
import { basename, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

async function filesUnder(directory) {
  const files = [];
  async function visit(current) {
    for (const entry of await readdir(current, { withFileTypes: true })) {
      const path = resolve(current, entry.name);
      if (entry.isDirectory()) await visit(path);
      else files.push(path);
    }
  }
  await visit(resolve(directory));
  return files.sort();
}

function hasVersion(fileName, version) {
  const escaped = version.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`(?:^|[_. -])${escaped}(?=$|[_. -])`).test(fileName);
}

export async function verifyReleaseArtifacts(options) {
  const bundleDirectory = resolve(options.bundleDir);
  const manifestPath = resolve(options.manifest);
  const version = options.version;
  const tag = options.tag;
  const failures = [];
  const files = await filesUnder(bundleDirectory);
  const installers = files.filter((path) => path.endsWith('.msi') || path.endsWith('.exe'));
  const updaterArchives = files.filter((path) => /(?:\.msi\.zip|\.nsis\.zip|\.app\.tar\.gz|\.AppImage\.tar\.gz)$/.test(path));
  if (!installers.some((path) => path.endsWith('.msi'))) failures.push('MSI installer is missing');
  if (!installers.some((path) => path.endsWith('.exe'))) failures.push('NSIS installer is missing');
  if (!updaterArchives.length) failures.push('signed updater archive is missing');
  for (const path of [...installers, ...updaterArchives]) {
    if (!hasVersion(basename(path), version)) failures.push(`${basename(path)} does not contain release version ${version}`);
  }

  const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
  if (manifest.version !== version) failures.push(`manifest version is ${String(manifest.version)}, expected ${version}`);
  if (typeof manifest.notes !== 'string' || !manifest.notes.trim()) failures.push('manifest release notes are empty');
  const platforms = manifest.platforms && typeof manifest.platforms === 'object' ? Object.values(manifest.platforms) : [];
  if (!platforms.length) failures.push('manifest has no updater platforms');
  const expectedTagPath = `/releases/download/${encodeURIComponent(tag)}/`;
  const archiveByName = new Map(updaterArchives.map((path) => [basename(path), path]));
  for (const row of platforms) {
    if (!row || typeof row !== 'object' || typeof row.url !== 'string' || typeof row.signature !== 'string' || !row.signature.trim()) {
      failures.push('manifest contains an incomplete updater platform');
      continue;
    }
    if (!row.url.includes(expectedTagPath)) failures.push(`manifest URL does not target ${tag}: ${row.url}`);
    let fileName = '';
    try {
      fileName = decodeURIComponent(new URL(row.url).pathname.split('/').at(-1) ?? '');
    } catch {
      failures.push(`manifest contains an invalid updater URL: ${row.url}`);
      continue;
    }
    const archive = archiveByName.get(fileName);
    if (!archive) {
      failures.push(`manifest references missing updater archive: ${fileName}`);
      continue;
    }
    const signature = (await readFile(`${archive}.sig`, 'utf8')).trim();
    if (signature !== row.signature.trim()) failures.push(`manifest signature does not match ${fileName}.sig`);
  }

  if (failures.length) throw new Error(`Release artifact verification failed:\n- ${[...new Set(failures)].join('\n- ')}`);
  return { installerCount: installers.length, updaterCount: updaterArchives.length, platformCount: platforms.length };
}

function parseArgs(argv) {
  const result = {};
  for (let index = 0; index < argv.length; index += 2) {
    const key = argv[index];
    const value = argv[index + 1];
    if (!key?.startsWith('--') || !value) throw new Error(`Invalid argument near ${key ?? 'end'}`);
    result[key.slice(2)] = value;
  }
  for (const required of ['bundle-dir', 'manifest', 'version', 'tag']) {
    if (!result[required]) throw new Error(`Missing --${required}`);
  }
  return result;
}

const scriptPath = fileURLToPath(import.meta.url);
if (process.argv[1] && resolve(process.argv[1]) === scriptPath) {
  const args = parseArgs(process.argv.slice(2));
  const result = await verifyReleaseArtifacts({
    bundleDir: args['bundle-dir'],
    manifest: args.manifest,
    version: args.version,
    tag: args.tag,
  });
  console.log(`release artifacts ok: installers=${result.installerCount} updaters=${result.updaterCount} platforms=${result.platformCount}`);
}
