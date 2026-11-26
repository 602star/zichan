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
      const files = readdirSync(join(output, 'assets')).filter((name) => !name.endsWith('.map'));
      const isOcr = (name: string) => /^(ocr-worker-|ort[.-]|worker-entry-)/.test(name);
      const heavy = files.filter((name) => isOcr(name) && !name.startsWith('worker-entry-') && name.endsWith('.js'));
      const resources = JSON.parse(readFileSync(join(output, 'ocr/resources.json'), 'utf8')) as { resources: { file: string; bytes: number; sha256: string }[] };
      const entries = [...resources.resources, ...heavy.map((name) => {
        const bytes = readFileSync(join(output, 'assets', name));
        return { file: `assets/${name}`, bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') };
      })];
      const ocrVersion = createHash('sha256').update(JSON.stringify(entries)).digest('hex').slice(0, 20);
      writeFileSync(join(output, 'ocr/manifest.json'), JSON.stringify({ version: ocrVersion, resources: entries }));
      const assets = ['index.html', 'ocr/manifest.json', ...files.filter((name) => !isOcr(name)).map((name) => `assets/${name}`)].sort();
      const digest = createHash('sha256');
      for (const name of assets) digest.update(name).update(readFileSync(join(output, name)));
      const version = digest.digest('hex').slice(0, 20);
      const indexPath = join(output, 'index.html');
      const index = readFileSync(indexPath, 'utf8');
      writeFileSync(indexPath, index.replace('  </head>', `    <meta name="zichan-shell-version" content="${version}" />\n  </head>`));
      const template = readFileSync(new URL('./offline-worker.js', import.meta.url), 'utf8');
      writeFileSync(join(output, 'sw.js'), template.replace('__ASSETS__', JSON.stringify(assets)).replace('__VERSION__', version)
        .replace('__OCR_VERSION__', ocrVersion)
        .replace('__OCR_ASSETS__', JSON.stringify(entries.map((row) => row.file))));
    },
  };
}
