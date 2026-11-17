import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, readFile, readdir, rm, symlink, unlink, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { test } from 'node:test';
import { prepareImageUpgrade } from '../../../scripts/production/prepare-image-upgrade.mjs';

const options = { skip: process.platform === 'win32' && 'requires Linux directory symlinks' };
const launcher = resolve(import.meta.dirname, '../../../apps/sync-server/scripts/update-launcher.mjs');
test('delivered Compose executes exactly the tested helper after Compose interpolation', {
  skip: !process.env.ZICHAN_TEST_COMPOSE_CONFIG && 'requires Docker Compose normalization',
}, async () => {
  const config = JSON.parse(await readFile(process.env.ZICHAN_TEST_COMPOSE_CONFIG, 'utf8'));
  const service = config.services['sync-server'];
  const script = service.command[0];
  const start = script.indexOf("<<'ZICHAN_IMAGE_UPGRADE'\n") + "<<'ZICHAN_IMAGE_UPGRADE'\n".length;
  const end = script.indexOf('\nZICHAN_IMAGE_UPGRADE\n', start);
  const helper = await readFile(resolve(import.meta.dirname, '../../../scripts/production/prepare-image-upgrade.mjs'), 'utf8');
  assert.equal(script.slice(start, end).trimEnd(), helper.trimEnd());
  assert.equal(service.image, 'ghcr.io/602star/zichan-sync@sha256:08327e85bed57223e69f476e69e0fd3c1cf3bf56f3fd65525db3e655b0d1daa5');
  assert.equal(service.environment.DATA_DIR, '/state/server');
  assert.equal(service.volumes[0].target, '/state');
});
const serverSource = `
import { createServer } from 'node:http';
import { readFile, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
const { version } = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));
if (version === '0.7.0') {
  if (process.env.FAIL_NEW_SERVER === '1') throw new Error('injected new server failure');
  await readFile(join(process.env.DATA_DIR, 'backup-verified'));
}
const pid = join(process.env.DATA_DIR, 'server.pid');
await writeFile(pid, String(process.pid));
const server = createServer((req,res) => {
  res.setHeader('content-type', 'application/json');
  res.end(JSON.stringify({ok: true, version}));
});
server.listen(Number(process.env.PORT), '127.0.0.1');
process.on('SIGTERM', () => server.close(async () => { await rm(pid, {force:true}); process.exit(0); }));
`;
const maintenanceSource = `
import { copyFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
const args=process.argv.slice(2), option=(key)=>args[args.indexOf('--'+key)+1];
const data=option('data-dir'), backup=option(args[0]==='backup'?'output':'backup');
if (args[0]==='backup') {
  if (await readFile(join(data,'server.pid'),'utf8').catch(()=>'')) throw new Error('server is still running');
  await mkdir(backup);
  for (const name of ['server-id','server.secret','data.txt']) await copyFile(join(data,name),join(backup,name));
  await writeFile(join(backup,'manifest.json'),'{}');
} else if (args[0]==='verify-backup') {
  if (process.env.FAIL_VERIFY==='1') throw new Error('injected backup verification failure');
  for (const name of ['server-id','server.secret','data.txt']) {
    if (await readFile(join(data,name),'utf8') !== await readFile(join(backup,name),'utf8')) throw new Error('backup mismatch');
  }
  await writeFile(join(data,'backup-verified'),'yes');
} else throw new Error('unexpected maintenance operation');
`;

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'zichan-image-upgrade-'));
  const runtime = join(root, 'runtime'), dataDir = join(root, 'data'), bootstrap = join(root, 'bootstrap');
  await mkdir(dataDir); await mkdir(join(root, 'backups'));
  for (const [name, data] of [['server-id','existing-server'],['server.secret','existing-secret'],['data.txt','existing account and attachments']]) {
    await writeFile(join(dataDir,name),data);
  }
  for (const [directory, version] of [[join(runtime,'releases','v0.6.0'),'0.6.0'],[bootstrap,'0.7.0']]) {
    await mkdir(join(directory,'dist'),{recursive:true});
    await writeFile(join(directory,'package.json'),JSON.stringify({version}));
    await writeFile(join(directory,'dist','server.mjs'),serverSource);
    await writeFile(join(directory,'dist','maintenance.mjs'),maintenanceSource);
  }
  await symlink('releases/v0.6.0',join(runtime,'current'),'dir');
  return { root, runtime, dataDir, bootstrap };
}

async function waitFor(check) {
  const until=Date.now()+20000; let last;
  while(Date.now()<until) { try { return await check(); } catch(error) { last=error; await new Promise(r=>setTimeout(r,100)); } }
  throw last || new Error('Timed out');
}

