import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { spawnSync } from "node:child_process"
import test from "node:test"
import { fileURLToPath } from "node:url"

const repository = fileURLToPath(new URL("../", import.meta.url))
const moduleUrl = name => new URL(`../dist/${name}.js`, import.meta.url).href

function probe(t, body, settings = {}) {
  const temporaryRoot = fs.realpathSync(os.tmpdir())
  const directory = fs.mkdtempSync(path.join(temporaryRoot, "guard-command-probe-"))
  t.after(() => {
    const absolute = fs.realpathSync(directory)
    assert.equal(path.dirname(absolute), temporaryRoot)
    assert.ok(path.basename(absolute).startsWith("guard-command-probe-"))
    fs.rmSync(absolute, { recursive: true, force: true })
  })
  const state = path.join(directory, "data", "yunzai-guard")
  const sentinel = path.join(state, "unchanged.txt")
  const ordinary = path.join(directory, "ordinary.txt")
  const work = path.join(directory, "work area")
  fs.mkdirSync(state, { recursive: true })
  fs.mkdirSync(work)
  fs.writeFileSync(sentinel, "original")
  fs.writeFileSync(ordinary, "business")
  fs.writeFileSync(path.join(directory, "business.js"), "console.log('script-ran')\n")
  fs.writeFileSync(path.join(directory, "business.sh"), "#!/bin/sh\nprintf 'script-ran\\n'\n")
  fs.writeFileSync(path.join(directory, "without-extension"), "#!/bin/sh\nexit 0\n", {
    mode: 0o755,
  })
  let linked = false
  try {
    fs.symlinkSync(
      state,
      path.join(directory, "state-alias"),
      process.platform === "win32" ? "junction" : "dir",
    )
    linked = true
  } catch (error) {
    if (!["EPERM", "EACCES", "ENOTSUP"].includes(error.code)) throw error
  }
  const code = `
    import assert from "node:assert/strict";
    import childProcess from "node:child_process";
    import {promisify} from "node:util";
    import {once} from "node:events";
    import path from "node:path";
    import {pathToFileURL} from "node:url";
    import {installRuntime} from ${JSON.stringify(moduleUrl("runtime/index"))};
    import {parseSettings} from ${JSON.stringify(moduleUrl("config/index"))};
    const directory=${JSON.stringify(directory)},sentinel=${JSON.stringify(sentinel)},ordinary=${JSON.stringify(ordinary)},work=${JSON.stringify(work)},linked=${linked};
    const events=[];
    let onEmit,onContext;
    const runtime=installRuntime({settings:parseSettings(${JSON.stringify(settings)}),identity:{id:"command-probe",generation:1,kind:"yunzai",pid:process.pid,originPlugin:"command-fixture",observability:"js-entrypoints"},contextProvider:()=>onContext?.(),emit:event=>{events.push(event);onEmit?.(event)}});
    const denied=call=>assert.throws(call,{code:"ERR_GUARD_SELF_PROTECTION"});
    const quote=value=>'"'+value+'"';
    ${body}
    console.log(JSON.stringify({completed:true}));
  `
  const result = spawnSync(process.execPath, ["--input-type=module", "-e", code], {
    cwd: directory,
    encoding: "utf8",
    windowsHide: true,
    timeout: 20000,
  })
  assert.equal(result.status, 0, `${result.error ?? ""}${result.stderr}`)
  assert.equal(fs.readFileSync(sentinel, "utf8"), "original")
  assert.equal(fs.readFileSync(ordinary, "utf8"), "business")
  assert.equal(JSON.parse(result.stdout.trim().split(/\r?\n/).at(-1)).completed, true)
  return { directory, state }
}

test("普通 exec、spawn 和版本查询保持审计及原有异步返回语义", { timeout: 30000 }, t => {
  probe(
    t,
    `
    assert.equal(childProcess.execSync("echo guard-command-ok",{encoding:"utf8"}).trim(),"guard-command-ok");
    const sync=childProcess.spawnSync(process.execPath,["--version"],{encoding:"utf8"});
    assert.equal(sync.status,0);assert.equal(sync.stdout.trim(),process.version);
    assert.equal(childProcess.execFileSync(process.execPath,["--version"],{encoding:"utf8"}).trim(),process.version);
    const child=childProcess.spawn(process.execPath,["--version"]);
    let output="";child.stdout.on("data",chunk=>output+=chunk);
    assert.equal((await once(child,"close"))[0],0);assert.equal(output.trim(),process.version);
    await new Promise((resolve,reject)=>{
      const child=childProcess.exec("echo callback-ok",(error,stdout)=>{
        if(error)reject(error);else{try{assert.equal(stdout.trim(),"callback-ok");resolve()}catch(error){reject(error)}}
      });assert.ok(child.pid);
    });
    const pending=promisify(childProcess.execFile)(process.execPath,["--version"]);
    assert.ok(pending.child?.pid);assert.equal((await pending).stdout.trim(),process.version);
    const read=process.platform==="win32"?"type "+quote(${JSON.stringify(path.join(repository, "README.md"))}):"cat "+quote(${JSON.stringify(path.join(repository, "README.md"))});
    assert.ok(childProcess.execSync(read,{encoding:"utf8"}).includes("Yunzai"));
    assert.ok(events.some(event=>event.kind==="process"&&event.operation==="execSync"&&event.action==="audit"));
    assert.equal(events.some(event=>event.kind==="self-protection"),false);
  `,
  )
})

