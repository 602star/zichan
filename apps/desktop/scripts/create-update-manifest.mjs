import { readFile, readdir, writeFile } from 'node:fs/promises';
import { basename, join, resolve } from 'node:path';

export function parseManifestArgs(argv) {
  const values = new Map();
  for (let index = 0; index < argv.length; index += 2) {
    const key = argv[index];
    const value = argv[index + 1];
    if (!key?.startsWith('--') || value === undefined) throw new Error(`Invalid argument near ${key ?? 'end'}`);
    values.set(key.slice(2), value);
  }
  for (const required of ['bundle-dir', 'output', 'tag', 'repository', 'version']) {
    if (!values.get(required)) throw new Error(`Missing --${required}`);
  }
  return Object.fromEntries(values);
}

function architecture(fileName) {
  if (/(?:^|[_-])(aarch64|arm64)(?:[_-]|\\.)/i.test(fileName)) return 'aarch64';
  if (/(?:^|[_-])(i686|x86)(?:[_-]|\\.)/i.test(fileName)) return 'i686';
  if (/(?:^|[_-])(x64|x86_64)(?:[_-]|\\.)/i.test(fileName)) return 'x86_64';
  throw new Error(`Cannot determine updater architecture from ${fileName}`);
}

function installer(fileName) {
  if (fileName.endsWith('.nsis.zip')) return { os: 'windows', installer: 'nsis' };
  if (fileName.endsWith('.msi.zip')) return { os: 'windows', installer: 'msi' };
  if (fileName.endsWith('.app.tar.gz')) return { os: 'darwin', installer: 'app' };
  if (fileName.endsWith('.AppImage.tar.gz')) return { os: 'linux', installer: 'appimage' };
  return null;
}

async function updaterArtifacts(directory) {
  const result = [];
  async function visit(current) {
    for (const entry of await readdir(current, { withFileTypes: true })) {
      const path = join(current, entry.name);
      if (entry.isDirectory()) await visit(path);
      else if (installer(entry.name)) result.push(path);
    }
  }
  await visit(directory);
  return result.sort();
}

export async function createUpdateManifest(options) {
  const bundleDirectory = resolve(options['bundle-dir']);
  const artifacts = await updaterArtifacts(bundleDirectory);
  if (artifacts.length === 0) throw new Error(`No updater artifacts found under ${bundleDirectory}`);
  const platforms = {};
  for (const path of artifacts) {
    const fileName = basename(path);
    const kind = installer(fileName);
    const arch = architecture(fileName);
    const signature = (await readFile(`${path}.sig`, 'utf8')).trim();
    if (!signature) throw new Error(`Updater signature is empty for ${fileName}`);
    const url = `https://github.com/${options.repository}/releases/download/${encodeURIComponent(options.tag)}/${encodeURIComponent(fileName)}`;
    const detailedKey = `${kind.os}-${arch}-${kind.installer}`;
    platforms[detailedKey] = { signature, url };
    const fallbackKey = `${kind.os}-${arch}`;
    if (!platforms[fallbackKey] || kind.installer === 'nsis') platforms[fallbackKey] = { signature, url };
  }
  const notes = options['notes-file']
    ? (await readFile(resolve(options['notes-file']), 'utf8')).trim()
    : '';
  return {
    version: options.version,
    notes,
    pub_date: options['pub-date'] ?? new Date().toISOString(),
    platforms,
  };
}

async function main() {
  const options = parseManifestArgs(process.argv.slice(2));
  const manifest = await createUpdateManifest(options);
  await writeFile(resolve(options.output), `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'))) {
  await main();
}