async function scenario(failure) {
  const f=await fixture(); let child; let completion; let output='';
  try {
    assert.equal(await prepareImageUpgrade(f),'prepared');
    const pending=JSON.parse(await readFile(join(f.runtime,'pending.json'),'utf8'));
    assert.equal(pending.from,'releases/v0.6.0');
    const portServer=createServer(); await new Promise(r=>portServer.listen(0,'127.0.0.1',r));
    const port=portServer.address().port; await new Promise(r=>portServer.close(r));
    child=spawn(process.execPath,[launcher],{env:{...process.env,PORT:String(port),DATA_DIR:f.dataDir,
      ZICHAN_UPDATE_RUNTIME_DIR:f.runtime,ADMIN_BACKUP_DIRECTORY:join(f.root,'backups'),ZICHAN_UPDATE_REQUIRE_BACKUP:'1',
      FAIL_VERIFY:failure==='backup'?'1':'0',FAIL_NEW_SERVER:failure==='startup'?'1':'0'},stdio:['ignore','pipe','pipe']});
    completion=new Promise(r=>child.once('exit',r));
    child.stdout.on('data',v=>output+=v); child.stderr.on('data',v=>output+=v);
    await waitFor(async()=>{
      const result=JSON.parse(await readFile(join(f.runtime,'update-result.json'),'utf8'));
      assert.equal(result.state,failure?'failed':'success',output);
      const response=await fetch('http://127.0.0.1:'+port+'/api/health',{signal:AbortSignal.timeout(1000)});
      assert.equal((await response.json()).version,failure?'0.6.0':'0.7.0',output);
    });
    for (const [name, expected] of [['server-id','existing-server'],['server.secret','existing-secret'],['data.txt','existing account and attachments']]) {
      assert.equal(await readFile(join(f.dataDir,name),'utf8'),expected);
      assert.equal(await readFile(join(f.root,'backups','pre-update-'+pending.taskId,name),'utf8'),expected);
    }
    const before=await readdir(join(f.root,'backups'));
    assert.equal(await prepareImageUpgrade(f),failure?'already-attempted':'already-current');
    assert.deepEqual(await readdir(join(f.root,'backups')),before);
  } finally {
    if(child) {
      child.kill('SIGTERM');
      const force=setTimeout(()=>child.kill('SIGKILL'),4000);
      await completion; clearTimeout(force);
    }
    await rm(f.root,{recursive:true,force:true});
  }
}

for (const failure of [undefined,'backup','startup']) {
  test('image bridge preserves data and identity: '+(failure||'success'),options,()=>scenario(failure));
}

test('refuses a wrong image before staging any pending operation',options,async()=>{
  const f=await fixture();
  try {
    await writeFile(join(f.bootstrap,'package.json'),JSON.stringify({version:'0.6.0'}));
    await assert.rejects(prepareImageUpgrade(f),/实际镜像不是/);
    await assert.rejects(readFile(join(f.runtime,'pending.json')),/ENOENT/);
    assert.equal(await readFile(join(f.dataDir,'data.txt'),'utf8'),'existing account and attachments');
  } finally {await rm(f.root,{recursive:true,force:true});}
});

test('preserves an existing pending task and an inactive version directory',options,async()=>{
  const f=await fixture();
  try {
    const pending=join(f.runtime,'pending.json');
    await writeFile(pending,'{"existing":"operation"}');
    assert.equal(await prepareImageUpgrade(f),'pending');
    assert.equal(await readFile(pending,'utf8'),'{"existing":"operation"}');
    await unlink(pending);
    const oldTarget=join(f.runtime,'releases','v0.7.0');
    await mkdir(oldTarget);await writeFile(join(oldTarget,'sentinel'),'old inactive program');
    assert.equal(await prepareImageUpgrade(f),'prepared');
    const kept=(await readdir(join(f.runtime,'releases'))).find(n=>n.startsWith('v0.7.0.before-'));
    assert.equal(await readFile(join(f.runtime,'releases',kept,'sentinel'),'utf8'),'old inactive program');
  } finally {await rm(f.root,{recursive:true,force:true});}
});

test('does not downgrade a later version on subsequent container recreation',options,async()=>{
  const f=await fixture();
  try {
    await unlink(join(f.runtime,'current'));
    await mkdir(join(f.runtime,'releases','v0.8.0'));
    await symlink('releases/v0.8.0',join(f.runtime,'current'),'dir');
    assert.equal(await prepareImageUpgrade(f),'already-current');
    await assert.rejects(readFile(join(f.runtime,'pending.json')),/ENOENT/);
  } finally {await rm(f.root,{recursive:true,force:true});}
});
