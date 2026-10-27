import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { spawn } from "node:child_process"
import { createHash } from "node:crypto"
import test from "node:test"
import { fileURLToPath, pathToFileURL } from "node:url"

const supported = ["win32", "linux"].includes(process.platform)
const dist = path.resolve(
  process.env.GUARD_TEST_PRIVATE_DIST ?? fileURLToPath(new URL("../dist", import.meta.url)),
)
const evidence = fileURLToPath(new URL("./runs/pm2-auto-inspector-integration", import.meta.url))
const pause = ms => new Promise(resolve => setTimeout(resolve, ms))
const sha = file => createHash("sha256").update(fs.readFileSync(file)).digest("hex")

function sanitizedEnvironment() {
  const env = { ...process.env }
  for (const key of [
    "NODE_OPTIONS",
    "PM2_NODE_OPTIONS",
    "PM2_HOME",
    "pm_id",
    "NODE_APP_INSTANCE",
    "YUNZAI_GUARD_PM2_TICKET",
  ])
    delete env[key]
  return env
}

function exitPromise(child) {
  const promise = new Promise((resolve, reject) => {
    child.once("error", reject)
    child.once("exit", (code, signal) => resolve({ code, signal }))
  })
  void promise.catch(() => {})
  return promise
}

async function bounded(promise, timeout, description) {
  let timer
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(description)), timeout)
      }),
    ])
  } finally {
    clearTimeout(timer)
  }
}

async function until(predicate, description, child, timeout = 30000) {
  const deadline = Date.now() + timeout
  while (Date.now() < deadline) {
    const value = await predicate()
    if (value) return value
    if (child && (child.exitCode !== null || child.signalCode !== null))
      throw new Error(`${description}: child exited ${child.exitCode}/${child.signalCode}`)
    await pause(20)
  }
  throw new Error(description)
}

function ownTemp() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "guard-pm2-auto-inspector-"))
  fs.writeFileSync(path.join(root, "package.json"), '{"type":"module"}\n')
  const project = path.join(root, "project")
  const guard = path.join(project, "plugins", "yunzai-guard")
  const copiedDist = path.join(guard, "dist")
  fs.mkdirSync(copiedDist, { recursive: true })
  fs.cpSync(dist, copiedDist, { recursive: true, errorOnExist: true })
  fs.cpSync(
    path.resolve(dist, "../native/process-identity"),
    path.join(guard, "native/process-identity"),
    {
      recursive: true,
      errorOnExist: true,
    },
  )
  fs.writeFileSync(path.join(project, "app.js"), "// Self-authored identity fixture only.\n")
  const pm2Root = path.join(root, "fake-pm2")
  fs.mkdirSync(path.join(pm2Root, "lib"), { recursive: true })
  fs.writeFileSync(
    path.join(pm2Root, "package.json"),
    JSON.stringify({ name: "pm2", version: "6.0.14", type: "commonjs" }),
  )
  const godPath = path.join(pm2Root, "lib", "God.js")
  fs.writeFileSync(
    godPath,
    `module.exports={clusters_db:{},processIsDead(){},handleExit(){},forkMode(){},restartProcessId(){}};\n`,
  )
  const home = path.join(root, "pm2-home")
  fs.mkdirSync(home)
  return { root, project, copiedDist, pm2Root, godPath, home }
}

function removeOwnTemp(root) {
  assert.match(path.basename(root), /^guard-pm2-auto-inspector-/)
  const temp = fs.realpathSync.native(os.tmpdir())
  assert.equal(fs.realpathSync.native(path.dirname(root)), temp)
  assert.equal(path.dirname(fs.realpathSync.native(root)), temp)
  fs.rmSync(root, { recursive: true, force: true })
}

async function connectInspector(url) {
  const socket = new WebSocket(url)
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      socket.close()
      reject(new Error("Held Inspector connection timeout"))
    }, 5000)
    socket.addEventListener(
      "open",
      () => {
        clearTimeout(timer)
        resolve()
      },
      { once: true },
    )
    socket.addEventListener(
      "error",
      () => {
        clearTimeout(timer)
        reject(new Error("Held Inspector connection failed"))
      },
      { once: true },
    )
  })
  return socket
}

