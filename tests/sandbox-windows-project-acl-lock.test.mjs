import assert from "node:assert/strict"
import fs from "node:fs"
import path from "node:path"
import { spawn } from "node:child_process"
import { createHash } from "node:crypto"
import { fileURLToPath } from "node:url"
import test from "node:test"
import { spawnWindowsSandbox } from "../dist/sandbox/windows.js"

const repository = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))
async function until(predicate, detail) {
  const deadline = Date.now() + 20000
  while (!predicate()) {
    assert.ok(Date.now() < deadline, detail())
    await sleep(20)
  }
}

test(
  "ordinary v4 authorization and cleanup both obey the cross-process project ACL lock",
  { skip: process.platform !== "win32", timeout: 60000 },
  async () => {
    const root = fs.mkdtempSync(path.join(repository, "tests/runs/windows-project-acl-lock-"))
    const own = path.join(root, "plugins/ordinary")
    fs.mkdirSync(own, { recursive: true })
    const entry = path.join(root, "probe.cjs")
    fs.writeFileSync(
      entry,
      "const net=require('node:net');const s=net.connect(process.env.YUNZAI_GUARD_PIPE);s.on('connect',()=>s.write(JSON.stringify({type:'preload-hello',pid:process.pid})+'\\n'));setInterval(()=>{},1000)",
    )
    const errors = [],
      messages = [],
      report = { root, errors }
    const launch = () => {
      const child = spawnWindowsSandbox(
        root,
        { sandbox: { network: "none", writablePaths: ["plugins/ordinary"] } },
        {
          executable: process.execPath,
          args: [entry],
          env: { ...process.env },
          forwardOutput: false,
          sessionKey: "ordinary",
        },
      )
      child.on("error", error => errors.push(error.message))
      child.on("message", frame => messages.push({ child, frame }))
      return child
    }
    const hasReady = child =>
      messages.some(row => row.child === child && row.frame.type === "preload-hello")
    const key = createHash("sha256").update(root.toUpperCase()).digest("hex")
    const lockPath = path.join(
      process.env.LOCALAPPDATA,
      "YunzaiGuard/WindowsSandboxLabels",
      key,
      "project-acl.lock",
    )
    const lockers = [],
      children = []
    async function hold() {
      const payload = Buffer.from(lockPath).toString("base64")
      const script = `$ErrorActionPreference='Stop';$p=[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${payload}'));$f=[IO.File]::Open($p,[IO.FileMode]::Open,[IO.FileAccess]::ReadWrite,[IO.FileShare]::None);try{[Console]::Out.WriteLine('held');[Console]::Out.Flush();[Console]::ReadLine()|Out-Null}finally{$f.Dispose()}`
      const locker = spawn(
        "powershell.exe",
        [
          "-NoProfile",
          "-NonInteractive",
          "-EncodedCommand",
          Buffer.from(script, "utf16le").toString("base64"),
        ],
        { windowsHide: true, stdio: ["pipe", "pipe", "pipe"] },
      )
      lockers.push(locker)
      let output = "",
        error = ""
      locker.stdout.on("data", data => {
        output += data
      })
      locker.stderr.on("data", data => {
        error += data
      })
      await until(
        () => output.includes("held"),
        () => output + error,
      )
      return async () => {
        locker.stdin.end("\n")
        await until(
          () => locker.exitCode !== null,
          () => output + error,
        )
        assert.equal(locker.exitCode, 0, error)
      }
    }
    try {
      const warmup = launch()
      children.push(warmup)
      await until(
        () => hasReady(warmup),
        () => JSON.stringify(errors),
      )
      await warmup.sandboxDispose()
      assert.equal(fs.existsSync(lockPath), true)
      const releaseStartup = await hold()
      const child = launch()
      children.push(child)
      await sleep(400)
      assert.equal(hasReady(child), false)
      assert.equal(fs.existsSync(path.join(child.sandboxSession, "journal.json")), false)
      report.startupWaitedForProjectLock = true
      await releaseStartup()
      await until(
        () => hasReady(child),
        () => JSON.stringify(errors),
      )
      const journal = path.join(child.sandboxSession, "journal.json")
      assert.equal(JSON.parse(fs.readFileSync(journal, "utf8")).version, 4)
      const releaseCleanup = await hold()
      child.stdin.write('{"type":"stop"}\n')
      await until(
        () => {
          try {
            process.kill(child.sandboxPid, 0)
            return false
          } catch (error) {
            if (error.code === "ESRCH") return true
            throw error
          }
        },
        () => "Guest Job did not terminate before ACL lock acquisition",
      )
      assert.equal(
        child.exitCode,
        null,
        "Broker must retain the journal while restoration is blocked",
      )
      assert.equal(fs.existsSync(journal), true)
      report.cleanupWaitedAfterGuestTerminated = true
      await releaseCleanup()
      await child.sandboxDispose()
      assert.equal(fs.existsSync(journal), false)
      assert.deepEqual(errors, [])
      report.status = "ordinary-v4-project-lock-passed"
    } finally {
      for (const locker of lockers) if (locker.exitCode === null) locker.stdin.end("\n")
      for (const child of children) {
        try {
          await child.sandboxDispose()
        } catch (error) {
          errors.push(error.message)
        }
      }
      fs.writeFileSync(path.join(root, "report.json"), JSON.stringify(report, null, 2) + "\n")
    }
  },
)
