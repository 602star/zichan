import { spawn } from 'node:child_process';
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { createRequire } from 'node:module';
import { createServer } from 'node:http';
import { createServer as createTcpServer } from 'node:net';
import { networkInterfaces } from 'node:os';
import { existsSync, mkdirSync, readFileSync, writeFileSync, unlinkSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

export const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const modes = ['web', 'sync', 'server', 'desktop', 'all'];
const delay = (ms) => new Promise((done) => setTimeout(done, ms));

function workspaceBin(directory, workspace, packageName, bin) {
  const manifest = join(directory, workspace, 'package.json');
  if (existsSync(manifest)) {
    try {
      const requireWorkspace = createRequire(manifest);
      return join(dirname(requireWorkspace.resolve(`${packageName}/package.json`)), bin);
    } catch (error) {
      if (error.code !== 'MODULE_NOT_FOUND') throw error;
    }
  }
  return join(directory, 'node_modules', packageName, bin);
}

/** Only configuration that changes the running service participates; npm invocation variables do not. */
function fingerprint(unit) {
  const names = ['DATA_DIR', 'WEB_DIST', 'ENABLE_WEB', 'ENABLE_SYNC', 'BASE_PATH', 'REGISTRATION_MODE',
    'ALLOW_INSECURE_HTTP', 'TRUSTED_PROXIES', 'CUSTODY_KEY_PATH',
    'SYNC_SECRET', 'SERVER_ID', 'COMMIT_QUOTA_BYTES', 'ATTACHMENT_QUOTA_BYTES', 'ATTACHMENT_MAX_FILE_BYTES',
    'ATTACHMENT_TRASH_RETENTION_MS', 'ZICHAN_DEV_API_TARGET', ...Object.keys(unit.env).filter((name) => name.startsWith('ADMIN_'))];
  const env = Object.fromEntries([...new Set(names)].sort().map((name) => [name, unit.env[name] ?? '']));
  return createHash('sha256').update(JSON.stringify({ entry: resolve(unit.entry), cwd: resolve(unit.cwd), args: unit.args, port: unit.port, host: unit.host, env })).digest('hex');
}

function readLauncher(file, directory) {
  const state = JSON.parse(readFileSync(file, 'utf8'));
  if (resolve(state.root ?? '') !== resolve(directory) || !/^[a-f0-9]{32}$/.test(state.id)
    || !Number.isSafeInteger(state.pid) || state.pid < 1 || !/^[a-f0-9]{64}$/.test(state.token)
    || !Number.isInteger(state.controlPort) || state.controlPort < 1 || state.controlPort > 65535) throw new Error(`Invalid launcher record: ${file}`);
  return state;
}

async function inspectRunning(value) {
  const reused = [];
  for (const unit of value.units) {
    const file = join(value.directory, '.runtime/launchers', `${unit.key}.json`);
    if (!existsSync(file)) continue;
    const state = readLauncher(file, value.directory);
    if (!alive(state.pid)) continue;
    let status;
    try { status = await requestControl(state, undefined, '/status'); }
    catch { throw new Error(`服务已有启动记录，但无法确认启动器状态。请先运行 npm stop，再启动；不会按 PID 强制结束进程。${file}`); }
    const active = status.units?.find((entry) => entry.key === unit.key);
    if (!active || active.fingerprint !== fingerprint(unit)) throw new Error(`已有 ${unit.key} 服务正在运行，但端口、路径或配置与本次请求不同。请先运行 npm stop 后再用新配置启动；现有服务未被修改。`);
    if (status.phase === 'stopping') throw new Error('服务正在停止，请等待停止命令完成后再启动。');
    // A second click during build/startup joins the existing launch instead of creating a second one.
    const deadline = Date.now() + 120_000;
    while (status.phase !== 'running') {
      if (Date.now() >= deadline) throw new Error('现有启动器仍在构建或启动，请查看原启动窗口；未启动重复进程。');
      await delay(250);
      status = await requestControl(state, undefined, '/status');
      if (status.phase === 'stopping') throw new Error('原启动过程已停止，请查看原窗口中的错误。');
    }
    if (unit.ready) {
      try {
        const response = await fetch(unit.ready, { signal: AbortSignal.timeout(5000), redirect: 'error' });
        await response.body?.cancel();
        if (!response.ok) throw new Error('not ready');
      } catch { throw new Error(`已确认 ${unit.key} 服务归本项目管理，但暂时无法访问（可能正在自动备份）。未启动重复进程，请稍后重试。`); }
    }
    reused.push(unit.key);
  }
  return reused;
}

/** Non-loopback IPv4 addresses, so launcher output names the address other devices must use. */
function lanAddresses() {
  const found = [];
  for (const entries of Object.values(networkInterfaces())) {
    for (const entry of entries ?? []) {
      if (entry.family === 'IPv4' && !entry.internal) found.push(entry.address);
    }
  }
  return [...new Set(found)];
}

export function npmCli() {
  const candidates = [process.env.npm_execpath, join(dirname(process.execPath), 'node_modules/npm/bin/npm-cli.js'), resolve(dirname(process.execPath), '../lib/node_modules/npm/bin/npm-cli.js'), '/usr/share/nodejs/npm/bin/npm-cli.js'];
  const entry = candidates.find((path) => path && existsSync(path));
  if (!entry) throw new Error('npm CLI not found; run this entry through npm.');
  return entry;
}

export function plan(mode, env = process.env, directory = root) {
  if (!modes.includes(mode)) throw new Error(`Unknown mode: ${mode}`);
  const port = Number(env.PORT || 8787);
  const webPort = Number(env.WEB_PORT || 5173);
  if (![port, webPort].every((value) => Number.isInteger(value) && value > 0 && value < 65536)) throw new Error('PORT and WEB_PORT must be integers from 1 to 65535.');
  if (mode === 'all' && port === webPort) throw new Error('PORT and WEB_PORT must differ.');
  if (mode === 'desktop' && webPort !== 5173) throw new Error('Desktop development requires WEB_PORT=5173 (Tauri devUrl).');
  const base = (env.BASE_PATH || '').trim().replace(/\/+$/, '');
  if (base && (!base.startsWith('/') || /[?#;\r\n]/.test(base))) throw new Error('BASE_PATH must be an absolute URL path without a query or fragment.');
  const host = env.HOST || '0.0.0.0';
  const clientHost = host === '0.0.0.0' ? '127.0.0.1' : host === '::' ? '[::1]' : host.includes(':') ? `[${host}]` : host;
  const localUrl = `http://${clientHost}:${port}${encodeURI(base)}`;
  const serverEnv = { ...env, HOST: env.HOST || '0.0.0.0', PORT: String(port), BASE_PATH: base,
    DATA_DIR: resolve(directory, env.DATA_DIR || '.runtime/sync-server'), WEB_DIST: resolve(directory, env.WEB_DIST || 'apps/web/dist'),
    ENABLE_WEB: mode === 'sync' ? '0' : '1', ENABLE_SYNC: '1', REGISTRATION_MODE: env.REGISTRATION_MODE || 'invite',
    ALLOW_INSECURE_HTTP: env.ALLOW_INSECURE_HTTP || '1', CONTROL_STDIN: '1' };
  const server = { key: 'server', entry: join(directory, 'apps/desktop/scripts/server.mjs'), args: [], env: serverEnv,
    cwd: directory, port, host: serverEnv.HOST, ready: `${localUrl}/api/health`, graceful: true };
  const web = { key: 'web', entry: workspaceBin(directory, 'apps/web', 'vite', 'bin/vite.js'), args: ['--host', '0.0.0.0', '--port', String(webPort), '--strictPort'],
    env: { ...env, ZICHAN_DEV_API_TARGET: env.ZICHAN_DEV_API_TARGET || localUrl }, cwd: join(directory, 'apps/web'), port: webPort, host: '0.0.0.0', ready: `http://127.0.0.1:${webPort}/` };
  const desktop = { key: 'desktop', entry: workspaceBin(directory, 'apps/desktop', '@tauri-apps/cli', 'tauri.js'), args: ['dev'],
    env, cwd: join(directory, 'apps/desktop'), port: 5173, host: '127.0.0.1', ready: null };
  return { mode, directory, units: mode === 'all' ? [server, web] : [mode === 'web' ? web : mode === 'desktop' ? desktop : server],
    build: mode === 'server' || mode === 'all' ? 'build:server' : mode === 'sync' ? 'build:api' : null,
    urls: mode === 'sync' ? [server.ready] : mode === 'web' ? [web.ready] : mode === 'desktop' ? [] : [`${localUrl}/`, server.ready] };
}

export async function assertPortFree(port, host) {
  const probe = createTcpServer();
  await new Promise((done, reject) => {
    probe.once('error', () => reject(new Error(`Port ${host}:${port} is unavailable. No process was stopped; choose another port or stop its owner explicitly.`)));
    probe.listen(port, host, () => probe.close(done));
  });
}

function preflight(value, noBuild) {
  const [major, minor] = process.versions.node.split('.').map(Number);
  if (major < 26 || major === 26 && minor < 13) throw new Error('Node.js 26.13.0+ is required.');
  if (!existsSync(join(value.directory, 'node_modules'))) throw new Error('Dependencies are missing. Run npm ci explicitly first.');
  for (const unit of value.units) {
    if (!existsSync(unit.entry)) throw new Error(`Missing runtime: ${unit.entry}`);
    if (unit.key === 'server') {
      if (noBuild && (!existsSync(join(value.directory, 'apps/sync-server/dist/server.mjs'))
        || value.mode !== 'sync' && !existsSync(join(value.directory, 'apps/web/dist/index.html')))) throw new Error('Build artifacts are missing. Run npm run build:server first.');
      const pidFile = join(unit.env.DATA_DIR, 'server.pid');
      if (existsSync(pidFile)) {
        const saved = JSON.parse(readFileSync(pidFile, 'utf8'));
        if (!Number.isSafeInteger(saved.pid) || saved.pid < 1) throw new Error(`Invalid server PID file; inspect ${pidFile}`);
        if (alive(saved.pid)) throw new Error(`Data directory may already be in use (PID ${saved.pid}). No process was stopped: ${unit.env.DATA_DIR}`);
      }
    }
  }
}

function alive(pid) {
  try { process.kill(pid, 0); return true; } catch (error) { return error.code !== 'ESRCH'; }
}
function ownedSpawn(entry, args, options) {
  const child = spawn(process.execPath, [entry, ...args], { ...options, windowsHide: true, detached: process.platform !== 'win32', stdio: ['pipe', 'inherit', 'inherit'] });
  child.stdin.on('error', () => {});
  child.completion = new Promise((done) => {
    child.once('error', (error) => { console.error(error.message); done(1); });
    child.once('exit', (code, signal) => done(code ?? (signal ? 1 : 0)));
  });
  return child;
}

async function terminate(child, graceful = false) {
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  if (graceful) {
    child.stdin.end();
    if (await Promise.race([child.completion.then(() => true), delay(5000).then(() => false)])) return;
  }
  // These are live ChildProcess handles created by this invocation, never PIDs read from disk or ports.
  if (process.platform === 'win32') {
    await new Promise((done) => {
      const killer = spawn('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
      killer.once('error', done); killer.once('exit', done);
    });
  } else {
    try { process.kill(-child.pid, 'SIGTERM'); } catch { /* Already exited. */ }
  }
  await Promise.race([child.completion, delay(3000)]);
}

async function requestControl(state, body, path = '/stop') {
  const response = await fetch(`http://127.0.0.1:${state.controlPort}${path}`, { method: path === '/status' ? 'GET' : 'POST', redirect: 'error',
    signal: AbortSignal.timeout(5000), headers: { 'X-Zichan-Launcher': state.token, 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  if (!response.ok) throw new Error(`Launcher control rejected the request: HTTP ${response.status}`);
  const result = await response.json();
  if (result.id !== state.id || result.root !== state.root) throw new Error('Launcher identity mismatch. No PID-based termination attempted.');
  return result;
}

export async function stop(mode = 'all', directory = root) {
  if (!modes.includes(mode)) throw new Error(`Unknown mode: ${mode}`);
  const keys = mode === 'all' ? ['server', 'web', 'desktop'] : [mode === 'sync' ? 'server' : mode];
  let stopped = 0;
  const seen = new Set();
  for (const key of keys) {
    const file = join(directory, '.runtime/launchers', `${key}.json`);
    if (!existsSync(file)) continue;
    const state = readLauncher(file, directory);
    if (seen.has(state.id)) continue;
    seen.add(state.id);
    if (!alive(state.pid)) { unlinkSync(file); continue; }
    await requestControl(state, { key });
    const deadline = Date.now() + 60_000;
    while (existsSync(file) && JSON.parse(readFileSync(file, 'utf8')).id === state.id) {
      if (Date.now() >= deadline) throw new Error('停止请求已发送，但服务尚未确认退出。请检查原启动窗口；不要立即重复启动。');
      await delay(100);
    }
    stopped++;
  }
  console.log(stopped ? `Stopped ${stopped} managed launcher(s); ports and data handles have been released.` : 'No matching managed launcher. Unmanaged processes and port listeners were not touched.');
}

export async function start(value, { noBuild = false, check = false } = {}) {
  const reused = await inspectRunning(value);
  if (reused.length) {
    console.log(`[OK] 已在运行，复用现有服务：${reused.join(', ')}。没有创建新进程，也没有重新构建。`);
    for (const url of value.urls) console.log(`  ${url}`);
    if (reused.length === value.units.length) return 0;
    value = { ...value, units: value.units.filter((unit) => !reused.includes(unit.key)),
      build: reused.includes('server') ? null : value.build };
  }
  try {
    preflight(value, noBuild);
    for (const unit of value.units) await assertPortFree(unit.port, unit.host);
  } catch (error) {
    // Two simultaneous clicks can race the port probe before the winner publishes its record.
    for (let attempt = 0; attempt < 10; attempt++) {
      await delay(50);
      if ((await inspectRunning(value)).length) return start(value, { noBuild, check });
    }
    throw error;
  }
  console.log(`Mode: ${value.mode}`);
  for (const url of value.urls) console.log(`  ${url}`);
  for (const unit of value.units) {
    if (unit.host !== '0.0.0.0' && unit.host !== '::') continue;
    const addresses = lanAddresses();
    if (!addresses.length) continue;
    const prefix = unit.key === 'server' ? unit.env.BASE_PATH || '' : '';
    const paths = [`${prefix}/`];
    console.log(`LAN (${unit.key}): bound to ${unit.host}, reachable from other devices on this network`);
    for (const address of addresses) console.log(`  ${paths.map((path) => `http://${address}:${unit.port}${path}`).join('  ')}`);
  }
  const serverUnit = value.units.find((unit) => unit.key === 'server');
  if (serverUnit) {
    console.log(`Data: ${serverUnit.env.DATA_DIR}`);
    console.log('Admin console: see the server startup log for the generated security path.');
    console.log(`New database registration default: ${serverUnit.env.REGISTRATION_MODE}; existing database policy is retained.`);
    const insecureHttp = serverUnit.env.ALLOW_INSECURE_HTTP === '1';
    console.log(insecureHttp
      ? 'Plain HTTP is enabled for LAN clients (ALLOW_INSECURE_HTTP=1): browser and admin Cookie sessions work over HTTP on trusted private networks only.'
      : 'Remote browser/admin access requires trusted HTTPS. LAN HTTP does not grant browser Cookie sessions.');
  }
  if (check) { console.log('Preflight passed. No build, service, or data directory was created.'); return 0; }
  const stateDir = join(value.directory, '.runtime/launchers');
  mkdirSync(stateDir, { recursive: true });
  const id = randomBytes(16).toString('hex');
  const token = randomBytes(32).toString('hex');
  const children = new Map();
  const files = [];
  let ending = false;
  let phase = 'starting';
  let finish;
  const finished = new Promise((done) => { finish = done; });
  let shutdownTask;
  const shutdown = (code = 0) => shutdownTask ??= (async () => {
    ending = true;
    phase = 'stopping';
    await Promise.all([...children.values()].map(({ child, graceful }) => terminate(child, graceful)));
    finish(code);
  })();
  const control = createServer(async (req, res) => {
    const supplied = Buffer.from(String(req.headers['x-zichan-launcher'] || ''));
    if (supplied.length !== token.length || !timingSafeEqual(supplied, Buffer.from(token))) { res.writeHead(403); res.end(); return; }
    if (req.method === 'GET' && req.url === '/status') {
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ id, root: value.directory, phase, units: value.units.map((unit) => ({ key: unit.key, fingerprint: fingerprint(unit) })) }));
      return;
    }
    if (req.method !== 'POST' || req.url !== '/stop') { res.writeHead(403); res.end(); return; }
    let text = '';
    try {
      for await (const chunk of req) { text += chunk; if (text.length > 1024) { res.writeHead(413); res.end(); return; } }
    } catch { res.destroy(); return; }
    let body;
    try { body = JSON.parse(text); } catch { res.writeHead(400); res.end(); return; }
    if (!body || !value.units.some((unit) => unit.key === body.key)) { res.writeHead(400); res.end(); return; }
    res.setHeader('Content-Type', 'application/json');
    // One invocation is one lifecycle: stopping one unit of 'all' stops its siblings too.
    res.end(JSON.stringify({ id, root: value.directory }), () => { void shutdown(); });
  });
  control.headersTimeout = 5000; control.requestTimeout = 5000;
  await new Promise((done, reject) => { control.once('error', reject); control.listen(0, '127.0.0.1', done); });
  const onSignal = () => { void shutdown(); };
  process.once('SIGINT', onSignal); process.once('SIGTERM', onSignal);
  try {
    for (const unit of value.units) {
      const file = join(stateDir, `${unit.key}.json`);
      if (existsSync(file)) {
        const old = JSON.parse(readFileSync(file, 'utf8'));
        if (old.root !== value.directory || !Number.isSafeInteger(old.pid) || old.pid < 1 || alive(old.pid)) throw new Error(`Another launcher is active or needs inspection: ${file}`);
        unlinkSync(file);
      }
      writeFileSync(file, JSON.stringify({ id, root: value.directory, pid: process.pid, controlPort: control.address().port, token }), { flag: 'wx', mode: 0o600 });
      files.push(file);
    }
    if (value.build && !noBuild) {
      const npmEntry = npmCli();
      const child = ownedSpawn(npmEntry, ['run', value.build], { cwd: value.directory, env: process.env });
      children.set('build', { child });
      const code = await child.completion;
      children.delete('build');
      if (code !== 0) { await shutdown(code); return code; }
    }
    if (ending) return await finished;
    preflight(value, noBuild);
    for (const unit of value.units) {
      await assertPortFree(unit.port, unit.host);
      if (ending) break;
      const child = ownedSpawn(unit.entry, unit.args, { cwd: unit.cwd, env: unit.env });
      children.set(unit.key, { child, graceful: unit.graceful });
      void child.completion.then((code) => { if (!ending) { console.log(`${unit.key} exited (${code}).`); void shutdown(code); } });
      if (unit.ready) {
        let ready = false;
        for (let attempt = 0; attempt < 120 && !ending; attempt++) {
          try { const response = await fetch(unit.ready, { signal: AbortSignal.timeout(1000) }); ready = response.ok; await response.body?.cancel(); } catch { /* Startup not ready. */ }
          if (ready) break;
          await delay(250);
        }
        if (!ready && !ending) throw new Error(`${unit.key} did not become ready in time.`);
        if (ready) console.log(`Ready: ${unit.ready}`);
      }
    }
    phase = 'running';
    return await finished;
  } catch (error) {
    // The exclusive record creation can also lose a race after both port probes succeeded.
    if (!files.length && !children.size && (await inspectRunning(value)).length) return await start(value, { noBuild, check });
    await shutdown(1);
    throw error;
  } finally {
    await shutdown();
    for (const file of files) {
      if (existsSync(file) && JSON.parse(readFileSync(file, 'utf8')).id === id) unlinkSync(file);
    }
    control.closeAllConnections();
    await new Promise((done) => control.close(done));
    process.removeListener('SIGINT', onSignal); process.removeListener('SIGTERM', onSignal);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const [command = 'start', mode = command === 'stop' ? 'all' : 'server', ...flags] = process.argv.slice(2);
  try {
    if (flags.some((flag) => !['--no-build', '--check'].includes(flag))) throw new Error('Supported flags: --no-build, --check');
    if (command === 'stop') await stop(mode);
    else if (command === 'start') process.exitCode = await start(plan(mode), { noBuild: flags.includes('--no-build'), check: flags.includes('--check') });
    else throw new Error('Use runner.mjs start|stop web|sync|server|desktop|all');
  } catch (error) { console.error(`[ERROR] ${error.message}`); process.exitCode = 1; }
}
