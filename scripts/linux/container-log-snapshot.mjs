import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const run = promisify(execFile);
export function parseDockerLines(container, stream, output) {
  const occurrences = new Map();
  return output.split(/\r?\n/).filter(Boolean).slice(-200).flatMap((line) => {
    const split = line.indexOf(' ');
    if (split < 0) return [];
    const at = line.slice(0, split);
    if (!Number.isFinite(Date.parse(at))) return [];
    const message = line.slice(split + 1).slice(0, 4096);
    const key = `${container}\n${stream}\n${at}\n${message}`;
    const occurrence = (occurrences.get(key) ?? 0) + 1; occurrences.set(key, occurrence);
    return [{ id: createHash('sha256').update(`${key}\n${occurrence}`).digest('hex'), at: new Date(at).toISOString(), container, stream, message }];
  });
}

/** Host-only, fixed command and six-name allowlist. Does not open a network listener. */
export async function collectContainerLogs(containers, execute = run) {
  if (containers.length > 6 || containers.some((name) => !/^[A-Za-z0-9][A-Za-z0-9_.-]{0,100}$/.test(name))) throw new Error('Invalid container allowlist');
  const errors = [];
  const batches = await Promise.all(containers.map(async (name) => {
    try {
      const result = await execute('docker', ['logs', '--timestamps', '--since', '24h', '--tail', '200', '--', name], { timeout: 4000, maxBuffer: 1024 * 1024, encoding: 'utf8' });
      return [...parseDockerLines(name, 'stdout', result.stdout), ...parseDockerLines(name, 'stderr', result.stderr)].slice(-200);
    } catch { errors.push({ container: name, code: 'DOCKER_LOG_READ_FAILED' }); return []; }
  }));
  return { sampledAt: new Date().toISOString(), containers, entries: batches.flat().sort((a, b) => b.at.localeCompare(a.at)), errors };
}
