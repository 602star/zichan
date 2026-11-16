import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const exec = promisify(execFile);
test('independent host checker detects stopped service and requires two consecutive recoveries', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'zichan-host-check-'));
  const script = resolve(import.meta.dirname, '../../../scripts/linux/observability-check.mjs');
  const stateFile = join(dir, 'host-observability.json');
  const server = createServer((_req, res) => { res.writeHead(200); res.end('{"ok":true}'); });
  const baseEnv = { ...process.env, OBS_STATE_FILE: stateFile, OBS_DATA_PATH: dir, OBS_BARK_URL: '', OBS_BARK_DEVICE_KEY: '', OBS_CONTAINERS: '' };
  const check = async (url) => {
    await exec(process.execPath, [script], { env: { ...baseEnv, OBS_HEALTH_URL: url }, timeout: 15000 }).catch((error) => { assert.equal(error.code, 1, error.stderr); });
    return JSON.parse(await readFile(stateFile, 'utf8'));
  };
  try {
    const first = await check('http://127.0.0.1:1/readyz');
    assert.equal(first.active, false); assert.equal(first.failureStreak, 1);
    const second = await check('http://127.0.0.1:1/readyz');
    assert.equal(second.active, true); assert.ok(second.failures.includes('API_UNREACHABLE'));
    await new Promise((resolveListen) => server.listen(0, '127.0.0.1', resolveListen));
    const url = `http://127.0.0.1:${server.address().port}/readyz`;
    const recovery1 = await check(url); assert.equal(recovery1.active, true);
    const recovery2 = await check(url); assert.equal(recovery2.active, false); assert.equal(recovery2.recoveryStreak, 2);
    assert.ok(recovery2.disk.availableBytes > 0);
    assert.equal(recovery2.delivery.code, 'NOT_CONFIGURED');
    assert.equal(recovery2.source, 'independent_host_timer');
  } finally { await new Promise((done) => server.close(done)); await rm(dir, { recursive: true, force: true }); }
});