test("脚本、解释器内联代码、fork 与低层 spawn 默认审计且保持返回语义", { timeout: 30000 }, t => {
  probe(
    t,
    `
    assert.equal(childProcess.execFileSync(process.execPath,["business.js"],{encoding:"utf8"}).trim(),"script-ran");
    assert.equal(childProcess.spawnSync(process.execPath,["-p","1+1"],{encoding:"utf8"}).stdout.trim(),"2");
    assert.equal((await promisify(childProcess.execFile)(process.execPath,["business.js"])).stdout.trim(),"script-ran");
    assert.equal((await promisify(childProcess.exec)(quote(process.execPath)+" business.js")).stdout.trim(),"script-ran");
    const fork=childProcess.fork("business.js",[],{stdio:"ignore",execArgv:[]});assert.equal((await once(fork,"close"))[0],0);
    const spawned=childProcess.spawn(process.execPath,["business.js"],{stdio:"ignore"});assert.equal((await once(spawned,"close"))[0],0);
    const child=new childProcess.ChildProcess();
    child.spawn({file:process.execPath,args:[process.execPath,"business.js"],stdio:["ignore","ignore","ignore"]});assert.equal((await once(child,"close"))[0],0);
    assert.equal(events.some(event=>event.action==="deny"),false);
  `,
  )
})

test("参数、相对 cwd、重定向及文件修改目标均受固定自保护", { timeout: 30000 }, t => {
  probe(
    t,
    `
    for(const [program,args] of [
      ["rm",[sentinel]],
      ["touch",[sentinel]],
      ["truncate",["-s","0",sentinel]],
      ["tee",["-a",sentinel]],
      ["cp",[ordinary,sentinel]],
      ["mv",[ordinary,sentinel]],
      ["install",[ordinary,sentinel]],
      ["chmod",["600",sentinel]],
      ["chown",["0:0",sentinel]],
      ["sed",["-i","s/original/changed/",sentinel]],
      ["ln",[ordinary,path.join(directory,"data/yunzai-guard/new-link")]],
    ]){
      denied(()=>childProcess.spawnSync(program,args));
      denied(()=>childProcess.execFileSync(program,args));
    }
    denied(()=>childProcess.execSync("echo changed > "+quote(sentinel)));
    denied(()=>childProcess.exec("echo changed >> "+quote(sentinel),()=>assert.fail("blocked command callback")));
    denied(()=>childProcess.spawn("touch",[sentinel]));
    denied(()=>childProcess.execFile("touch",[sentinel]));
    await assert.rejects(promisify(childProcess.exec)("echo changed > "+quote(sentinel)),{code:"ERR_GUARD_SELF_PROTECTION"});
    await assert.rejects(promisify(childProcess.execFile)("touch",[sentinel]),{code:"ERR_GUARD_SELF_PROTECTION"});
    denied(()=>childProcess.spawnSync("touch",["../data/yunzai-guard/unchanged.txt"],{cwd:work}));
    denied(()=>childProcess.execSync("echo changed > ../data/yunzai-guard/unchanged.txt",{cwd:pathToFileURL(work+path.sep)}));
    if(linked)denied(()=>childProcess.spawnSync("touch",["state-alias/unchanged.txt"]));
    const read=process.platform==="win32"?"type "+quote(sentinel):"cat "+quote(sentinel);
    assert.equal(childProcess.execSync(read,{encoding:"utf8"}).trim(),"original");
    if(process.platform==="win32"){
      for(const [program,args] of [
        ["del",[sentinel]],["copy",[ordinary,sentinel]],["move",[ordinary,sentinel]],
        ["ren",[sentinel,"changed.txt"]],["attrib",["+R",sentinel]],["icacls",[sentinel,"/grant","Everyone:F"]],
      ])denied(()=>childProcess.spawnSync(program,args));
    }
    assert.ok(events.some(event=>event.kind==="self-protection"&&event.action==="deny"&&event.details?.blocked===true));
  `,
    {
      rules: [{ id: "allow-all", action: "audit" }],
      protect: { enabled: false, monitorInstrumentation: false },
    },
  )
})

test("显式脚本审计保留执行能力，监控卸载不解除命令文件自保护", { timeout: 30000 }, t => {
  probe(
    t,
    `
    assert.equal(childProcess.execFileSync(process.execPath,["-p","'explicit-script-ok'"],{encoding:"utf8"}).trim(),"explicit-script-ok");
    denied(()=>childProcess.spawnSync("touch",[sentinel]));
    const child=new childProcess.ChildProcess();
    try{denied(()=>child.spawn({file:"touch",args:["touch",sentinel],stdio:["ignore","ignore","ignore"]}))}finally{child._handle?.close()}
    runtime.instrumentation();
    denied(()=>childProcess.execSync("echo changed > "+quote(sentinel)));
    denied(()=>childProcess.spawnSync("cp",[ordinary,sentinel]));
    assert.equal(childProcess.execSync("echo after-dispose",{encoding:"utf8"}).trim(),"after-dispose");
  `,
    { rules: [{ id: "scripts-reviewed", kind: "process", action: "audit" }] },
  )
})

