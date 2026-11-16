/** One-shot host probe. Run from a host timer; never mount Docker Socket into the app. */
import { readFile, writeFile, rename, mkdir, statfs, chown } from 'node:fs/promises';
import { dirname } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { collectContainerLogs } from './container-log-snapshot.mjs';

const run = promisify(execFile);
const target = process.env.OBS_HEALTH_URL ?? 'http://127.0.0.1:8787/readyz';
const stateFile = process.env.OBS_STATE_FILE ?? '/var/lib/zichan/host-observability.json';
const containers = (process.env.OBS_CONTAINERS ?? '').split(',').map((s) => s.trim()).filter(Boolean);
if (containers.some((name) => !/^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,100}$/.test(name))) throw new Error('Invalid container name');
if (containers.length > 6) throw new Error('At most six containers per checker');
const barkUrl = process.env.OBS_BARK_URL;
const barkKey = process.env.OBS_BARK_DEVICE_KEY;
if (barkUrl && new URL(barkUrl).protocol !== 'https:') throw new Error('Bark must use HTTPS');
let previous = {};
try { previous = JSON.parse(await readFile(stateFile, 'utf8')); } catch { /* First run. */ }
const failures = [];
try {
  const response = await fetch(target, { signal: AbortSignal.timeout(5000), redirect: 'error' });
  if (!response.ok) failures.push('API_NOT_READY');
} catch { failures.push('API_UNREACHABLE'); }
const containerReadings = [];
for (const name of containers) {
  try {
    const { stdout } = await run('docker', ['inspect', '--format', '{{json .State}}|{{.RestartCount}}', name], { timeout: 5000, maxBuffer: 65536 });
    const [state, restarts] = stdout.trim().split('|');
    const info = JSON.parse(state);
    const reading = { name, running: info.Running === true, health: info.Health?.Status ?? 'not_configured', oomKilled: info.OOMKilled === true, restartCount: Number(restarts) };
    containerReadings.push(reading);
    const old = previous.containers?.find((item) => item.name === name);
    if (!reading.running || reading.oomKilled || reading.health === 'unhealthy' || (old && reading.restartCount > old.restartCount)) failures.push(`CONTAINER_FAULT:${name}`);
  } catch { failures.push(`DOCKER_INSPECT_FAILED:${name}`); }
}
let disk = null;
try {
  const fs = await statfs(process.env.OBS_DATA_PATH ?? dirname(stateFile));
  disk = { availableBytes: fs.bavail * fs.bsize, totalBytes: fs.blocks * fs.bsize, inodeAvailable: fs.ffree, inodeTotal: fs.files };
  if (disk.totalBytes && disk.availableBytes / disk.totalBytes < .15) failures.push('DISK_SPACE_LOW');
  if (disk.inodeTotal && disk.inodeAvailable / disk.inodeTotal < .1) failures.push('INODES_LOW');
} catch { failures.push('DISK_PROBE_FAILED'); }
const now = Date.now();
const streak = failures.length ? (previous.failureStreak ?? 0) + 1 : 0;
const recoveryStreak = failures.length ? 0 : (previous.recoveryStreak ?? 0) + 1;
const active = streak >= 2 || Boolean(previous.active && recoveryStreak < 2);
const resolved = previous.active && !active;
const fingerprint = failures.slice().sort().join(',');
let delivery = { status: 'skipped', code: barkKey && barkUrl ? 'NO_STATE_CHANGE' : 'NOT_CONFIGURED' };
let lastSentAt = previous.lastSentAt ?? null;
if ((active && failures.length && (fingerprint !== previous.notifiedFingerprint || now - Date.parse(lastSentAt ?? '') >= 900000 || !lastSentAt)) || resolved || (previous.recoveryNotificationPending && !active)) {
  if (barkKey && barkUrl) {
    try {
      const response = await fetch(new URL('/push', barkUrl), { method: 'POST', headers: { 'Content-Type': 'application/json' }, signal: AbortSignal.timeout(8000), redirect: 'error', body: JSON.stringify({ device_key: barkKey, title: active ? '有本 · 宿主机告警' : '有本 · 服务恢复', body: active ? failures.join('\n') || '等待连续恢复' : '连续两次检查通过', group: 'zichan-host' }) });
      const result = await response.json();
      if (!response.ok || result.code !== 200) throw new Error('rejected');
      delivery = { status: 'accepted', code: 'BARK_ACCEPTED' }; lastSentAt = new Date(now).toISOString();
    } catch { delivery = { status: 'failed', code: 'BARK_DELIVERY_FAILED' }; }
  }
}
const next = { sampledAt: new Date(now).toISOString(), source: 'independent_host_timer', targetStatus: failures.includes('API_UNREACHABLE') || failures.includes('API_NOT_READY') ? 'failed' : 'healthy', failures, failureStreak: streak, recoveryStreak, active,
  containers: containerReadings, disk, delivery, lastSentAt, notifiedFingerprint: delivery.status === 'accepted' ? fingerprint : previous.notifiedFingerprint ?? null,
  recoveryNotificationPending: Boolean(!active && (resolved || previous.recoveryNotificationPending) && delivery.status !== 'accepted') };
await mkdir(dirname(stateFile), { recursive: true, mode: 0o700 });
await writeFile(`${stateFile}.tmp`, JSON.stringify(next, null, 2), { mode: 0o600 });
if (process.env.OBS_STATE_UID) {
  const uid = Number(process.env.OBS_STATE_UID); const gid = Number(process.env.OBS_STATE_GID ?? uid);
  if (!Number.isInteger(uid) || uid < 0 || !Number.isInteger(gid) || gid < 0) throw new Error('Invalid state ownership');
  await chown(`${stateFile}.tmp`, uid, gid);
}
await rename(`${stateFile}.tmp`, stateFile);
const logContainers = (process.env.OBS_LOG_CONTAINERS ?? '').split(',').map((name) => name.trim()).filter(Boolean);
if (logContainers.length) {
  const snapshot = await collectContainerLogs(logContainers);
  const logFile = process.env.OBS_LOG_STATE_FILE ?? `${dirname(stateFile)}/container-logs.json`;
  await mkdir(dirname(logFile), { recursive: true, mode: 0o700 });
  await writeFile(`${logFile}.tmp`, JSON.stringify(snapshot), { mode: 0o600 });
  if (process.env.OBS_STATE_UID) await chown(`${logFile}.tmp`, Number(process.env.OBS_STATE_UID), Number(process.env.OBS_STATE_GID ?? process.env.OBS_STATE_UID));
  await rename(`${logFile}.tmp`, logFile);
}
// Output contains no URL, device key or raw exception text.
console.log(JSON.stringify({ sampledAt: next.sampledAt, active, failures, delivery }));
if (failures.length) process.exitCode = 1;
