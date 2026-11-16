import { test } from 'node:test';
import assert from 'node:assert/strict';
import { collectContainerLogs, parseDockerLines } from '../../../scripts/linux/container-log-snapshot.mjs';

test('host log collection preserves both streams, stable ids, timestamps and bounded content', async () => {
  const output = '2026-11-16T01:00:00.123456789Z synthetic-out\n';
  const rows = parseDockerLines('test-app', 'stdout', output);
  assert.equal(rows[0].at, '2026-11-16T01:00:00.123Z');
  assert.equal(rows[0].id, parseDockerLines('test-app', 'stdout', output)[0].id);
  assert.ok(parseDockerLines('test-app', 'stdout', `2026-11-16T01:00:00Z ${'x'.repeat(5000)}`)[0].message.length <= 4096);
  const result = await collectContainerLogs(['test-app'], async (command, args, options) => {
    assert.equal(command, 'docker'); assert.deepEqual(args, ['logs','--timestamps','--since','24h','--tail','200','--','test-app']);
    assert.equal(options.timeout, 4000);
    return { stdout: output, stderr: '2026-11-16T01:00:01Z synthetic-error\n' };
  });
  assert.deepEqual(result.entries.map((row) => row.stream), ['stderr','stdout']);
  assert.equal(result.errors.length, 0);
});

test('rejects arbitrary container arguments and reports read failure without raw output', async () => {
  await assert.rejects(collectContainerLogs(['app;touch /tmp/unsafe']));
  const result = await collectContainerLogs(['test-app'], async () => { throw new Error('secret-error-output'); });
  assert.deepEqual(result.errors, [{ container: 'test-app', code: 'DOCKER_LOG_READ_FAILED' }]);
  assert.ok(!JSON.stringify(result).includes('secret-error-output'));
});
