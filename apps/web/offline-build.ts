import { createHash } from 'node:crypto';
import { readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import type { Plugin } from 'vite';

/** Precache a complete immutable release; installation fails atomically if any asset is missing. */
export function offlineBuild(): Plugin {
  let output = '';
  return {
    name: 'zichan-offline-shell', apply: 'build',
    configResolved(config) { output = resolve(config.root, config.build.outDir); },
    closeBundle() {
      const assets = ['index.html', ...readdirSync(join(output, 'assets')).filter((name) => !name.endsWith('.map')).map((name) => `assets/${name}`)].sort();
      const digest = createHash('sha256');
      for (const name of assets) digest.update(name).update(readFileSync(join(output, name)));
      const version = digest.digest('hex').slice(0, 20);
      const template = readFileSync(new URL('./offline-worker.js', import.meta.url), 'utf8');
      writeFileSync(join(output, 'sw.js'), template.replace('__ASSETS__', JSON.stringify(assets)).replace('__VERSION__', version));
    },
  };
}
