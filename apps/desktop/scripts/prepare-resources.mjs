import { cp, copyFile, mkdir, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

const here = dirname(fileURLToPath(import.meta.url));
const desktopRoot = resolve(here, '..');
const repoRoot = resolve(desktopRoot, '../..');
const resources = resolve(desktopRoot, 'resources');
const runtimeName = process.platform === 'win32' ? 'node.exe' : 'node';

if (process.env.ZICHAN_RELEASE_BUILD === '1') {
  const expected = (await readFile(resolve(repoRoot, '.node-version'), 'utf8')).trim();
  if (process.versions.node !== expected) {
    throw new Error(`Windows releases require Node.js ${expected}, received ${process.versions.node}`);
  }
}

await rm(resources, { recursive: true, force: true });
await mkdir(resolve(resources, 'web'), { recursive: true });
await build({
  entryPoints: [resolve(here, 'bundled-server-entry.ts')],
  outfile: resolve(resources, 'server.mjs'),
  bundle: true,
  platform: 'node',
  target: 'node22',
  format: 'esm',
  sourcemap: false,
  minify: true,
  // The bundled systeminformation CommonJS code requires Node builtins at runtime.
  banner: { js: "import { createRequire } from 'node:module';\nconst require = createRequire(import.meta.url);" },
});
await copyFile(process.execPath, resolve(resources, runtimeName));
await copyFile(resolve(dirname(process.execPath), 'LICENSE'), resolve(resources, 'node-LICENSE.txt'));
await cp(resolve(repoRoot, 'apps/web/dist'), resolve(resources, 'web'), { recursive: true });
const files = [];
async function addFiles(directory, relative = '') {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const next = relative ? `${relative}/${entry.name}` : entry.name;
    const absolute = join(directory, entry.name);
    if (/(^|\/)(?:data|\.env(?:\.local)?|server-id|server\.secret|custody\.key|admin-token\.txt)(?:\/|$)|\.(?:sqlite(?:-[^/]*)?|db|pdb|hold)$/i.test(next)) {
      throw new Error(`User data or development artifact cannot enter desktop resources: ${next}`);
    }
    if (entry.isDirectory()) await addFiles(absolute, next);
    else if (entry.isFile()) {
      const info = await stat(absolute);
      const hash = createHash('sha256').update(await readFile(absolute)).digest('hex');
      files.push({ path: `server/${next}`, bytes: info.size, sha256: hash });
    } else throw new Error(`Unexpected desktop resource type: ${absolute}`);
  }
}
await addFiles(resources);
files.sort((left, right) => left.path.localeCompare(right.path, 'en'));
const tauriConfig = JSON.parse(await readFile(resolve(desktopRoot, 'src-tauri/tauri.conf.json'), 'utf8'));
const installer = resolve(desktopRoot, 'src-tauri/installer');
await mkdir(installer, { recursive: true });
await writeFile(resolve(installer, 'installed-files.json'), `${JSON.stringify({
  formatVersion: 1,
  product: tauriConfig.productName,
  appVersion: tauriConfig.version,
  architecture: 'x64',
  nodeVersion: process.versions.node,
  files,
}, null, 2)}\n`);
console.log(`Desktop resources prepared in ${resources}`);
