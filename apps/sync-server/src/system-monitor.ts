/** Cross-platform system readings. Docker readings are explicitly container scoped. */
import { existsSync, readFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { platform } from 'node:os';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import si from 'systeminformation';

export interface SystemMonitorReading {
  sampledAt: string;
  mode: 'windows' | 'linux' | 'docker' | 'other';
  scope: 'host' | 'container';
  cpuPercent: number | null;
  memoryUsedBytes: number | null;
  memoryTotalBytes: number | null;
  networkRxBytesPerSecond: number | null;
  networkTxBytesPerSecond: number | null;
  diskReadBytesPerSecond: number | null;
  diskWriteBytesPerSecond: number | null;
  processCount: number | null;
  topProcesses: { pid: number; name: string; cpuPercent: number; rssBytes: number }[];
  unavailable: string[];
}

const valid = (value: unknown): number | null => typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null;
const rounded = (value: number | null, digits = 1): number | null => value === null ? null : Number(value.toFixed(digits));
const execFileAsync = promisify(execFile);
const PROBE_TIMEOUT_MS = 4_000;

function boundedProbe<T>(probe: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout>;
  return Promise.race([
    probe,
    new Promise<T>((_, reject) => {
      timer = setTimeout(() => reject(new Error('system probe timed out')), PROBE_TIMEOUT_MS);
    }),
  ]).finally(() => clearTimeout(timer!));
}

async function windowsDisk(): Promise<{ read: number | null; write: number | null }> {
  const script = "Get-CimInstance Win32_PerfFormattedData_PerfDisk_PhysicalDisk | Where-Object Name -eq '_Total' | Select-Object DiskReadBytesPerSec,DiskWriteBytesPerSec | ConvertTo-Json -Compress";
  const { stdout } = await execFileAsync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], { timeout: 5_000, windowsHide: true });
  const result = JSON.parse(stdout) as { DiskReadBytesPerSec?: unknown; DiskWriteBytesPerSec?: unknown };
  return { read: valid(result.DiskReadBytesPerSec), write: valid(result.DiskWriteBytesPerSec) };
}

async function numericFile(path: string): Promise<number | null> {
  try { return valid(Number((await readFile(path, 'utf8')).trim())); } catch { return null; }
}

async function containerCpu(): Promise<{ usage: number; capacity: number; quota: boolean } | null> {
  try {
    const stat = await readFile('/sys/fs/cgroup/cpu.stat', 'utf8');
    const usage = valid(Number(stat.match(/^usage_usec\s+(\d+)/m)?.[1]));
    const [quota, period] = (await readFile('/sys/fs/cgroup/cpu.max', 'utf8')).trim().split(/\s+/);
    const capacity = quota === 'max' ? 1 : Number(quota) / Number(period);
    return usage === null || !Number.isFinite(capacity) || capacity <= 0 ? null : { usage, capacity, quota: quota !== 'max' };
  } catch {
    const usage = await numericFile('/sys/fs/cgroup/cpuacct/cpuacct.usage');
    if (usage === null) return null;
    const quota = await numericFile('/sys/fs/cgroup/cpu/cpu.cfs_quota_us');
    const period = await numericFile('/sys/fs/cgroup/cpu/cpu.cfs_period_us');
    return { usage: usage / 1000, capacity: quota && period ? quota / period : 1, quota: Boolean(quota && period) };
  }
}

async function containerMemory(): Promise<{ used: number | null; total: number | null }> {
  const used = await numericFile('/sys/fs/cgroup/memory.current') ?? await numericFile('/sys/fs/cgroup/memory/memory.usage_in_bytes');
  const max = await numericFile('/sys/fs/cgroup/memory.max') ?? await numericFile('/sys/fs/cgroup/memory/memory.limit_in_bytes');
  return { used, total: max !== null && max < 2 ** 60 ? max : null };
}