async function closeSocket(socket) {
  if (!socket || socket.readyState === WebSocket.CLOSED) return
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("Held Inspector close timeout")), 5000)
    socket.addEventListener(
      "close",
      () => {
        clearTimeout(timer)
        resolve()
      },
      { once: true },
    )
    socket.close()
  })
}

async function runtimePid(socket, serial) {
  return new Promise((resolve, reject) => {
    const done = () => {
      clearTimeout(timer)
      socket.removeEventListener("message", listener)
    }
    const listener = event => {
      const value = JSON.parse(event.data)
      if (value.id !== serial) return
      done()
      if (value.error || value.result?.exceptionDetails)
        reject(new Error("Held Runtime request failed"))
      else resolve(value.result?.result?.value)
    }
    const timer = setTimeout(() => {
      done()
      reject(new Error("Held Runtime request timeout"))
    }, 5000)
    socket.addEventListener("message", listener)
    socket.send(
      JSON.stringify({
        id: serial,
        method: "Runtime.evaluate",
        params: { expression: "process.pid", returnByValue: true },
      }),
    )
  })
}

const parentSource = String.raw`
const fs=require('node:fs'),path=require('node:path'),inspector=require('node:inspector');
const {spawn}=require('node:child_process');
const config=JSON.parse(fs.readFileSync(process.argv[2],'utf8'));
const god=require('./God.js');
let child,childExit,stopping=false,forced=false;
const endpoints=[];
function observe(){const url=inspector.url()??null;if(endpoints.at(-1)?.url!==url)endpoints.push({at:Date.now(),url});}
const observer=setInterval(observe,20);
const originalMethods={poll:god.processIsDead,exit:god.handleExit,fork:god.forkMode};
fs.writeFileSync(path.join(config.home,'pm2.pid'),String(process.pid));
if(config.existing)inspector.open(0,'127.0.0.1');
observe();
const initialEndpoint=inspector.url()??null;
const deadline=setTimeout(()=>stop('creator deadline'),65000);
function send(value){if(process.connected)process.send(value,()=>{});}
async function stop(reason){
  if(stopping)return;stopping=true;clearTimeout(deadline);clearInterval(observer);
  let outcome=null;
  if(child){
    if(child.exitCode===null&&child.signalCode===null&&child.connected)child.send({type:'stop'},()=>{});
    const timeout=new Promise(resolve=>{const t=setTimeout(()=>resolve(null),6000);t.unref();childExit.finally(()=>clearTimeout(t));});
    outcome=await Promise.race([childExit,timeout]);
    if(!outcome&&child.exitCode===null&&child.signalCode===null){
      forced=true;child.kill('SIGKILL');
      outcome=await Promise.race([childExit,new Promise(resolve=>{const t=setTimeout(()=>resolve({unconfirmed:true}),3000);t.unref();childExit.finally(()=>clearTimeout(t));})]);
    }
  }
  if(inspector.url())inspector.close();
  await new Promise(resolve=>{const t=setTimeout(resolve,2000);if(process.connected)process.send({type:'stopped',reason,forced,childExit:outcome},()=>{clearTimeout(t);resolve();});else{clearTimeout(t);resolve();}});
  process.exit(forced||outcome?.unconfirmed?1:0);
}
process.on('message',message=>{
  if(message?.type==='stop'){void stop('creator stop');return;}
  if(message?.type!=='continue'||child)return;
  if(config.scenario==='badcap')require(config.agentPath);
  const env={...process.env,pm_id:'0',NODE_APP_INSTANCE:'0',PM2_HOME:config.home};
  for(const key of ['NODE_OPTIONS','PM2_NODE_OPTIONS','YUNZAI_GUARD_PM2_TICKET'])delete env[key];
  child=spawn(process.execPath,[config.childFile],{cwd:config.project,env,windowsHide:true,stdio:['ignore','ignore','pipe','ipc']});
  child.stderr.on('data',()=>{});
  childExit=new Promise(resolve=>{child.once('exit',(code,signal)=>resolve({code,signal}));child.once('error',error=>resolve({spawnError:error.message}));});
  child.pm2_env={pm_id:0,unique_id:'private-integration',status:'online',exec_mode:'fork_mode',pm_cwd:config.project,pm_exec_path:path.join(config.project,'app.js'),env:{fixture:true}};
  god.clusters_db['0']=child;
  globalThis.__selectedFixture=child.pm2_env;
  const before=JSON.stringify(child.pm2_env);
  child.on('message',value=>{
    if(value?.type!=='result')return;
    observe();
    send({type:'result',childPid:child.pid,result:value,metadataBefore:JSON.parse(before),metadataAfter:child.pm2_env,methodsUnchanged:originalMethods.poll===god.processIsDead&&originalMethods.exit===god.handleExit&&originalMethods.fork===god.forkMode,initialEndpoint,finalEndpoint:inspector.url()??null,endpoints});
  });
});
send({type:'ready',pid:process.pid,initialEndpoint});
`

