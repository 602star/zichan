import { spawn, type ChildProcess } from 'node:child_process';
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createBackupExecutor, type BackupPlan } from './backup-executor.js';
import { watchShutdownInput } from './shutdown-input.js';
import { assertServerStopped } from './backup.js';

function linuxProcessIdentity(pid: number): string | undefined {
  if (process.platform !== 'linux') return undefined;
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, 'utf8');
    const fields = stat.slice(stat.lastIndexOf(')') + 2).trim().split(/\s+/);
    const startTicks = fields[19]; // /proc stat field 22; fields here begin at field 3.
    const bootId = readFileSync('/proc/sys/kernel/random/boot_id', 'utf8').trim();
    return startTicks && /^\d+$/.test(startTicks) && bootId ? `${bootId}:${startTicks}` : undefined;
  } catch { return undefined; }
}

/** Keep a Linux PID reuse from turning a killed container's lock into a permanent startup failure. */
export function acquireBackupExecutorLock(dataDir: string): () => void {
  mkdirSync(dataDir, { recursive: true });
  const lock = join(dataDir, 'backup-executor.lock');
  if (existsSync(lock)) {
    const contents = readFileSync(lock, 'utf8');
    let pid: number;
    let identity: string | undefined;
    try {
      if (/^\d+$/.test(contents)) pid = Number(contents);
      else {
        const parsed: unknown = JSON.parse(contents);
        if (!parsed || typeof parsed !== 'object' || !('pid' in parsed)) throw new Error();
        pid = Number(parsed.pid);
        identity = 'identity' in parsed && typeof parsed.identity === 'string'
          ? parsed.identity : undefined;
      }
    } catch { throw new Error('备份执行器锁文件无效，请核实进程后处理'); }
    if (!Number.isSafeInteger(pid) || pid <= 0) throw new Error('备份执行器锁文件无效，请核实进程后处理');
    let live = false;
    try { process.kill(pid, 0); live = true; }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error; }
    const currentIdentity = live ? linuxProcessIdentity(pid) : undefined;
    if (live && (!identity || !currentIdentity || identity === currentIdentity)) {
      throw new Error('该数据目录已有备份执行器');
    }
    unlinkSync(lock);
  }
  const handle = openSync(lock, 'wx', 0o600);
  try {
    const identity = linuxProcessIdentity(process.pid);
    writeFileSync(handle, identity ? JSON.stringify({ pid: process.pid, identity }) : String(process.pid));
  } finally { closeSync(handle); }
  return () => unlinkSync(lock);
}

/** A supervisor owns only its own HTTP child. It never kills a PID taken from a file. */
export async function runBackupSupervisor(entry: string, dataDir: string, webDir: string | undefined, controlStdin: boolean): Promise<void> {
  const releaseLock = acquireBackupExecutorLock(dataDir);
  let child: ChildProcess | undefined;
  let exited: Promise<number | null> = Promise.resolve(0);
  let plan: BackupPlan | undefined;
  let closing = false;
  let expectedExit = false;
  let timer: ReturnType<typeof setInterval> | undefined;
  let executor: ReturnType<typeof createBackupExecutor> | undefined;
  let shutdown: Promise<void> | undefined;
  let finish: () => void = () => undefined;
  const finished = new Promise<void>((done) => { finish = done; });
  let fatal: Error | undefined;
  const stopService = async () => {
    if (!child?.pid || child.exitCode !== null || child.signalCode !== null) { await exited; return; }
    expectedExit = true;
    child.stdin?.write('shutdown\n');
    let timeout: ReturnType<typeof setTimeout> | undefined;
    try {
      const code = await Promise.race([
        exited,
        new Promise<never>((_, reject) => { timeout = setTimeout(() => reject(new Error('服务未在 45 秒内停止；取消本次备份')), 45_000); }),
      ]);
      if (code !== 0) throw new Error(`服务未正常停止（${String(code)}），本次备份取消`);
    } finally { if (timeout) clearTimeout(timeout); expectedExit = false; }
  };
  const requestShutdown = (reason: string) => {
    if (shutdown) return;
    closing = true;
    shutdown = (async () => {
      console.log(`Backup supervisor closing: ${reason}`);
      if (timer) clearInterval(timer);
      await executor?.close();
      await stopService();
    })().catch((error: unknown) => { fatal = error instanceof Error ? error : new Error(String(error)); }).finally(finish);
  };
  const startService = async () => {
    if (closing) return;
    if (child && child.exitCode === null && child.signalCode === null) return;
    plan = undefined; expectedExit = false;
    const instance = spawn(process.execPath, [fileURLToPath(entry)], {
      env: { ...process.env, DATA_DIR: dataDir, ZICHAN_SERVER_WORKER: '1', CONTROL_STDIN: '1' },
      stdio: ['pipe', 'inherit', 'inherit', 'ipc'], windowsHide: true,
    });
    child = instance;
    instance.stdin?.on('error', () => undefined);
    exited = new Promise((done) => {
      instance.once('exit', (code) => {
        done(code);
        if (!expectedExit && !closing) { fatal = new Error(`HTTP 服务意外退出（${String(code)}）`); requestShutdown('child exited'); }
      });
      instance.once('error', () => done(1));
    });
    await new Promise<void>((done, reject) => {
      const timeout = setTimeout(() => reject(new Error('HTTP 服务启动超过 60 秒')), 60_000);
      const settle = () => { clearTimeout(timeout); done(); };
      instance.once('error', (error) => { clearTimeout(timeout); reject(error); });
      instance.once('exit', (code) => { clearTimeout(timeout); reject(new Error(`HTTP 服务启动失败（${String(code)}）`)); });
      instance.on('message', (message: unknown) => {
        if (typeof message === 'object' && message && 'updateRestart' in message
          && message.updateRestart === true && process.env.ZICHAN_UPDATE_LAUNCHER === '1') {
          requestShutdown('signed update installed');
          return;
        }
        if (typeof message !== 'object' || !message || !('backupPlan' in message)) return;
        plan = (message as { backupPlan: BackupPlan }).backupPlan;
        settle();
      });
    });
  };
  const onInt = () => requestShutdown('SIGINT');
  const onTerm = () => requestShutdown('SIGTERM');
  process.once('SIGINT', onInt); process.once('SIGTERM', onTerm);
  const unwatch = controlStdin ? watchShutdownInput(process.stdin, requestShutdown) : undefined;
  try {
    assertServerStopped(dataDir);
    await startService();
    executor = createBackupExecutor({ dataDir, webDir, startService, stopService });
    timer = setInterval(() => {
      try { executor!.heartbeat(); }
      catch (error) { fatal = error instanceof Error ? error : new Error(String(error)); requestShutdown('journal write failed'); return; }
      if (plan) void executor!.tick(plan);
    }, 10_000);
    await finished;
    if (fatal) throw fatal;
  } finally {
    if (timer) clearInterval(timer);
    closing = true;
    await executor?.close();
    await stopService();
    unwatch?.(); process.off('SIGINT', onInt); process.off('SIGTERM', onTerm);
    releaseLock();
  }
}
