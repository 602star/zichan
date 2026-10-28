import { build } from 'esbuild';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

// Bundled CommonJS dependencies call require('node:os') and other builtins.
// Give esbuild's ESM require shim a Node require without shipping node_modules.
const version = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8')).version;
const common = {
  bundle: true,
  platform: 'node',
  target: 'node22',
  format: 'esm',
  define: { __ZICHAN_SERVER_VERSION__: JSON.stringify(version) },
  banner: { js: "import { createRequire } from 'node:module';\nconst require = createRequire(import.meta.url);" },
};
await build({
  ...common,
  entryPoints: [fileURLToPath(new URL('../src/main.ts', import.meta.url))],
  outfile: fileURLToPath(new URL('../dist/server.mjs', import.meta.url)),
});
await build({
  ...common,
  entryPoints: [fileURLToPath(new URL('../src/maintenance.ts', import.meta.url))],
  outfile: fileURLToPath(new URL('../dist/maintenance.mjs', import.meta.url)),
});