async function scenarioFixture(scenario, existing) {
  const fixture = ownTemp()
  const { root, project, copiedDist, pm2Root, home } = fixture
  const sentinel = path.join(root, "old-register-called")
  const agentPath = path.join(copiedDist, "pm2", "agent-v2.js")
  if (scenario === "missing") fs.unlinkSync(agentPath)
  else
    fs.writeFileSync(
      agentPath,
      `import fs from 'node:fs';export const pm2AgentCapabilities=Object.freeze({agentProtocol:1,bootstrapExitBarrier:1,cachedRegistryUpgrade:1});export function registerPm2Application(){fs.writeFileSync(${JSON.stringify(sentinel)},'called');globalThis.__selectedFixture.pm_exec_path='OLD_REGISTER_CALLED';return {status:'registered'}}\n`,
    )
  const childFile = path.join(root, "registration-child.mjs")
  fs.writeFileSync(
    childFile,
    `import {registerCurrentPm2Application} from ${JSON.stringify(pathToFileURL(path.join(copiedDist, "pm2/auto.js")).href)};process.on('message',m=>{if(m?.type==='stop')process.exit(0)});process.once('disconnect',()=>process.exit(1));setTimeout(()=>process.exit(1),65000);let result;try{await registerCurrentPm2Application({root:${JSON.stringify(project)},launcherPath:${JSON.stringify(path.join(copiedDist, "launcher.js"))},shutdownTimeout:1000,startupTimeout:5000,requestRestart:true,bootstrapRedisPid:null});result={unexpectedSuccess:true}}catch(error){result={error:error.message}}process.send({type:'result',...result},()=>{});\n`,
  )
  const configFile = path.join(root, "case.json")
  fs.writeFileSync(
    configFile,
    JSON.stringify({ scenario, existing, project, home, childFile, agentPath }),
  )
  const parentFile = path.join(pm2Root, "lib", "Daemon.js")
  fs.writeFileSync(parentFile, parentSource)
  const child = spawn(process.execPath, ["--inspect-port=0", parentFile, configFile], {
    cwd: project,
    env: sanitizedEnvironment(),
    windowsHide: true,
    stdio: ["ignore", "ignore", "pipe", "ipc"],
  })
  const exited = exitPromise(child)
  const messages = []
  let stderr = ""
  child.stderr.on("data", chunk => {
    stderr = (stderr + chunk).slice(-12000)
  })
  child.on("message", value => messages.push(value))
  return { ...fixture, child, exited, messages, sentinel, stderr: () => stderr }
}

