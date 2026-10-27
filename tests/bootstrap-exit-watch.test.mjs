import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import test from "node:test"
import { spawn } from "node:child_process"
import { once } from "node:events"

const { watchBootstrapExit, BootstrapExitWatchClosedError } = await import(
  process.env.GUARD_TEST_BOOTSTRAP_EXIT_WATCH_MODULE ||
    new URL("../dist/host/bootstrap/exit-watch.js", import.meta.url).href
)
const supported = ["linux", "win32"].includes(process.platform)
const delay = ms => new Promise(resolve => setTimeout(resolve, ms))
const live = child => child.exitCode === null && child.signalCode === null

async function fixture(t, withChild = true) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "guard-bootstrap-exit-watch-"))
  const stop = path.join(directory, "child-stop")
  const readyFile = path.join(directory, "child-ready")
  const childScript = `const fs=require('node:fs');fs.writeFileSync(${JSON.stringify(readyFile)},'ready');setInterval(()=>{if(fs.existsSync(${JSON.stringify(stop)}))process.exit(0)},10);setTimeout(()=>process.exit(91),30000);`
  const rootScript = `
const{spawn}=require('node:child_process'),fs=require('node:fs');
const child=${withChild ? `spawn(process.execPath,['-e',${JSON.stringify(childScript)}],{stdio:'ignore',windowsHide:true,detached:true})` : "null"};
const send=()=>process.send({root:process.pid,child:child?.pid??null});
if(child){const poll=setInterval(()=>{if(fs.existsSync(${JSON.stringify(readyFile)})){clearInterval(poll);send()}},10)}else send();
process.on('message',message=>{if(message==='exit-root')process.exit(0);if(message==='cleanup'){fs.writeFileSync(${JSON.stringify(stop)},'stop');if(!child||child.exitCode!==null||child.signalCode!==null)process.exit(0);else{child.once('exit',()=>process.exit(0));setTimeout(()=>{child.kill('SIGKILL');process.exit(92)},2000)}}});
setTimeout(()=>{child?.kill('SIGKILL');process.exit(93)},30000);
`
  const root = spawn(process.execPath, ["-e", rootScript], {
    stdio: ["ignore", "ignore", "pipe", "ipc"],
    windowsHide: true,
  })
  let stderr = ""
  root.stderr.on("data", data => {
    stderr += String(data)
  })
  const rootExit = once(root, "exit")
  const [ids] = await Promise.race([
    once(root, "message"),
    rootExit.then(() => {
      throw new Error(`Fixture root exited before ready: ${stderr}`)
    }),
  ])
  let cleaned = false
  let childCleanupWatch
  const cleanup = async () => {
    if (cleaned) return
    cleaned = true
    fs.writeFileSync(stop, "stop")
    if (live(root)) {
      root.send("cleanup")
      let timer
      try {
        await Promise.race([
          rootExit,
          new Promise((_, reject) => {
            timer = setTimeout(() => reject(Error("Fixture cleanup timeout")), 5000)
          }),
        ])
      } finally {
        clearTimeout(timer)
        if (live(root)) root.kill("SIGKILL")
      }
    }
    if (childCleanupWatch) {
      try {
        await childCleanupWatch.exited
      } finally {
        await childCleanupWatch.close()
      }
    }
    fs.rmSync(directory, { recursive: true, force: true })
  }
  t.after(cleanup)
  if (ids.child !== null) childCleanupWatch = await watchBootstrapExit(ids.child, null, 25000)
  return { root, ids, rootExit, stopChild: () => fs.writeFileSync(stop, "stop"), cleanup }
}

async function remainsPending(promise) {
  const result = await Promise.race([
    promise.then(
      () => "resolved",
      () => "rejected",
    ),
    delay(80).then(() => "pending"),
  ])
  assert.equal(result, "pending")
}