test("回调切换目录不能改变启动目标，卸载监控不增加脚本限制", { timeout: 30000 }, t => {
  const app = probe(
    t,
    `
    const originalCwd=process.cwd();
    let emitted=0,attributed=0;
    try{
      onEmit=()=>{emitted++;process.chdir(path.dirname(sentinel))};
      childProcess.execSync("echo emit-cwd > emit-business.txt");
      assert.ok(emitted>0,"audit callback must run after launch snapshot");
    }finally{onEmit=undefined;process.chdir(originalCwd)}
    try{
      onContext=()=>{attributed++;process.chdir(path.dirname(sentinel));return "command-fixture"};
      childProcess.execSync("echo context-cwd > context-business.txt");
      assert.ok(attributed>0,"attribution callback must run after launch snapshot");
    }finally{onContext=undefined;process.chdir(originalCwd)}
    runtime.instrumentation();
    assert.equal(childProcess.spawnSync(process.execPath,["-p","1+1"],{encoding:"utf8"}).stdout.trim(),"2");
    assert.equal(childProcess.execFileSync(process.execPath,["business.js"],{encoding:"utf8"}).trim(),"script-ran");
    assert.equal(childProcess.execSync("echo ordinary-after-dispose",{encoding:"utf8"}).trim(),"ordinary-after-dispose");
    assert.equal(process.cwd(),originalCwd);
  `,
  )
  assert.equal(
    fs.readFileSync(path.join(app.directory, "emit-business.txt"), "utf8").trim(),
    "emit-cwd",
  )
  assert.equal(
    fs.readFileSync(path.join(app.directory, "context-business.txt"), "utf8").trim(),
    "context-cwd",
  )
  assert.equal(fs.existsSync(path.join(app.state, "emit-business.txt")), false)
  assert.equal(fs.existsSync(path.join(app.state, "context-business.txt")), false)
})

test("低层对象参数和环境只转换一次，原数组保持原引用且不能绕过检查", { timeout: 30000 }, t => {
  probe(
    t,
    `
    let flagConversions=0,codeConversions=0;
    const flag={toString(){flagConversions++;return "-e"}};
    const code={toString(){codeConversions++;return "process.stdout.write('unexpected-script')"}};
    const scriptArgs=[process.execPath,flag,code];
    const scriptChild=new childProcess.ChildProcess();
    scriptChild.spawn({file:process.execPath,args:scriptArgs,envPairs:[],stdio:["ignore","ignore","ignore"]});assert.equal((await once(scriptChild,"close"))[0],0);
    assert.equal(flagConversions,1);assert.equal(codeConversions,1);
    assert.equal(scriptArgs[1],flag);assert.equal(scriptArgs[2],code);
    assert.equal(Object.isFrozen(scriptArgs),false);

    let pathConversions=0,pairConversions=0;
    const destination={toString(){pathConversions++;return sentinel}};
    const pair={toString(){pairConversions++;return "PATH="+directory}};
    const writeArgs=["touch",destination],envPairs=[pair];
    const writeChild=new childProcess.ChildProcess();
    try{denied(()=>writeChild.spawn({file:"touch",args:writeArgs,envPairs,stdio:["ignore","ignore","ignore"]}))}finally{writeChild._handle?.close()}
    assert.equal(pathConversions,1);assert.equal(pairConversions,1);
    assert.equal(writeArgs[1],destination);assert.equal(envPairs[0],pair);
    assert.equal(Object.isFrozen(writeArgs),false);assert.equal(Object.isFrozen(envPairs),false);

    let queryConversions=0;
    const query={toString(){queryConversions++;return "--version"}};
    const queryArgs=[process.execPath,query];
    const queryChild=new childProcess.ChildProcess();
    let stdout="",stderr="",watchdog;
    try{
      queryChild.spawn({file:process.execPath,args:queryArgs,envPairs:[],stdio:["ignore","pipe","pipe"]});
      queryChild.stdout.on("data",chunk=>stdout+=chunk);queryChild.stderr.on("data",chunk=>stderr+=chunk);
      watchdog=setTimeout(()=>queryChild.kill("SIGKILL"),5000);
      assert.equal((await once(queryChild,"close"))[0],0,stderr);
      assert.equal(stdout.trim(),process.version);
    }finally{
      clearTimeout(watchdog);
      if(queryChild.exitCode===null&&queryChild.signalCode===null)queryChild.kill("SIGKILL");
      queryChild._handle?.close();
    }
    assert.equal(queryConversions,1);assert.equal(queryArgs[1],query);
    assert.equal(Object.isFrozen(queryArgs),false);
  `,
  )
})
