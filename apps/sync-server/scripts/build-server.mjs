import { build } from 'esbuild';
import { fileURLToPath } from 'node:url';

// Bundled CommonJS dependencies call require('node:os') and other builtins.
// Give esbuild's ESM require shim a Node require without shipping node_modules.
await build({
  entryPoints: [fileURLToPath(new URL('../src/main.ts', import.meta.url))],
  outfile: fileURLToPath(new URL('../dist/server.mjs', import.meta.url)),
  bundle: true,
  platform: 'node',
  target: 'node22',
  format: 'esm',
  banner: { js: "import { createRequire } from 'node:module';\nconst require = createRequire(import.meta.url);" },
});