test(
  "bootstrap exit watch captures only a live original root when Redis is external",
  { skip: !supported },
  async t => {
    const f = await fixture(t, false)
    const watch = await watchBootstrapExit(f.ids.root, null, 10000)
    try {
      assert.equal(watch.identities.length, 1)
      const identity = watch.identities[0]
      assert.equal(identity.pid, f.ids.root)
      assert.equal(identity.parentPid, process.pid)
      assert.match(identity.created, /^\d+$/)
      if (process.platform === "linux") assert.match(identity.namespace, /^pid:\[\d+\]$/)
      await remainsPending(watch.exited)
      f.root.send("exit-root")
      await watch.exited
      await f.rootExit
      await watch.close()
      await watch.close()
    } finally {
      await watch.close()
    }
  },
)

test(
  "bootstrap exit watch waits for a live owned child after its root exits",
  { skip: !supported },
  async t => {
    const f = await fixture(t)
    const watch = await watchBootstrapExit(f.ids.root, f.ids.child, 10000)
    try {
      assert.equal(watch.identities[1].parentPid, f.ids.root)
      f.root.send("exit-root")
      await f.rootExit
      await remainsPending(watch.exited)
      f.stopChild()
      await watch.exited
    } finally {
      f.stopChild()
      await watch.close()
    }
  },
)

test(
  "bootstrap exit watch still waits for root when its owned child exits first",
  { skip: !supported },
  async t => {
    const f = await fixture(t)
    const watch = await watchBootstrapExit(f.ids.root, f.ids.child, 10000)
    try {
      f.stopChild()
      await delay(100)
      await remainsPending(watch.exited)
      assert.equal(live(f.root), true)
      f.root.send("exit-root")
      await watch.exited
      await f.rootExit
    } finally {
      await watch.close()
    }
  },
)

test(
  "bootstrap exit watch rejects a live sibling as an owned Redis child",
  { skip: !supported },
  async t => {
    const a = await fixture(t, false)
    const b = await fixture(t, false)
    await assert.rejects(
      watchBootstrapExit(a.ids.root, b.ids.root, 10000),
      /不是原进程的直接子进程|父进程不符/,
    )
    assert.equal(live(a.root), true)
    assert.equal(live(b.root), true)
  },
)

test(
  "closing the bootstrap exit watch is idempotent and signals neither target",
  { skip: !supported },
  async t => {
    const f = await fixture(t)
    const watch = await watchBootstrapExit(f.ids.root, f.ids.child, 10000)
    const rejected = assert.rejects(watch.exited, BootstrapExitWatchClosedError)
    await Promise.all([watch.close(), watch.close()])
    await rejected
    assert.equal(live(f.root), true)
    process.kill(f.ids.child, 0)
  },
)

test(
  "bootstrap exit watch timeout closes only its observer and preserves rejection",
  { skip: !supported },
  async t => {
    const f = await fixture(t)
    // 采集可能消耗 Windows CIM 的启动预算，但不能延长截止时间。
    const watch = await watchBootstrapExit(f.ids.root, f.ids.child, 4000)
    await assert.rejects(watch.exited, { name: "BootstrapExitWatchTimeoutError" })
    await watch.close()
    assert.equal(live(f.root), true)
    process.kill(f.ids.child, 0)
  },
)

test(
  "bootstrap exit watch refuses invalid or absent process identities",
  { skip: !supported },
  async () => {
    for (const [root, child, timeout] of [
      [0, null, 1000],
      [process.pid, null, 1000],
      [2, 2, 1000],
      [2, null, 0],
      [2, null, Infinity],
    ])
      await assert.rejects(watchBootstrapExit(root, child, timeout), /Invalid/)
    await assert.rejects(watchBootstrapExit(2147483647, null, 5000))
  },
)

test(
  "a completed bootstrap root cannot be captured as a live identity",
  { skip: !supported },
  async t => {
    const f = await fixture(t, false)
    f.root.send("exit-root")
    await f.rootExit
    await assert.rejects(watchBootstrapExit(f.ids.root, null, 5000))
  },
)
