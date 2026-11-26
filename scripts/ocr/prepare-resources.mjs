import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { mkdir, readFile, writeFile, rename, rm } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { hardenOpenCv } from './opencv-csp.mjs';

const root = fileURLToPath(new URL('../../', import.meta.url));
const output = join(root, 'apps/web/public/ocr');
const lock = JSON.parse(await readFile(new URL('./models.lock.json', import.meta.url), 'utf8'));
const require = createRequire(join(root, 'apps/web/package.json'));
const runtimeDir = dirname(dirname(require.resolve('onnxruntime-web')));
const runtime = JSON.parse(await readFile(join(runtimeDir, 'package.json'), 'utf8'));
if (runtime.version !== lock.runtimeVersion) throw new Error('OCR runtime version does not match models.lock.json');
await mkdir(output, { recursive: true });
const hash = (bytes) => createHash('sha256').update(bytes).digest('hex');
const opencv = await readFile(require.resolve('@techstark/opencv-js'));
if (hash(opencv) !== lock.opencv.sha256) throw new Error('OpenCV glue checksum does not match models.lock.json');
const generated = join(root, 'apps/web/.generated/ocr');
await mkdir(generated, { recursive: true });
await writeFile(join(generated, 'opencv.cjs'), hardenOpenCv(opencv.toString('utf8')));
const resources = [];
const barcode = await readFile(require.resolve('zxing-wasm/reader/zxing_reader.wasm'));
if (barcode.length !== lock.barcode.bytes || hash(barcode) !== lock.barcode.sha256) throw new Error('Barcode WASM checksum does not match models.lock.json');
await writeFile(join(output, lock.barcode.file), barcode);
resources.push({ file: `ocr/${lock.barcode.file}`, bytes: barcode.length, sha256: hash(barcode) });
for (const model of lock.models) {
  const target = join(output, model.file);
  let bytes = await readFile(target).catch(() => null);
  if (!bytes || bytes.length !== model.bytes || hash(bytes) !== model.sha256) {
    const response = await fetch(model.url, { signal: AbortSignal.timeout(120_000) });
    if (!response.ok) throw new Error(`OCR public model download failed: ${response.status}`);
    bytes = Buffer.from(await response.arrayBuffer());
    if (bytes.length !== model.bytes || hash(bytes) !== model.sha256) throw new Error(`OCR model checksum mismatch: ${model.file}`);
    await writeFile(`${target}.part`, bytes);
    await rename(`${target}.part`, target);
  }
  resources.push({ file: `ocr/${model.file}`, bytes: model.bytes, sha256: model.sha256 });
}
for (const name of ['ort-wasm-simd-threaded.jsep.mjs', 'ort-wasm-simd-threaded.jsep.wasm']) await rm(join(output, name), { force: true });
for (const name of ['ort-wasm-simd-threaded.mjs', 'ort-wasm-simd-threaded.wasm']) {
  const bytes = await readFile(join(runtimeDir, 'dist', name));
  await writeFile(join(output, name), bytes);
  resources.push({ file: `ocr/${name}`, bytes: bytes.length, sha256: hash(bytes) });
}
await writeFile(join(output, 'resources.json'), JSON.stringify({ version: lock.version, resources }, null, 2));
console.log(`Local OCR public resources verified: ${resources.reduce((total, row) => total + row.bytes, 0)} bytes`);