for (const existing of [false, true])
  for (const scenario of ["missing", "badcap"])
    test(
      `real auto Inspector cleanup (${scenario} agent, ${existing ? "existing held" : "owned temporary"} endpoint)`,
      { skip: !supported, timeout: 90000 },
      async () => {
        const probe = await scenarioFixture(scenario, existing)
        let socket,
          result,
          failure,
          forced = false,
          exit
        try {
          const ready = await until(
            () => probe.messages.find(x => x.type === "ready"),
            "Fake daemon did not become ready",
            probe.child,
          )
          assert.equal(ready.pid, probe.child.pid)
          if (existing) {
            assert.match(ready.initialEndpoint, /^ws:\/\/127\.0\.0\.1:/)
            socket = await connectInspector(ready.initialEndpoint)
            assert.equal(await runtimePid(socket, 1), probe.child.pid)
          } else assert.equal(ready.initialEndpoint, null)
          probe.child.send({ type: "continue" })
          result = await until(
            () => probe.messages.find(x => x.type === "result"),
            "Actual auto call did not finish",
            probe.child,
            45000,
          )
          assert.equal(result.result.unexpectedSuccess, undefined)
          assert.match(
            result.result.error,
            scenario === "missing"
              ? /Cannot find|not found|MODULE_NOT_FOUND/i
              : /PM2 代理协议缺失或不兼容，未执行登记/,
          )
          assert.deepEqual(result.metadataAfter, result.metadataBefore)
          assert.equal(result.methodsUnchanged, true)
          assert.equal(fs.existsSync(probe.sentinel), false, "Cached old register was never called")
          if (existing) {
            assert.equal(result.finalEndpoint, ready.initialEndpoint)
            assert.equal(socket.readyState, WebSocket.OPEN)
            assert.equal(await runtimePid(socket, 2), probe.child.pid)
            const endpoint = new URL(ready.initialEndpoint)
            const targets = await (
              await fetch(`http://${endpoint.host}/json/list`, {
                signal: AbortSignal.timeout(3000),
              })
            ).json()
            assert.ok(targets.some(x => x.webSocketDebuggerUrl === ready.initialEndpoint))
          } else {
            assert.ok(
              result.endpoints.some(x => typeof x.url === "string"),
              "Actual temporary Inspector was observed open",
            )
            assert.equal(result.finalEndpoint, null, "auto finally closed its temporary endpoint")
          }
        } catch (error) {
          failure = error
        } finally {
          try {
            await closeSocket(socket)
          } catch (error) {
            failure ??= error
          }
          if (probe.child.exitCode === null && probe.child.signalCode === null) {
            try {
              probe.child.send({ type: "stop" }, () => {})
            } catch {}
            try {
              await until(
                () => probe.child.exitCode !== null || probe.child.signalCode !== null,
                "Fake daemon did not exit naturally",
                undefined,
                10000,
              )
            } catch (error) {
              forced = true
              probe.child.kill("SIGKILL")
              failure ??= error
            }
          }
          try {
            exit = await bounded(probe.exited, 5000, "Own parent native exit is unconfirmed")
          } catch (error) {
            exit = { unconfirmed: true }
            failure ??= error
            if (probe.child.connected) probe.child.disconnect()
            probe.child.unref()
            probe.child.stderr.destroy()
          }
          const stopped = probe.messages.find(x => x.type === "stopped")
          if (exit.code !== 0 || exit.signal !== null || stopped?.forced || forced)
            failure ??= new Error(
              `Own fixture cleanup failed: ${JSON.stringify({ exit, stopped, forced })}`,
            )
          if (
            !stopped?.childExit ||
            stopped.childExit.code !== 0 ||
            stopped.childExit.signal !== null
          )
            failure ??= new Error("Registration child native exit was not confirmed")
          const report = {
            scope:
              "Self-authored parent/child, real Node ESM/Inspector/IPC and actual auto finally; no real PM2 acceptance",
            platform: process.platform,
            node: process.version,
            scenario,
            existing,
            source: dist,
            sourceAutoSha256: sha(path.join(dist, "pm2/auto.js")),
            sourceProtocolSha256: sha(path.join(dist, "pm2/agent-protocol.js")),
            parentPid: probe.child.pid,
            result,
            exit,
            stopped,
            forced,
            stderr: probe.stderr(),
            error: failure?.stack,
            tempRetained: Boolean(failure),
            root: probe.root,
          }
          const reportDir = path.join(evidence, path.basename(probe.root))
          fs.mkdirSync(reportDir, { recursive: true })
          fs.writeFileSync(
            path.join(reportDir, "report.json"),
            JSON.stringify(report, null, 2) + "\n",
          )
          if (!failure) removeOwnTemp(probe.root)
        }
        if (failure) throw failure
      },
    )

