import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { spawnSync } from "node:child_process"
import test from "node:test"
import { fileURLToPath } from "node:url"
import { parseSettings } from "../dist/config/index.js"
import { authorizeHostEvent } from "../dist/host/event-policy.js"

const repository = fileURLToPath(new URL("../", import.meta.url))
const moduleUrl = name => new URL(`../dist/${name}.js`, import.meta.url).href

test("self protection cannot be downgraded by an audit wildcard", () => {
  const settings = parseSettings({ rules: [{ id: "all-audit", action: "audit" }] })
  assert.equal(
    authorizeHostEvent(settings, {
      kind: "self-protection",
      operation: "function-hook",
      target: "guard",
      action: "audit",
    }).action,
    "deny",
  )
})

test("导出的反射助手不能绕过即时监控，临时改动恢复后仍有审计，自保护不可降级", () => {
  const code = `
    import assert from "node:assert/strict";
    import fs from "node:fs";
    import {installRuntime} from ${JSON.stringify(moduleUrl("runtime/index"))};
    import {parseSettings} from ${JSON.stringify(moduleUrl("config/index"))};
    import {IntegrityMonitor} from ${JSON.stringify(moduleUrl("monitor/integrity"))};
    import {objectDefine,objectFreeze,claimReflectionHooks} from ${JSON.stringify(moduleUrl("protect/intrinsics"))};
    import {seal,freezeData} from ${JSON.stringify(moduleUrl("protect/objects"))};
    const settings=parseSettings({protect:{targets:["Demo.fn"]}});
    const runtime=installRuntime({settings,identity:{id:"exported-reflection",generation:1,kind:"yunzai",pid:process.pid,originPlugin:"demo",observability:"js-entrypoints"},emit(){}});
    const create=()=>{
      const events=[],object={fn(){return "original"}};
      const monitor=new IntegrityMonitor(settings,{Demo:object},event=>events.push(event),runtime.watch);
      monitor.capture();
      return {object,events,monitor};
    };
    const probe=create();
    const original=Object.getOwnPropertyDescriptor(probe.object,"fn");
    objectDefine(probe.object,"fn",{...original,value(){return "changed"}});
    assert.equal(probe.object.fn(),"changed");
    objectDefine(probe.object,"fn",original);
    probe.monitor.check();
    assert.equal(probe.events.length,2);
    assert.ok(probe.events.every(event=>event.operation==="protected-target-change"&&event.details.detection==="during-call"));
    probe.monitor.stop();
    for(const mutate of [objectFreeze,freezeData,object=>seal(object,"fn",()=>"sealed")]){
      const probe=create();
      mutate(probe.object);
      assert.ok(probe.events.some(event=>event.operation==="protected-target-change"&&event.details.detection==="during-call"));
      probe.monitor.stop();
    }
    assert.throws(()=>objectDefine(fs,"writeFileSync",{value(){}}),{code:"ERR_GUARD_SELF_PROTECTION"});
    assert.throws(()=>claimReflectionHooks(),{code:"ERR_GUARD_SELF_PROTECTION"});
    assert.throws(()=>objectFreeze(fs.writeFileSync),{code:"ERR_GUARD_SELF_PROTECTION"});
    assert.throws(()=>freezeData(IntegrityMonitor.prototype),{code:"ERR_GUARD_SELF_PROTECTION"});
  `
  const result = spawnSync(process.execPath, ["--input-type=module", "-e", code], {
    encoding: "utf8",
    windowsHide: true,
    timeout: 15000,
  })
  assert.equal(result.status, 0, `${result.error ?? ""}${result.stderr}`)
})

