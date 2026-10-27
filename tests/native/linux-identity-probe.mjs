import fs from "node:fs"
import path from "node:path"
import assert from "node:assert/strict"
import { spawn } from "node:child_process"
import { randomBytes, createHash } from "node:crypto"
import readline from "node:readline"
import { fileURLToPath } from "node:url"
import { performance } from "node:perf_hooks"

const self = fileURLToPath(import.meta.url)
const [role, helper, name, output] = process.argv.slice(2)
const nodeSha = "569128f3066ac7be59b10b9a0adef708def642ee37cbf9d560a9bdb68f872108"
const sha = file => createHash("sha256").update(fs.readFileSync(file)).digest("hex")
const cases = [
  "qualified-sigusr1",
  "node-options-disabled",
  "cli-disabled",
  "duplicate-key",
  "unknown-field",
  "wrong-nonce",
  "expired-deadline",
  "unknown-image",
  "expected-parent-mismatch",
]
function birth(pid) {
  const data = fs.readFileSync(`/proc/${pid}/stat`, "utf8")
  const fields = data
    .slice(data.lastIndexOf(")") + 2)
    .trim()
    .split(/\s+/)
  return { pid, parentPid: Number(fields[1]), startTicks: fields[19] }
}
function ownChild(executable, args, options) {
  const child = spawn(executable, args, { windowsHide: true, ...options })
  const exited = new Promise((resolve, reject) => {
    child.once("error", reject)
    child.once("close", (code, signal) => resolve({ code, signal }))
  })
  return { child, exited }
}
if (role === "all") {
  assert.equal(process.platform, "linux")
  assert.equal(process.arch, "x64")
  assert.equal(process.getuid(), 1000)
  assert.equal(sha(process.execPath), nodeSha)
  fs.mkdirSync(output, { recursive: false })
  const results = []
  for (const item of cases) {
    const env = { ...process.env }
    delete env.NODE_OPTIONS
    if (item === "node-options-disabled") env.NODE_OPTIONS = "--disable-sigusr1"
    const args = [
      ...(item === "cli-disabled" ? ["--disable-sigusr1"] : []),
      "--inspect-port=127.0.0.1:19429",
      self,
      "parent",
      helper,
      item,
    ]
    const shellArgs = [
      "-c",
      '"$1" "$2" app "$3" unknown-image; exit "$?"',
      "guard-owned-shell",
      process.execPath,
      self,
      helper,
    ]
    const { child, exited } = ownChild(
      item === "unknown-image" ? "/bin/sh" : process.execPath,
      item === "unknown-image" ? shellArgs : args,
      {
        env,
        stdio:
          item === "unknown-image" ? ["ignore", "pipe", "pipe"] : ["ignore", "pipe", "pipe", "ipc"],
      },
    )
    const stdout = [],
      stderr = [],
      messages = []
    child.stdout.on("data", chunk => stdout.push(chunk))
    child.stderr.on("data", chunk => stderr.push(chunk))
    child.on("message", message => messages.push(message))
    const actor = birth(child.pid),
      native = await exited
    fs.writeFileSync(path.join(output, `${item}.stdout.txt`), Buffer.concat(stdout))
    fs.writeFileSync(path.join(output, `${item}.stderr.txt`), Buffer.concat(stderr))
    const result = {
      name: item,
      actor,
      executable: item === "unknown-image" ? "/bin/sh" : process.execPath,
      args: item === "unknown-image" ? shellArgs : args,
      nodeSha256: sha(process.execPath),
      helperSha256: sha(helper),
      native,
      messages,
    }
    fs.writeFileSync(path.join(output, `${item}.json`), JSON.stringify(result, null, 2) + "\n")
    assert.deepEqual(native, { code: 0, signal: null }, item)
    if (item === "unknown-image") {
      const reply = Buffer.concat(stdout).toString("utf8").trim().split("\n").at(-1)
      assert.equal(JSON.parse(reply).passed, true, item)
    } else assert.equal(messages.at(-1)?.passed, true, item)
    results.push(result)
  }
  fs.writeFileSync(
    path.join(output, "summary.json"),
    JSON.stringify(
      {
        schemaVersion: 1,
        uid: process.getuid(),
        nodeSha256: sha(process.execPath),
        helperSha256: sha(helper),
        results,
      },
      null,
      2,
    ) + "\n",
  )
  console.log(JSON.stringify({ passed: results.length, cases, helperSha256: sha(helper) }))
} else if (role === "parent") {
  process.title = "guard-native-identity-owned-daemon-profile"
  const env = { ...process.env }
  delete env.NODE_OPTIONS
  const { child, exited } = ownChild(process.execPath, [self, "app", helper, name], {
    env,
    stdio: ["ignore", "pipe", "pipe", "ipc"],
  })
  child.stdout.pipe(process.stdout)
  child.stderr.pipe(process.stderr)
  child.on("message", message => process.send?.(message))
  const native = await exited
  assert.deepEqual(native, { code: 0, signal: null })
  process.disconnect?.()
} else if (role === "app") {
  const { child, exited } = ownChild(helper, [], { stdio: ["pipe", "pipe", "pipe"] })
  const stderr = []
  child.stderr.on("data", chunk => stderr.push(chunk))
  const lines = readline.createInterface({ input: child.stdout })
  const iterator = lines[Symbol.asyncIterator]()
  const nonce = randomBytes(24).toString("hex"),
    deadline = performance.now() + 30000
  let id = 0
  const replies = []
  async function send(command, extra = {}, raw) {
    const frame = {
      protocol: 1,
      sessionNonce: nonce,
      requestId: ++id,
      remainingBudgetMs: Math.ceil(deadline - performance.now()),
      command,
      ...extra,
    }
    child.stdin.write((raw ? raw(frame) : JSON.stringify(frame)) + "\n")
    const line = await iterator.next()
    if (line.done) return null
    const reply = JSON.parse(line.value)
    assert.equal(reply.protocol, 1)
    assert.equal(reply.sessionNonce, nonce)
    assert.equal(reply.requestId, id)
    replies.push(reply)
    return reply
  }
  let socket
  if (name === "duplicate-key" || name === "unknown-field") {
    const raw = frame =>
      name === "duplicate-key"
        ? JSON.stringify(frame).replace('{"protocol":1', '{"protocol":1,"protocol":1')
        : JSON.stringify({ ...frame, arbitraryPid: process.pid })
    assert.equal(await send("open-inspector-parent", { sessionBudgetMs: 30000 }, raw), null)
    assert.deepEqual(await exited, { code: 2, signal: null })
  } else if (name === "expected-parent-mismatch") {
    const unexpected = {
      pid: process.pid,
      birth: {
        kind: "linux-proc-start-ticks",
        value: "1",
        bootId: fs.readFileSync("/proc/sys/kernel/random/boot_id", "utf8").trim(),
        pidNamespace: "1:1",
      },
    }
    const refused = await send("open-inspector-parent", {
      sessionBudgetMs: 30000,
      expectedParent: unexpected,
    })
    assert.equal(refused.code, "ROOT_OR_PARENT_CHANGED")
    assert.equal(refused.result, "refused-before-action")
    assert.deepEqual(await exited, { code: 0, signal: null })
  } else if (name === "expired-deadline") {
    const ready = await send("open-inspector-parent", { sessionBudgetMs: 3000 })
    assert.equal(ready.type, "inspector-parent-ready")
    const bad = {
      protocol: 1,
      sessionNonce: nonce,
      requestId: ++id,
      remainingBudgetMs: 1,
      command: "confirm-inspector-parent",
      parentBindingToken: ready.parentBindingToken,
      connectionSerial: 1,
    }
    // 下一帧只发送一部分时，也不能延长原生绝对截止时间。
    child.stdin.write(JSON.stringify(bad).slice(0, -1))
    assert.deepEqual(await exited, { code: 3, signal: null })
  } else {
    const ready = await send("open-inspector-parent", { sessionBudgetMs: 30000 })
    assert.equal(ready.type, "inspector-parent-ready")
    assert.equal(ready.caller.pid, process.pid)
    assert.equal(ready.parent.pid, process.ppid)
    if (name === "wrong-nonce") {
      assert.equal(
        await send("close-session", {}, frame =>
          JSON.stringify({ ...frame, sessionNonce: "0".repeat(48) }),
        ),
        null,
      )
      assert.deepEqual(await exited, { code: 2, signal: null })
    } else {
      const extra = { parentBindingToken: ready.parentBindingToken }
      if (name === "qualified-sigusr1") {
        assert.equal(ready.activationAvailable, true)
        assert.equal(ready.activationProfile.verification, "qualified-target-image")
        const action = await send("activate-inspector-once", extra)
        assert.equal(action.result, "native-action-completed")
        assert.equal(
          (await send("activate-inspector-once", extra)).code,
          "ACTIVATION_ALREADY_ATTEMPTED",
        )
        let endpoint
        const limit = performance.now() + 4000
        while (performance.now() < limit) {
          try {
            const targets = await (await fetch("http://127.0.0.1:19429/json/list")).json()
            endpoint = targets[0]?.webSocketDebuggerUrl
            if (endpoint) break
          } catch {}
          await new Promise(resolve => setTimeout(resolve, 25))
        }
        assert.ok(endpoint)
        socket = new WebSocket(endpoint)
        await new Promise((resolve, reject) => {
          socket.addEventListener("open", resolve, { once: true })
          socket.addEventListener("error", reject, { once: true })
        })
        const confirmed = await send("confirm-inspector-parent", { ...extra, connectionSerial: 1 })
        assert.equal(confirmed.originalLive, true)
        assert.deepEqual(confirmed.parent, ready.parent)
        const closed = new Promise(resolve =>
          socket.addEventListener("close", resolve, { once: true }),
        )
        socket.close()
        await closed
      } else {
        assert.equal(ready.activationAvailable, false)
        assert.equal(
          ready.unavailableReason,
          name === "unknown-image"
            ? "UNSUPPORTED_NODE_PROFILE"
            : name === "node-options-disabled"
              ? "INSPECTOR_ACTIVATION_DISABLED"
              : "SIGNAL_HANDLER_UNAVAILABLE_OR_UNKNOWN",
        )
        assert.equal((await send("activate-inspector-once", extra)).result, "refused-before-action")
      }
      assert.equal((await send("close-session")).released, true)
      child.stdin.end()
      assert.deepEqual(await exited, { code: 0, signal: null })
    }
  }
  assert.equal(Buffer.concat(stderr).length, 0)
  const result = { passed: true, name, caller: birth(process.pid), replies }
  if (process.send) process.send(result)
  else console.log(JSON.stringify(result))
  process.disconnect?.()
} else throw new Error("Unknown role")
