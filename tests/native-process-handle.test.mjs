import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { spawnSync } from "node:child_process"
import test from "node:test"

test("原生子进程句柄不能绕过永久保护，正常入口与诊断回调保持可用", { timeout: 30000 }, t => {
  const temporary = fs.realpathSync(os.tmpdir())
  const directory = fs.mkdtempSync(path.join(temporary, "guard-native-process-"))
  t.after(() => {
    assert.equal(path.dirname(fs.realpathSync(directory)), temporary)
    assert.ok(path.basename(directory).startsWith("guard-native-process-"))
    fs.rmSync(directory, { recursive: true, force: true })
  })
  const runtime = new URL("../dist/runtime/index.js", import.meta.url).href
  const config = new URL("../dist/config/index.js", import.meta.url).href
  const source = `
    import assert from 'node:assert/strict';
    import cp from 'node:child_process';
    import diagnostics from 'node:diagnostics_channel';
    import {once} from 'node:events';
    import {installRuntime} from ${JSON.stringify(runtime)};
    import {parseSettings} from ${JSON.stringify(config)};
    const cachedSpawn=cp.ChildProcess.prototype.spawn;
    const events=[];
    const guard=installRuntime({settings:parseSettings({rules:[{id:'allow-all',action:'audit'}]}),identity:{id:'native-process',generation:1,kind:'yunzai',pid:process.pid,originPlugin:'probe',observability:'js-entrypoints'},emit:event=>events.push(event)});
    const refused=call=>assert.throws(call,{code:'ERR_GUARD_SELF_PROTECTION'});
    const raw=async()=>{
      const child=new cp.ChildProcess();
      try {
        const exited=once(child,'exit');
        assert.equal(child._handle.spawn(process.execPath,[process.execPath,'--version'],process.cwd(),[],[{type:'ignore'},{type:'ignore'},{type:'ignore'}],0,undefined,undefined),0);
        assert.equal((await exited)[0],0);
      } finally { child._handle?.close() }
      const cached=new cp.ChildProcess(),closed=once(cached,'close');
      cachedSpawn.call(cached,{file:process.execPath,args:[process.execPath,'--version'],stdio:['ignore','ignore','ignore']});assert.equal((await closed)[0],0);
      const target=new cp.ChildProcess();
      try{refused(()=>target._handle.spawn('rm',['rm','-rf',process.cwd()+'/data/yunzai-guard'],process.cwd(),[],[{type:'ignore'},{type:'ignore'},{type:'ignore'}],0,undefined,undefined));assert.throws(()=>target._handle.spawn({}),{name:'TypeError'})}finally{target._handle?.close()}
    };
    await raw();
    let intercepted=0,nested;
    const channel=diagnostics.channel('tracing:child_process.spawn:start');
    const subscriber=({process:child,options})=>{
      assert.throws(()=>child._handle.spawn(options.file,options.args,options.cwd,options.envPairs,options.stdio,0,options.uid,options.gid),{name:'TypeError'});
      intercepted++;
      if(intercepted===1)nested=once(cp.spawn(process.execPath,['--version'],{stdio:'ignore'}),'close');
    };
    channel.subscribe(subscriber);
    try {
      const child=cp.spawn(process.execPath,['--version']);
      let output='';child.stdout.on('data',chunk=>output+=chunk);
      assert.equal((await once(child,'close'))[0],0);
      assert.equal(output.trim(),process.version);
      assert.ok(intercepted>0);
      assert.equal((await nested)[0],0);
    } finally { channel.unsubscribe(subscriber) }
    assert.equal(cp.execSync('echo normal-native',{encoding:'utf8'}).trim(),'normal-native');
    guard.instrumentation();
    await raw();
    assert.equal(cp.execFileSync(process.execPath,['--version'],{encoding:'utf8'}).trim(),process.version);
    assert.ok(events.some(event=>event.kind==='self-protection'&&event.operation==='spawn'));
    console.log('native-process-protection-ok');
  `
  const entry = path.join(directory, "probe.mjs")
  fs.writeFileSync(entry, source)
  const result = spawnSync(process.execPath, [entry], {
    cwd: directory,
    encoding: "utf8",
    windowsHide: true,
    timeout: 20000,
  })
  assert.equal(result.status, 0, `${result.error ?? ""}${result.stderr}`)
  assert.equal(result.stdout.trim(), "native-process-protection-ok")
})