test("自保护启用后 promisify 保留子进程结果、重复转换及拒绝规则", () => {
  for (const action of ["audit", "deny"]) {
    const code = `
      import assert from "node:assert/strict";
      import childProcess from "node:child_process";
      import {promisify} from "node:util";
      import {installRuntime} from ${JSON.stringify(moduleUrl("runtime/index"))};
      import {parseSettings} from ${JSON.stringify(moduleUrl("config/index"))};
      const events=[];
      const runtime=installRuntime({settings:parseSettings({rules:[{id:"commands",kind:"process",action:${JSON.stringify(action)}}]}),identity:{id:"promisify-test",generation:1,kind:"yunzai",pid:process.pid,originPlugin:"demo",observability:"js-entrypoints"},emit:event=>events.push(event)});
      for (const name of ["exec", "execFile"]) {
        const copy=childProcess[name][promisify.custom];
        Object.defineProperty(copy,promisify.custom,{value:()=>Promise.resolve({stdout:"bypass"})});
        const run=promisify(childProcess[name]);
        assert.equal(promisify(run),run);
        assert.throws(()=>Object.defineProperty(childProcess[name],promisify.custom,{value(){}}),{code:"ERR_GUARD_SELF_PROTECTION"});
        if (${JSON.stringify(action)} === "deny") {
          await assert.rejects(run("unused-command"),{code:"GUARD_DENIED"});
        } else {
          const args=name==="exec"?['"'+process.execPath+'" --version']:[process.execPath,["--version"]];
          const pending=run(...args);
          assert.ok(pending.child?.pid);
          assert.equal((await pending).stdout.trim(),process.version);
        }
        assert.equal(Object.isFrozen(childProcess[name]),true);
        assert.ok(events.some(event=>event.operation===name&&event.action===${JSON.stringify(action)}));
      }
      runtime.instrumentation.checkIntegrity();
      assert.equal(events.some(event=>event.operation==="instrumentation-change"),false);
    `
    const result = spawnSync(process.execPath, ["--input-type=module", "-e", code], {
      encoding: "utf8",
      windowsHide: true,
      timeout: 15000,
    })
    assert.equal(result.status, 0, `${action}: ${result.error ?? ""}${result.stderr}`)
  }
})

test("installed runtime keeps business hooks while sealing Guard files, methods and cleanup handles", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "guard-self-runtime-"))
  const sentinelDirectory = fs.mkdtempSync(path.join(repository, "tests/runs/self-runtime-"))
  const sentinel = path.join(sentinelDirectory, "unchanged.txt")
  fs.writeFileSync(sentinel, "original")
  const code = `
    import assert from "node:assert/strict";
    import fs from "node:fs";
    import inspector from "node:inspector";
    import v8 from "node:v8";
    import {Worker} from "node:worker_threads";
    import {installRuntime,installInheritedRuntime} from ${JSON.stringify(moduleUrl("runtime/index"))};
    import {parseSettings} from ${JSON.stringify(moduleUrl("config/index"))};
    import {IntegrityMonitor} from ${JSON.stringify(moduleUrl("monitor/integrity"))};
    const events=[];
    const settings=parseSettings({protect:{targets:["Demo.fn"]},rules:[{id:"audit",action:"audit"}]});
    const runtime=installRuntime({settings,identity:{id:"self-test",generation:1,kind:"yunzai",pid:process.pid,originPlugin:"demo",observability:"js-entrypoints"},emit:e=>events.push(e)});
    const denied=fn=>assert.throws(fn,e=>e.code==="ERR_GUARD_SELF_PROTECTION");
    denied(()=>fs.writeFileSync(${JSON.stringify(sentinel)},"tampered"));
    denied(()=>{fs.writeFileSync=()=>{}});
    denied(()=>{IntegrityMonitor.prototype.check=()=>{}});
    denied(()=>Object.defineProperty(IntegrityMonitor.prototype,"check",{value:()=>{}}));
    denied(()=>Reflect.deleteProperty(IntegrityMonitor.prototype,"check"));
    denied(()=>{Object.defineProperty=()=>{}});
    denied(()=>inspector.open(0,"127.0.0.1"));
    denied(()=>new inspector.Session().connect());
    denied(()=>v8.getHeapSnapshot());
    denied(()=>process.kill(process.pid,"SIGUSR1"));
    assert.equal(inspector.url(),undefined);
    assert.equal(Object.isFrozen(fs.writeFileSync),true);
    assert.deepEqual(Object.keys(installInheritedRuntime()).sort(),["identity","ready"]);
    denied(()=>installRuntime({}));
    assert.equal(Object.isFrozen(globalThis[Symbol.for("yunzai.guard.runtime.v1")].settings.rules),true);
    const {NativeRegistrationBudget}=await import(${JSON.stringify(moduleUrl("native-sandbox/registrations"))});
    assert.equal(Object.isFrozen(NativeRegistrationBudget.prototype),true);
    const demo={fn(){return 1}};
    const monitor=new IntegrityMonitor(settings,{Demo:demo},e=>events.push(e),runtime.watch);
    monitor.capture();
    const original=demo.fn;
    Object.defineProperty(demo,"fn",{...Object.getOwnPropertyDescriptor(demo,"fn"),value(){return 2}});
    assert.equal(demo.fn(),2);
    Object.defineProperty(demo,"fn",{...Object.getOwnPropertyDescriptor(demo,"fn"),value:original});
    assert.ok(events.some(e=>e.operation==="protected-target-change"&&e.details.detection==="during-call"));
    demo.fn=()=>3;
    assert.equal(demo.fn(),3);
    fs.writeFileSync("business.txt","allowed");
    const close=fs.close,closeSync=fs.closeSync;
    fs.close=function(...args){return Reflect.apply(close,this,args)};
    fs.closeSync=function(...args){return Reflect.apply(closeSync,this,args)};
    fs.closeSync(fs.openSync("business.txt","r"));
    const copy=Object.defineProperties({},Object.getOwnPropertyDescriptors(fs));
    const originalWrite=fs.writeFileSync;
    copy.writeFileSync=function(...args){return Reflect.apply(originalWrite,this,args)};
    assert.notEqual(copy.writeFileSync,fs.writeFileSync);
    copy.writeFileSync("business-copy.txt","allowed");
    denied(()=>copy.writeFileSync(${JSON.stringify(sentinel)},"bad"));
    assert.equal(Reflect.set(fs,"writeFileSync",()=>"copy",copy),true);
    assert.equal(copy.writeFileSync(),"copy");
    assert.equal(fs.writeFileSync,originalWrite);
    denied(()=>Reflect.set(fs,"writeFileSync",()=>{},fs));
    const worker=new Worker(
      'const fs=require("node:fs");const {parentPort}=require("node:worker_threads");let code;try{fs.writeFileSync('+${JSON.stringify(JSON.stringify(sentinel))}+',"bad")}catch(e){code=e.code}parentPort.postMessage(code)',
      {eval:true,execArgv:[]});
    const workerResult=await new Promise((resolve,reject)=>{worker.once("message",resolve);worker.once("error",reject)});
    assert.equal(workerResult,"ERR_GUARD_SELF_PROTECTION");
    await new Promise(resolve=>worker.exitCode!==undefined?resolve():worker.once("exit",resolve));
    runtime.instrumentation();
    denied(()=>fs.writeFileSync(${JSON.stringify(sentinel)},"still denied"));
    console.log(JSON.stringify({blocked:events.filter(e=>e.kind==="self-protection").length}));
  `
  try {
    const result = spawnSync(process.execPath, ["--input-type=module", "-e", code], {
      cwd: directory,
      encoding: "utf8",
      windowsHide: true,
      timeout: 25000,
    })
    assert.equal(result.status, 0, `${result.error ?? ""}${result.stderr}`)
    assert.equal(fs.readFileSync(sentinel, "utf8"), "original")
    assert.equal(fs.readFileSync(path.join(directory, "business.txt"), "utf8"), "allowed")
    assert.ok(JSON.parse(result.stdout.trim()).blocked >= 6)
  } finally {
    assert.equal(path.dirname(directory), fs.realpathSync.native(os.tmpdir()))
    assert.equal(path.dirname(sentinelDirectory), path.join(repository, "tests/runs"))
    fs.rmSync(directory, { recursive: true, force: true })
    fs.rmSync(sentinelDirectory, { recursive: true, force: true })
  }
})

