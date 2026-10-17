import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmod, mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repository = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const bundle = resolve(repository, 'apps/desktop/src-tauri/target/release/bundle');
const version = JSON.parse(await readFile(resolve(repository, 'package.json'), 'utf8')).version;
const nodeVersion = (await readFile(resolve(repository, '.node-version'), 'utf8')).trim();

function run(command, args, options = {}) {
  const result = spawnSync(command, args, { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024, ...options });
  if (result.error || result.status !== 0) {
    throw new Error(`${command} ${args.join(' ')} failed: ${result.error?.message ?? result.stderr ?? result.status}`);
  }
  return result.stdout?.trim() ?? '';
}

async function onlyArtifact(directory, suffix) {
  const names = (await readdir(resolve(bundle, directory))).filter((name) => name.endsWith(suffix));
  if (names.length !== 1) throw new Error(`Expected exactly one ${suffix} in ${directory}, found ${names.length}`);
  return resolve(bundle, directory, names[0]);
}

async function findFile(root, name) {
  const found = [];
  async function visit(directory) {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) await visit(path);
      else if (entry.isFile() && entry.name === name) found.push(path);
    }
  }
  await visit(root);
  if (found.length !== 1) throw new Error(`Expected one ${name} in ${root}, found ${found.length}`);
  return found[0];
}

async function regularFiles(root) {
  const result = [];
  async function visit(directory, relative = '') {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const next = relative ? `${relative}/${entry.name}` : entry.name;
      if (entry.isSymbolicLink()) throw new Error(`Bundled server contains a link: ${next}`);
      if (entry.isDirectory()) await visit(join(directory, entry.name), next);
      else if (entry.isFile()) result.push(next);
      else throw new Error(`Bundled server contains an unsupported file: ${next}`);
    }
  }
  await visit(root);
  return result.sort();
}

async function verifyResources(root, label) {
  const manifestPath = await findFile(root, 'installed-files.json');
  const directory = dirname(manifestPath);
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
  if (manifest.formatVersion !== 1 || manifest.product !== '资产生命周期'
    || manifest.appVersion !== version || manifest.architecture !== 'x64'
    || manifest.nodeVersion !== nodeVersion || !Array.isArray(manifest.files)) {
    throw new Error(`${label}: installed resource metadata does not match the release`);
  }
  const expected = [];
  for (const file of manifest.files) {
    if (typeof file.path !== 'string' || !file.path.startsWith('server/')
      || file.path.includes('\\') || file.path.includes(':')
      || file.path.split('/').some((part) => !part || part === '.' || part === '..')) {
      throw new Error(`${label}: unsafe resource path ${file.path}`);
    }
    const path = resolve(directory, ...file.path.split('/'));
    const info = await stat(path);
    const digest = createHash('sha256').update(await readFile(path)).digest('hex');
    if (!info.isFile() || info.size !== file.bytes || digest !== file.sha256) {
      throw new Error(`${label}: resource mismatch ${file.path}`);
    }
    expected.push(file.path.slice('server/'.length));
  }
  const actual = await regularFiles(join(directory, 'server'));
  if (JSON.stringify(actual) !== JSON.stringify(expected.sort())) {
    throw new Error(`${label}: bundled server files differ from the manifest`);
  }
  const nodePath = join(directory, 'server/node');
  const nodeInfo = await stat(nodePath);
  const elf = (await readFile(nodePath)).subarray(0, 20);
  if (!(nodeInfo.mode & 0o111) || elf.toString('hex', 0, 4) !== '7f454c46'
    || elf[4] !== 2 || elf[5] !== 1 || elf.readUInt16LE(18) !== 62) {
    throw new Error(`${label}: bundled Node is not executable Linux x86_64 ELF`);
  }
  if (run(nodePath, ['--version']) !== `v${nodeVersion}`) {
    throw new Error(`${label}: bundled Node version mismatch`);
  }
  if (run('ldd', [nodePath]).includes('not found')) {
    throw new Error(`${label}: bundled Node has missing runtime libraries`);
  }
  console.log(`${label}: verified ${expected.length} server resources and Node ${nodeVersion}`);
}

async function sidecar(path) {
  const digest = createHash('sha256').update(await readFile(path)).digest('hex');
  await writeFile(`${path}.sha256`, `${digest}  ${basename(path)}\n`);
  console.log(`${basename(path)}: ${digest}`);
}

const deb = await onlyArtifact('deb', '.deb');
const appImage = await onlyArtifact('appimage', '.AppImage');
const temporary = await mkdtemp(join(tmpdir(), 'zichan-linux-bundle-'));
try {
  const debVersion = run('dpkg-deb', ['--field', deb, 'Version']);
  const packageName = run('dpkg-deb', ['--field', deb, 'Package']);
  const architecture = run('dpkg-deb', ['--field', deb, 'Architecture']);
  const dependencies = run('dpkg-deb', ['--field', deb, 'Depends']);
  if (debVersion !== version || packageName !== 'zichan' || architecture !== 'amd64'
    || !dependencies.includes('libwebkit2gtk-4.1-0') || !dependencies.includes('libgtk-3-0')) {
    throw new Error('DEB identity or WebKitGTK runtime dependencies are incorrect');
  }
  const debRoot = join(temporary, 'deb');
  run('dpkg-deb', ['--extract', deb, debRoot]);
  await verifyResources(debRoot, 'DEB');

  const appImageRoot = join(temporary, 'appimage');
  await mkdir(appImageRoot);
  await chmod(appImage, 0o755);
  run(appImage, ['--appimage-extract'], { cwd: appImageRoot, stdio: 'ignore' });
  await verifyResources(join(appImageRoot, 'squashfs-root'), 'AppImage');
  await sidecar(deb);
  await sidecar(appImage);
} finally {
  await rm(temporary, { recursive: true, force: true });
}
