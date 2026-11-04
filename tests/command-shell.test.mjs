import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import test from "node:test"

const moduleUrl = name => new URL(`../dist/${name}.js`, import.meta.url).href
const windows = process.platform === "win32"

function probe(t, body) {
  const temporaryRoot = fs.realpathSync(os.tmpdir())
  const directory = fs.mkdtempSync(path.join(temporaryRoot, "guard-command-shell-"))
  t.after(() => {
    const absolute = fs.realpathSync(directory)
    assert.equal(path.dirname(absolute), temporaryRoot)
    assert.ok(path.basename(absolute).startsWith("guard-command-shell-"))
    fs.rmSync(absolute, { recursive: true, force: true })
  })
  fs.writeFileSync(path.join(directory, "echo"), "// harmless syntax-check fixture\n")
  fs.writeFileSync(path.join(directory, "cmd.exe"), "invalid fixture executable\n")
  fs.writeFileSync(path.join(directory, "preload.cjs"), 'console.log("UNEXPECTED_COMSPEC_JS")\n')
  const code = `
    import assert from "node:assert/strict";
    import cp from "node:child_process";
    import path from "node:path";
    import {promisify} from "node:util";
    import {once} from "node:events";
    import {installRuntime} from ${JSON.stringify(moduleUrl("runtime/index"))};
    import {snapshotLaunch,prepareNodeLaunch} from ${JSON.stringify(moduleUrl("runtime/launch"))};
    import {analyzeCommand} from ${JSON.stringify(moduleUrl("protect/command-analysis"))};
    import {snapshotCommandShell,isImplicitSystemShell} from ${JSON.stringify(moduleUrl("protect/command-shell"))};
    import {parseSettings} from ${JSON.stringify(moduleUrl("config/index"))};
    const directory=${JSON.stringify(directory)};
    const systemCmd=path.win32.join(process.env.SystemRoot||"C:\\Windows","System32","cmd.exe");
    process.env.ComSpec=systemCmd;
    const events=[];
    let onContext,onEmit;
    installRuntime({settings:parseSettings({protect:{enabled:false}}),stateDir:path.join(directory,"state"),identity:{id:"shell-fixture",kind:"yunzai",generation:1,pid:process.pid,originPlugin:"fixture",observability:"js-entrypoints"},contextProvider:()=>{onContext?.();return "fixture"},emit:event=>{events.push(event);onEmit?.(event)}});
    const options={cwd:directory,encoding:"utf8",windowsHide:true,env:{SystemRoot:process.env.SystemRoot,PATH:path.dirname(process.execPath)+";"+path.join(process.env.SystemRoot,"System32"),ComSpec:systemCmd,NODE_OPTIONS:"--require "+JSON.stringify(path.join(directory,"preload.cjs"))}};
    const denied=call=>assert.throws(call,{code:"GUARD_DENIED"});
    ${body}
    console.log("completed");
  `
  const result = spawnSync(process.execPath, ["--input-type=module", "-e", code], {
    cwd: directory,
    env: { ...process.env, NODE_OPTIONS: "" },
    windowsHide: true,
    encoding: "utf8",
    timeout: 20000,
  })
  assert.equal(result.status, 0, `${result.error ?? ""}${result.stderr}`)
  assert.equal(result.stdout.trim(), "completed")
}

test("Windows 自定义 ComSpec 在所有隐式 shell 入口执行前拒绝", { skip: !windows }, t => {
  probe(
    t,
    `
      process.env.ComSpec=process.execPath;
      denied(()=>cp.execSync("echo",options));
      denied(()=>cp.execFileSync("echo",[],{...options,shell:true}));
      denied(()=>cp.spawnSync("echo",[],{...options,shell:true}));
      denied(()=>cp.exec("echo",options,()=>assert.fail("blocked callback")));
      denied(()=>cp.execFile("echo",[],{...options,shell:true},()=>assert.fail("blocked callback")));
      denied(()=>cp.spawn("echo",[],{...options,shell:true}));
      await assert.rejects(promisify(cp.exec)("echo",options),{code:"GUARD_DENIED"});
      await assert.rejects(promisify(cp.execFile)("echo",[],{...options,shell:true}),{code:"GUARD_DENIED"});
      for(const shell of ["node.exe","cmd","relative/custom.exe"]){process.env.ComSpec=shell;denied(()=>cp.execSync("echo",options));}
      assert.ok(events.some(event=>event.details?.scriptExecution===true&&event.action==="deny"));
    `,
  )
})

