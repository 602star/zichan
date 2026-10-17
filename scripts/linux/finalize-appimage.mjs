import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, readdir, rename, rm, stat, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repository = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const bundle = resolve(repository, 'apps/desktop/src-tauri/target/release/bundle/appimage');
const config = JSON.parse(await readFile(resolve(repository, 'apps/desktop/src-tauri/tauri.linux-release.conf.json'), 'utf8'));
const sourceManifest = resolve(repository, 'apps/desktop/src-tauri/installer/installed-files.json');
const names = await readdir(bundle);
const appDirs = names.filter((name) => name.endsWith('.AppDir'));
const images = names.filter((name) => name.endsWith('.AppImage'));
if (appDirs.length !== 1 || images.length !== 1) {
  throw new Error('Expected one AppDir and one AppImage from Tauri');
}

const appDir = join(bundle, appDirs[0]);
const image = join(bundle, images[0]);
const resources = join(appDir, 'usr', 'lib', config.productName);
const manifestPath = join(resources, 'installed-files.json');
const packagedManifest = JSON.parse(await readFile(manifestPath, 'utf8'));
const original = JSON.parse(await readFile(sourceManifest, 'utf8'));
const manifest = structuredClone(original);

function digest(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

let transformedNode = false;
for (const file of manifest.files) {
  const path = join(resources, ...file.path.split('/'));
  const bytes = await readFile(path);
  if (bytes.length === file.bytes && digest(bytes) === file.sha256) continue;
  if (file.path !== 'server/node' || transformedNode) {
    throw new Error(`Unexpected AppImage resource change: ${file.path}`);
  }
  const node = spawnSync(path, ['--version'], { encoding: 'utf8' });
  if (node.status !== 0 || node.stdout.trim() !== `v${manifest.nodeVersion}`) {
    throw new Error('Bundled Node does not run at the expected version');
  }
  const rpath = spawnSync('patchelf', ['--print-rpath', path], { encoding: 'utf8' });
  if (rpath.status !== 0 || rpath.stdout.trim() !== '$ORIGIN') {
    throw new Error('Bundled Node changed without the expected AppImage RPATH');
  }
  const info = await stat(path);
  if (!(info.mode & 0o111) || bytes.toString('hex', 0, 4) !== '7f454c46') {
    throw new Error('Bundled Node is not an executable ELF');
  }
  file.bytes = bytes.length;
  file.sha256 = digest(bytes);
  transformedNode = true;
}

if (!transformedNode) {
  if (JSON.stringify(packagedManifest) !== JSON.stringify(original)) {
    throw new Error('AppImage resource manifest changed without a transformed Node');
  }
  console.log('AppImage resources were not transformed');
  process.exit(0);
}

if (JSON.stringify(packagedManifest) !== JSON.stringify(original)
  && JSON.stringify(packagedManifest) !== JSON.stringify(manifest)) {
  throw new Error('AppImage resource manifest changed unexpectedly');
}
await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
const cache = process.env.XDG_CACHE_HOME || resolve(homedir(), '.cache');
const plugin = resolve(cache, 'tauri/linuxdeploy-plugin-appimage.AppImage');
const temporary = await mkdtemp(join(bundle, '.zichan-appimage-final-'));
try {
  const result = spawnSync(plugin, [`--appdir=${appDir}`], {
    cwd: temporary,
    env: { ...process.env, APPIMAGE_EXTRACT_AND_RUN: '1', ARCH: 'x86_64' },
    stdio: 'inherit',
  });
  if (result.error || result.status !== 0) {
    throw new Error(`AppImage repack failed: ${result.error?.message ?? result.status}`);
  }
  const rebuilt = (await readdir(temporary)).filter((name) => name.endsWith('.AppImage'));
  if (rebuilt.length !== 1) throw new Error(`Expected one rebuilt AppImage, found ${rebuilt.length}`);
  await rename(join(temporary, rebuilt[0]), image);
  console.log(`${basename(image)}: updated manifest for AppImage RPATH`);
} finally {
  await rm(temporary, { recursive: true, force: true });
}
