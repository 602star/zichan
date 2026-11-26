import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { createHash } from 'node:crypto';
import { runInNewContext } from 'node:vm';
import { dirname } from 'node:path';
import { hardenOpenCv } from '../../../scripts/ocr/opencv-csp.mjs';

const require = createRequire(import.meta.url);
const source = await readFile(require.resolve('@techstark/opencv-js'), 'utf8');
const lock = JSON.parse(await readFile(new URL('../../../scripts/ocr/models.lock.json', import.meta.url), 'utf8'));

test('locked OpenCV bindings run without JavaScript string compilation and preserve call semantics', () => {
  assert.equal(createHash('sha256').update(source).digest('hex'), lock.opencv.sha256);
  const hardened = hardenOpenCv(source);
  assert.doesNotMatch(hardened, /\b(?:new\s+)?Function\s*\(|\beval\s*\(|\bnew_\(Function\b/);
  const named = hardened.match(/function createNamedFunction\(name,body\)\{[\s\S]*?(?=function extendError\()/)[0];
  const caller = hardened.match(/function makeDynCaller\(dynCall\)\{[\s\S]*?(?=var fp;)/)[0];
  const result = runInNewContext(`
    function makeLegalFunctionName(name) { return name.replace(/[^a-zA-Z0-9_]/g, '$'); }
    ${named}
    ${caller}
    const signature = 'vii', rawFunction = 42;
    const wrapper = createNamedFunction('order-error', function(a,b){ return this.value + a + b; });
    const call = makeDynCaller(function(){ return Array.from(arguments); });
    ({ name: wrapper.name, value: wrapper.call({value:10},2,3), length: call.length,
       args: call(7,8,9), missing: call(7), callName: call.name });
  `, {}, { contextCodeGeneration: { strings: false, wasm: false } });
  assert.equal(result.name, 'order$error'); assert.equal(result.value, 15);
  assert.equal(result.length, 2); assert.equal(result.callName, 'dynCall_vii_42');
  assert.deepEqual([...result.args], [42, 7, 8]); assert.deepEqual([...result.missing], [42, 7, undefined]);
});

test('OpenCV upgrades or additional string evaluation require an explicit adaptation', () => {
  assert.throws(() => hardenOpenCv(source.replace('function makeDynCaller(', 'function changedDynCaller(')), /Unsupported OpenCV/);
  assert.throws(() => hardenOpenCv(`${source}\neval('unexpected')`), /Unexpected dynamic JavaScript/);
});

test('real OpenCV WASM constructs, converts, resizes and deletes matrices with string compilation disabled', { timeout: 10_000 }, async () => {
  const module = { exports: {} };
  runInNewContext(hardenOpenCv(source), {
    module, exports: module.exports, require, process, Buffer, console,
    __dirname: dirname(require.resolve('@techstark/opencv-js')), TextDecoder,
    setTimeout, clearTimeout, performance, crypto,
  }, { contextCodeGeneration: { strings: false, wasm: true } });
  const { cv } = await new Promise((resolve) => module.exports.then((cv) => resolve({ cv })));
  const input = cv.matFromArray(2, 2, cv.CV_8UC4, new Array(16).fill(255));
  const gray = new cv.Mat(), output = new cv.Mat();
  try {
    cv.cvtColor(input, gray, cv.COLOR_RGBA2GRAY);
    cv.resize(gray, output, new cv.Size(4, 4), 0, 0, cv.INTER_LINEAR);
    assert.equal(output.rows, 4); assert.equal(output.cols, 4);
    assert.deepEqual([...output.data], new Array(16).fill(255));
    assert.throws(() => cv.resize(gray), /arguments/);
  } finally { output.delete(); gray.delete(); input.delete(); }
});
