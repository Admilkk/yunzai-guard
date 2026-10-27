import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { ChildProcess, spawn } from "node:child_process"
import test from "node:test"
import { Pm2BootstrapExit } from "../dist/pm2/bootstrap-exit.js"
import { registerPm2ApplicationWithGod } from "../dist/pm2/daemon.js"
import { watchBootstrapExit } from "../dist/host/bootstrap/exit-watch.js"

const immediate = () => new Promise(resolve => setImmediate(resolve))
const bounded = (promise, timeout = 10000) => {
  let timer
  return Promise.race([
    promise,
    new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error("Self-authored child deadline exceeded")), timeout)
    }),
  ]).finally(() => clearTimeout(timer))
}

test("cold ledger timeout cannot turn a missing commit into a successful exit", async () => {
  const child = new ChildProcess()
  const resource = Promise.withResolvers()
  let closed = 0
  const reasons = []
  const gate = new Pm2BootstrapExit(
    child,
    "owned-nonce",
    {
      identities: [],
      exited: resource.promise,
      close: async () => {
        closed++
      },
    },
    25,
    () => true,
    reason => reasons.push(reason),
  )
  child.emit("exit", 0, null)
  resource.resolve()
  await bounded(assert.rejects(gate.exited, /bootstrap-exit-timeout/))
  assert.equal(gate.released, false)
  assert.equal(gate.failed, true)
  assert.equal(closed, 1)
  assert.deepEqual(reasons, ["bootstrap-exit-timeout"])
  assert.equal(child.listenerCount("message"), 0)
  assert.equal(child.listenerCount("exit"), 0)
})

test("cold ledger rejects replacement during observer cleanup after a valid commit", async () => {
  const child = new ChildProcess()
  const cleanup = Promise.withResolvers()
  let current = true
  const gate = new Pm2BootstrapExit(
    child,
    "owned-nonce",
    {
      identities: [],
      exited: Promise.resolve(),
      close: () => cleanup.promise,
    },
    1000,
    () => current,
    () => {},
  )
  child.emit("message", { type: "yunzai-guard-pm2-exit-commit", nonce: "owned-nonce" })
  child.emit("exit", 0, null)
  await immediate()
  current = false
  cleanup.resolve()
  await assert.rejects(gate.exited, /generation-changed/)
  assert.equal(gate.released, false)
})

for (const owned of [false, true])
  test(
    `cold PM2 ABI component binds real parent${owned ? "+owned child" : " only"} OS exits without starting PM2`,
    { timeout: 30000 },
    async t => {
      const base = fs.mkdtempSync(path.join(os.tmpdir(), "guard-pm2-cold-real-"))
      const launcher = path.join(base, "plugins/guard/dist/launcher.js")
      fs.mkdirSync(path.dirname(launcher), { recursive: true })
      fs.writeFileSync(launcher, "")
      fs.writeFileSync(path.join(base, "app.js"), "")
      const nonce = "self-authored-real-child-nonce"
      const child = spawn(
        process.execPath,
        [
          "--input-type=module",
          "-e",
          `
import {spawn} from "node:child_process"
let resource
const finish = committed => {
  if (committed) process.send({type:"yunzai-guard-pm2-exit-commit",nonce:${JSON.stringify(nonce)}},()=>process.exit(0))
  else process.exit(1)
}
process.once("exit",()=>resource?.kill("SIGTERM"))
process.once("disconnect",()=>finish(false))
process.on("message",value=>{
  if(value==="shutdown")finish(true)
  if(value==="cleanup")finish(false)
  if(value==="handoff")process.send({type:"yunzai-guard-pm2-handoff",nonce:${JSON.stringify(nonce)}})
})
if (${owned}) {
  resource=spawn(process.execPath,["-e","setInterval(()=>{},1000)"],{stdio:"ignore",windowsHide:true})
  await new Promise((resolve,reject)=>{resource.once("spawn",resolve);resource.once("error",reject)})
}
process.send({type:"fixture-ready",redisPid:resource?.pid??null})
setInterval(()=>{},1000)
`,
        ],
        { cwd: base, windowsHide: true, stdio: ["ignore", "pipe", "pipe", "ipc"] },
      )
      let output = ""
      child.stderr.setEncoding("utf8").on("data", value => {
        output += value
      })
      const closed = new Promise(resolve =>
        child.once("close", (code, signal) => resolve({ code, signal })),
      )
      const ready = bounded(
        new Promise((resolve, reject) => {
          child.once("error", reject)
          child.on("message", value => {
            if (value?.type === "fixture-ready") resolve(value)
          })
        }),
      )
      let observer
      t.after(async () => {
        if (child.exitCode === null && child.signalCode === null) {
          if (child.connected) child.send("cleanup", () => {})
          await bounded(closed)
        }
        await observer?.close()
        assert.equal(
          path.dirname(fs.realpathSync.native(base)),
          fs.realpathSync.native(os.tmpdir()),
        )
        assert.match(path.basename(base), /^guard-pm2-cold-real-/)
        fs.rmSync(base, { recursive: true, force: true })
      })
      const { redisPid } = await ready
      child.pm2_env = {
        pm_id: 7,
        unique_id: "real-cold-component",
        status: "online",
        exec_mode: "fork_mode",
        pm_cwd: base,
        pm_exec_path: path.join(base, "app.js"),
        env: {},
      }
      child.process = { pid: child.pid }
      let consumed = 0,
        restarted = 0,
        stopped = 0
      const god = {
        clusters_db: { 7: child },
        processIsDead(pid, environment, callback) {
          child.once("exit", () => callback(null, true))
        },
        handleExit() {
          consumed++
          child.process.pid = 0
        },
        forkMode() {
          throw new Error("This component must never spawn a PM2 application")
        },
        restartProcessId(options, callback) {
          restarted++
          this.processIsDead(child.pid, child.pm2_env, () => {
            stopped++
            callback(null)
          })
          child.send("shutdown")
        },
      }
      child.on("exit", (code, signal) => god.handleExit(child, code, signal))
      const receipt = await registerPm2ApplicationWithGod(
        god,
        {
          pmId: 7,
          pid: child.pid,
          root: base,
          launcherPath: launcher,
          shutdownTimeout: 1000,
          startupTimeout: 2000,
          nonce,
          requestRestart: true,
          bootstrapRedisPid: redisPid,
          expectedDaemonPid: process.pid,
          pm2Root: base,
        },
        {
          daemonPid: process.pid,
          watchBootstrapExit: async (...args) => {
            observer = await watchBootstrapExit(...args)
            return observer
          },
        },
      )
      assert.equal(receipt.bootstrapExitBarrier, 1)
      assert.equal(observer.identities.length, owned ? 2 : 1)
      if (owned) assert.equal(observer.identities[1].parentPid, child.pid)
      assert.equal(
        child.exitCode,
        null,
        "OS identities must be fixed while the original application is live",
      )
      child.send("handoff")
      assert.deepEqual(await bounded(closed), { code: 0, signal: null }, output)
      await bounded(observer.exited)
      await immediate()
      await immediate()
      assert.equal(restarted, 1)
      assert.equal(stopped, 1)
      assert.equal(consumed, 1)
      assert.equal(child.process.pid, 0)
    },
  )