test("builtin poisoning cannot disable Guard denial or business hook observation", () => {
  const directory = fs.mkdtempSync(path.join(repository, "tests/runs/self-poison-"))
  const sentinel = path.join(directory, "unchanged.txt")
  fs.writeFileSync(sentinel, "original")
  const code = `
    import assert from "node:assert/strict";
    import fs from "node:fs";
    import {installRuntime} from ${JSON.stringify(moduleUrl("runtime/index"))};
    import {parseSettings} from ${JSON.stringify(moduleUrl("config/index"))};
    import {IntegrityMonitor} from ${JSON.stringify(moduleUrl("monitor/integrity"))};
    import {jsonParse,jsonStringify} from ${JSON.stringify(moduleUrl("protect/intrinsics"))};
    import {runtimeEventDecision,runtimeFailureDecision} from ${JSON.stringify(moduleUrl("runtime/policy"))};
    const events=[];
    const settings=parseSettings({protect:{targets:["Demo.fn"]},rules:[{id:"audit",kind:["*"],action:"audit"}]});
    const runtime=installRuntime({settings,identity:{id:"poison-test",generation:1,kind:"yunzai",pid:process.pid,originPlugin:"demo",observability:"js-entrypoints"},emit:event=>{events[events.length]=event}});
    const original=()=>1;
    const demo={fn:original};
    const monitor=new IntegrityMonitor(settings,{Demo:demo},event=>{events[events.length]=event},runtime.watch);
    monitor.capture();
    const copy=Object.defineProperties({},Object.getOwnPropertyDescriptors(fs));
    const originalWrite=fs.writeFileSync;
    const restrictive=parseSettings({rules:[{id:"deny-command",kind:["process"],operation:"exec",target:"sh *",action:"deny"}]});
    const patches=[];
    const add=(object,names)=>{for(let i=0;i<names.length;i++)patches[patches.length]=[object,names[i],object[names[i]]];};
    add(Array.prototype,["some","map","every","filter","flatMap","includes","find","push",Symbol.iterator]);
    add(Map.prototype,["get","set","has","delete","clear","forEach"]);
    add(Set.prototype,["has","add","delete","forEach"]);
    add(WeakMap.prototype,["get","set","has","delete"]);
    add(WeakSet.prototype,["has","add"]);
    add(Object,["entries","values","keys","getOwnPropertyDescriptor"]);
    add(JSON,["parse","stringify"]);
    add(Reflect,["apply"]);
    add(String.prototype,["startsWith","endsWith","slice","split","toLowerCase"]);
    const poisoned=()=>{throw new Error("business replacement reached")};
    let blocked=0,serialized=false,business=false,copyWorks=false,policies=false,unexpected;
    const denied=fn=>{try{fn()}catch(error){if(error.code==="ERR_GUARD_SELF_PROTECTION"){blocked++;return}throw error}throw new Error("protected operation was allowed")};
    try {
      for(let i=0;i<patches.length;i++)patches[i][0][patches[i][1]]=poisoned;
      denied(()=>fs.writeFileSync(${JSON.stringify(sentinel)},"tampered"));
      denied(()=>{fs.writeFileSync=()=>{}});
      denied(()=>{IntegrityMonitor.prototype.check=()=>{}});
      denied(()=>Object.defineProperty(IntegrityMonitor.prototype,"check",{value(){}}));
      denied(()=>Reflect.deleteProperty(IntegrityMonitor.prototype,"check"));
      copy.writeFileSync=()=>"copy";
      copyWorks=copy.writeFileSync()==="copy" && fs.writeFileSync===originalWrite;
      Object.defineProperty(demo,"fn",{value:()=>2});
      business=demo.fn()===2;
      demo.fn=original;monitor.check();demo.fn=()=>3;monitor.check();
      serialized=jsonParse(jsonStringify({value:7})).value===7;
      policies=runtimeEventDecision(settings,{kind:"self-protection",operation:"function-hook",target:"guard",action:"audit"}).action==="deny"
        &&runtimeEventDecision(restrictive,{kind:"process",operation:"exec",target:"sh",action:"deny",ruleId:"deny-command",details:{argumentsRedacted:true}}).action==="deny"
        &&runtimeFailureDecision(restrictive,{kind:"runtime",operation:"runtime-bootstrap-failed",target:"guard"}).action==="deny";
    } catch(error) { unexpected=error; }
    finally { for(let i=patches.length-1;i>=0;i--)patches[i][0][patches[i][1]]=patches[i][2]; }
    if(unexpected)throw unexpected;
    // 原型上的描述符字段和数字索引不能污染 Guard 内部数据。
    const descriptor=Object.create(null);
    descriptor.configurable=true;descriptor.set=poisoned;
    Object.defineProperty(Array.prototype,"0",descriptor);
    try {
      Object.prototype.get=poisoned;
      Object.prototype.value=poisoned;
      Object.prototype.before=poisoned;
      denied(()=>fs.writeFileSync(${JSON.stringify(sentinel)},"prototype tampered"));
      denied(()=>Object.defineProperty(IntegrityMonitor.prototype,"check",{value(){}}));
      monitor.check();
    } finally {
      delete Object.prototype.get;
      delete Object.prototype.value;
      delete Object.prototype.before;
      delete Array.prototype[0];
    }
    assert.equal(blocked,7);
    assert.equal(business,true);
    assert.equal(copyWorks,true);
    assert.equal(serialized,true);
    assert.equal(policies,true);
    assert.ok(events.some(event=>event.operation==="protected-target-change"&&event.action==="audit"&&event.details.detection==="during-call"));
    assert.ok(events.some(event=>event.operation==="protected-target-change"&&event.details.detection==="after-change"));
    assert.ok(events.some(event=>event.kind==="self-protection"&&event.details.blocked));
    console.log("builtin poisoning rejected");
  `
  try {
    const result = spawnSync(process.execPath, ["--input-type=module", "-e", code], {
      encoding: "utf8",
      windowsHide: true,
      timeout: 20000,
    })
    assert.equal(result.status, 0, `${result.error ?? ""}${result.stderr}`)
    assert.match(result.stdout, /builtin poisoning rejected/)
    assert.equal(fs.readFileSync(sentinel, "utf8"), "original")
  } finally {
    assert.equal(path.dirname(directory), path.join(repository, "tests/runs"))
    fs.rmSync(directory, { recursive: true, force: true })
  }
})