export function createSystemMonitor() {
  const os = platform();
  let cgroup = '';
  if (os === 'linux') { try { cgroup = readFileSync('/proc/1/cgroup', 'utf8'); } catch { /* optional marker */ } }
  const docker = os === 'linux' && (existsSync('/.dockerenv') || Boolean(process.env.CONTAINER) || /docker|containerd|kubepods/i.test(cgroup));
  const mode: SystemMonitorReading['mode'] = docker ? 'docker' : os === 'win32' ? 'windows' : os === 'linux' ? 'linux' : 'other';
  let previousNetwork: { at: number; counters: Map<string, { rx: number; tx: number }> } | undefined;
  let previousCpu: { at: number; usage: number } | undefined;
  let cache: { at: number; value: SystemMonitorReading } | undefined;
  let inFlight: Promise<SystemMonitorReading> | undefined;

  const collect = async (): Promise<SystemMonitorReading> => {
    const at = Date.now();
    const [cpu, memory, network, disk, processes] = await Promise.allSettled([
      boundedProbe<Awaited<ReturnType<typeof containerCpu>> | Awaited<ReturnType<typeof si.currentLoad>>>(docker ? containerCpu() : si.currentLoad()),
      boundedProbe<Awaited<ReturnType<typeof containerMemory>> | Awaited<ReturnType<typeof si.mem>>>(docker ? containerMemory() : si.mem()),
      boundedProbe(si.networkStats('*')),
      boundedProbe<Awaited<ReturnType<typeof si.fsStats>> | Awaited<ReturnType<typeof windowsDisk>> | null>(os === 'linux' && !docker ? si.fsStats() : os === 'win32' ? windowsDisk() : Promise.resolve(null)),
      boundedProbe(si.processes()),
    ]);
    const unavailable: string[] = [];
    let cpuPercent: number | null = null;
    if (cpu.status === 'fulfilled' && cpu.value) {
      if (docker && 'usage' in cpu.value) {
        const elapsed = previousCpu ? at - previousCpu.at : 0;
        cpuPercent = previousCpu && elapsed > 0 ? rounded(Math.max(0, (cpu.value.usage - previousCpu.usage) / (elapsed * 1000 * cpu.value.capacity) * 100)) : null;
        previousCpu = { at, usage: cpu.value.usage };
        if (!cpu.value.quota) unavailable.push('容器未设置 CPU 配额；CPU 按单核 100% 计');
      } else if ('currentLoad' in cpu.value) cpuPercent = rounded(valid(cpu.value.currentLoad));
    }
    if (cpuPercent === null) unavailable.push(docker ? '容器 CPU 首次采样或 cgroup 不可读' : '主机 CPU 暂不可读');

    let memoryUsedBytes: number | null = null;
    let memoryTotalBytes: number | null = null;
    if (memory.status === 'fulfilled') {
      if (docker && memory.value) {
        const value = memory.value as { used: number | null; total: number | null };
        memoryUsedBytes = value.used;
        memoryTotalBytes = value.total;
      } else if (memory.value) {
        const value = memory.value as Awaited<ReturnType<typeof si.mem>>;
        memoryTotalBytes = valid(value.total);
        memoryUsedBytes = valid(value.active) ?? (memoryTotalBytes !== null ? memoryTotalBytes - value.available : null);
      }
    }
    if (memoryUsedBytes === null) unavailable.push(docker ? '容器内存 cgroup 不可读' : '主机内存暂不可读');
    if (docker && memoryTotalBytes === null) unavailable.push('容器未设置内存上限');

    let networkRxBytesPerSecond: number | null = null;
    let networkTxBytesPerSecond: number | null = null;
    if (network.status === 'fulfilled') {
      const counters = new Map(network.value.filter((item) => !/loopback|^lo$/i.test(item.iface))
        .map((item) => [item.iface, { rx: item.rx_bytes, tx: item.tx_bytes }] as const));
      const elapsed = previousNetwork ? (at - previousNetwork.at) / 1000 : 0;
      if (previousNetwork && elapsed > 0 && counters.size) {
        let rx = 0; let tx = 0; let matched = 0;
        for (const [name, value] of counters) {
          const prior = previousNetwork.counters.get(name);
          if (!prior || value.rx < prior.rx || value.tx < prior.tx) continue;
          rx += value.rx - prior.rx; tx += value.tx - prior.tx; matched++;
        }
        if (matched) { networkRxBytesPerSecond = Math.round(rx / elapsed); networkTxBytesPerSecond = Math.round(tx / elapsed); }
      }
      previousNetwork = { at, counters };
    }
    if (networkRxBytesPerSecond === null) unavailable.push('网络吞吐首次采样或网卡计数不可读');

    const diskReadBytesPerSecond = disk.status === 'fulfilled' && disk.value
      ? 'rx_sec' in disk.value ? valid(disk.value.rx_sec) : valid(disk.value.read) : null;
    const diskWriteBytesPerSecond = disk.status === 'fulfilled' && disk.value
      ? 'wx_sec' in disk.value ? valid(disk.value.wx_sec) : valid(disk.value.write) : null;
    if (diskReadBytesPerSecond === null || diskWriteBytesPerSecond === null) unavailable.push(docker ? '容器内无法可靠区分宿主机磁盘 I/O' : '磁盘 I/O 计数器暂不可读');

    const processCount = processes.status === 'fulfilled' ? valid(processes.value.all) : null;
    const topProcesses = processes.status === 'fulfilled'
      ? processes.value.list.filter((item) => item.pid > 0 && !/^System Idle Process$/i.test(item.name))
        .sort((a, b) => b.cpu - a.cpu || b.memRss - a.memRss).slice(0, 10)
        .map((item) => ({ pid: item.pid, name: item.name, cpuPercent: rounded(valid(item.cpu)) ?? 0, rssBytes: Math.round((valid(item.memRss) ?? 0) * 1024) }))
      : [];
    if (processCount === null) unavailable.push('进程列表暂不可读');
    if (docker) unavailable.push('宿主机进程与主机总资源需要额外的宿主机采集器');
    return { sampledAt: new Date(at).toISOString(), mode, scope: docker ? 'container' : 'host', cpuPercent,
      memoryUsedBytes, memoryTotalBytes, networkRxBytesPerSecond, networkTxBytesPerSecond,
      diskReadBytesPerSecond, diskWriteBytesPerSecond, processCount, topProcesses, unavailable };
  };

  return { read: (): Promise<SystemMonitorReading> => {
    if (cache && Date.now() - cache.at < 2_000) return Promise.resolve(cache.value);
    if (!inFlight) inFlight = collect().then((value) => { cache = { at: Date.now(), value }; return value; }).finally(() => { inFlight = undefined; });
    return inFlight;
  } };
}