test("Windows 默认 cmd 快照不受归因回调、审计回调或 cwd 同名程序影响", { skip: !windows }, t => {
  probe(
    t,
    `
      const swap=()=>{process.env.ComSpec=process.execPath};
      onContext=swap;
      assert.equal(cp.execSync("echo context-fixed",options).trim(),"context-fixed");
      process.env.ComSpec=systemCmd;onContext=undefined;onEmit=swap;
      const sync=cp.spawnSync("echo",["spawn-fixed"],{...options,shell:true});
      assert.equal(sync.status,0);assert.equal(sync.stdout.trim(),"spawn-fixed");
      process.env.ComSpec=systemCmd;onEmit=undefined;onContext=swap;
      assert.equal(await new Promise((resolve,reject)=>cp.exec("echo callback-fixed",options,(error,out)=>error?reject(error):resolve(out.trim()))),"callback-fixed");
      process.env.ComSpec=systemCmd;
      assert.equal((await promisify(cp.exec)("echo promise-fixed",options)).stdout.trim(),"promise-fixed");
      process.env.ComSpec=systemCmd;
      const child=cp.spawn("echo",["async-fixed"],{...options,shell:true});
      let output="";child.stdout.on("data",chunk=>output+=chunk);
      assert.equal((await once(child,"close"))[0],0);assert.equal(output.trim(),"async-fixed");
      onContext=undefined;
      for(const shell of [undefined,"cmd.exe","CMD.EXE"]){
        if(shell===undefined)delete process.env.ComSpec;else process.env.ComSpec=shell;
        assert.equal(cp.execSync("echo trusted-fallback",options).trim(),"trusted-fallback");
      }
      assert.ok(events.some(event=>event.kind==="process"&&event.operation==="exec"&&event.action==="audit"));
    `,
  )
})

test("默认 cmd 来源只随私有快照传播，修改 shell 或伪造属性不能豁免", { skip: !windows }, t => {
  probe(
    t,
    `
      const first=snapshotLaunch("execSync",["echo safe",options]);
      assert.equal(first[1].shell,systemCmd);
      assert.equal(analyzeCommand("execSync",first).script,false);
      const prepared=prepareNodeLaunch("execSync",first,{runtimeId:"fixture",originPlugin:()=>"fixture"});
      assert.equal(analyzeCommand("execSync",prepared).script,false);
      const cloned={...prepared[1]};
      assert.equal(analyzeCommand("execSync",["echo safe",cloned]).script,true);
      assert.equal(analyzeCommand("execSync",snapshotLaunch("execSync",["echo safe",cloned])).script,false);
      const changed={...prepared[1],shell:process.execPath,implicitSystemShell:true};
      assert.equal(analyzeCommand("execSync",snapshotLaunch("execSync",["echo safe",changed])).script,true);
      const forged={...options,shell:systemCmd,implicitSystemShell:true};
      assert.equal(analyzeCommand("execSync",snapshotLaunch("execSync",["echo safe",forged])).script,true);
      denied(()=>cp.execSync("echo safe",forged));
      let reads=0;
      const hostile={env:options.env,get shell(){return ++reads===1?systemCmd:process.execPath},set shell(_value){}};
      snapshotCommandShell("execSync",hostile,first[1]);
      assert.equal(isImplicitSystemShell(hostile,process.execPath),false);
      assert.equal(analyzeCommand("execSync",snapshotLaunch("execSync",["echo safe",hostile])).script,true);
    `,
  )
})
