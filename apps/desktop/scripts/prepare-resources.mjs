import { cp, copyFile, mkdir, rm } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

const here = dirname(fileURLToPath(import.meta.url));
const desktopRoot = resolve(here, '..');
const repoRoot = resolve(desktopRoot, '../..');
const resources = resolve(desktopRoot, 'resources');
const runtimeName = process.platform === 'win32' ? 'node.exe' : 'node';

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
});
await copyFile(process.execPath, resolve(resources, runtimeName));
await copyFile(resolve(dirname(process.execPath), 'LICENSE'), resolve(resources, 'node-LICENSE.txt'));
await cp(resolve(repoRoot, 'apps/web/dist'), resolve(resources, 'web'), { recursive: true });
console.log(`Desktop resources prepared in ${resources}`);