test(
  "actual Node createRequire loads the versioned agent and cleanup transport without TLA or God hooks",
  { skip: !supported, timeout: 30000 },
  async () => {
    const fixture = ownTemp()
    let failure,
      result,
      smokeChild,
      stderr = ""
    try {
      const smoke = path.join(fixture.pm2Root, "lib", "Daemon.js")
      fs.writeFileSync(
        smoke,
        `const assert=require('node:assert/strict'),god=require('./God.js');const keys=Reflect.ownKeys(god),refs=[god.processIsDead,god.handleExit,god.forkMode];const agent=require(${JSON.stringify(path.join(fixture.copiedDist, "pm2/agent-v2.js"))}),transport=require(${JSON.stringify(path.join(fixture.copiedDist, "pm2/inspector-session-v1.js"))});assert.deepEqual(agent.pm2AgentCapabilities,{agentProtocol:2,bootstrapExitBarrier:1,cachedRegistryUpgrade:1});assert.equal(Object.isFrozen(agent.pm2AgentCapabilities),true);assert.equal(typeof agent.registerPm2Application,'function');assert.equal(transport.pm2InspectorSessionProtocol,1);assert.equal(typeof transport.preparePm2InspectorClose,'function');assert.deepEqual(Reflect.ownKeys(god),keys);assert.deepEqual([god.processIsDead,god.handleExit,god.forkMode],refs);assert.deepEqual(god.clusters_db,{});console.log(JSON.stringify({nativeRequire:true,noTla:true,godHooksUnchanged:true}));\n`,
      )
      const child = spawn(process.execPath, [smoke], {
        cwd: fixture.project,
        env: sanitizedEnvironment(),
        windowsHide: true,
        stdio: ["ignore", "pipe", "pipe"],
      })
      smokeChild = child
      const exited = exitPromise(child)
      let stdout = ""
      child.stdout.on("data", chunk => {
        stdout += chunk
      })
      child.stderr.on("data", chunk => {
        stderr = (stderr + chunk).slice(-12000)
      })
      let forced = false
      const timer = setTimeout(() => {
        forced = true
        child.kill("SIGKILL")
      }, 15000)
      try {
        result = await bounded(exited, 20000, "Native require fixture exit is unconfirmed")
      } finally {
        clearTimeout(timer)
      }
      assert.equal(forced, false)
      assert.deepEqual(result, { code: 0, signal: null }, stderr)
      assert.deepEqual(JSON.parse(stdout), {
        nativeRequire: true,
        noTla: true,
        godHooksUnchanged: true,
      })
    } catch (error) {
      failure = error
    } finally {
      if (smokeChild?.exitCode === null && smokeChild.signalCode === null) {
        smokeChild.unref()
        smokeChild.stdout.destroy()
        smokeChild.stderr.destroy()
      }
      const reportDir = path.join(evidence, path.basename(fixture.root))
      fs.mkdirSync(reportDir, { recursive: true })
      fs.writeFileSync(
        path.join(reportDir, "report.json"),
        JSON.stringify(
          {
            platform: process.platform,
            source: dist,
            smoke: true,
            result,
            stderr,
            error: failure?.stack,
            root: fixture.root,
            tempRetained: Boolean(failure),
          },
          null,
          2,
        ) + "\n",
      )
      if (!failure) removeOwnTemp(fixture.root)
    }
    if (failure) throw failure
  },
)
