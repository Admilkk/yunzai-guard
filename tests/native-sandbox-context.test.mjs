import assert from "node:assert/strict"
import fs from "node:fs"
import path from "node:path"
import { fork } from "node:child_process"
import { createHash } from "node:crypto"
import { fileURLToPath, pathToFileURL } from "node:url"
import test from "node:test"

const repository = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")
const runs = path.join(repository, "tests/runs")
const baseSource = path.join(
  process.env.GUARD_TEST_CORE_SOURCE ?? path.join(repository, "tests/source"),
  "lib/plugins/plugin.js",
)
const manifestFile = path.join(repository, "tests/core-manifest.json")
const classId = "index.js#Conversation"
const otherClassId = "index.js#Other"
const displayName = "Same conversation display name"
const event = (msg, fields = {}) => ({ self_id: 42, user_id: 101, group_id: 701, msg, ...fields })
const hash = bytes => createHash("sha256").update(bytes).digest("hex")

const pluginSource = `
export class Conversation extends plugin {
  constructor() { super({ name: ${JSON.stringify(displayName)} }) }
  remember(e) {
    const saved = this.setContext("resume", false, 0)
    saved.guestOnly = () => "guest-memory"
    return { sameEvent: saved === e, replyType: typeof saved.reply }
  }
  rememberGroup(e) {
    this.setContext("resumeGroup", true, 0)
    return e.msg
  }
  rememberSlow(e) {
    this.setContext("resumeSlow", false, 0)
    return e.msg
  }
  resume(previous) {
    this.finish("resume", false)
    return [previous.msg, this.e.msg, typeof previous.reply, previous.guestOnly()].join("|")
  }
  resumeGroup(previous) {
    this.finish("resumeGroup", true)
    return previous.msg + "|" + this.e.msg
  }
  async resumeSlow(previous) {
    await new Promise(resolve => setTimeout(resolve, 30))
    this.finish("resumeSlow", false)
    return previous.msg + "|" + this.e.msg
  }
  async wait(e) {
    const first = e.msg
    const answer = await this.awaitContext(false, 0)
    return { first, answer: answer.msg, current: this.e.msg, replyType: typeof answer.reply }
  }
}
export class Other extends Conversation {
  constructor() { super(); this.name = "Other conversation" }
}
`

function write(root, name, content) {
  const file = path.join(root, name)
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, content)
}

async function fixture(t) {
  const bytes = fs.readFileSync(baseSource)
  assert.equal(hash(bytes), JSON.parse(fs.readFileSync(manifestFile))["lib/plugins/plugin.js"])
  fs.mkdirSync(runs, { recursive: true })
  const root = fs.mkdtempSync(path.join(runs, "native-context-"))
  write(root, "package.json", JSON.stringify({ type: "module" }))
  write(root, "lib/plugins/plugin.js", bytes)
  write(root, "plugins/conversation/index.js", pluginSource)
  // 上下文行为由真实核心基类提供，其余初始化依赖使用不能连接账号的无害夹具。
  for (const name of ["lodash", "oicq"]) {
    write(
      root,
      `node_modules/${name}/package.json`,
      JSON.stringify({ name, type: "module", main: "index.js" }),
    )
    write(
      root,
      `node_modules/${name}/index.js`,
      name === "lodash" ? "export default {}" : "export const segment = {}",
    )
  }
  const guestModule = pathToFileURL(path.join(repository, "dist/native-sandbox/guest.js")).href
  write(
    root,
    "driver.mjs",
    `
import { NativeGuest } from ${JSON.stringify(guestModule)}
let clockOffset = 0
const originalNow = performance.now.bind(performance)
Object.defineProperty(performance, "now", { value: () => originalNow() + clockOffset })
const guest = new NativeGuest({
  send: message => process.send({ type: "guest-message", message }),
  service: async (service, method, args, requestId) => {
    process.send({ type: "service", service, method, args, requestId })
    return { message_id: "fixture-reply" }
  }
})
// 并发分派 RPC，与真实原生子进程传输一致。
process.on("message", async ({ id, operation, fields }) => {
  try {
    let value
    if (operation === "load") value = await guest.load(id, fields.root, fields.pluginRoot, "index.js")
    else if (operation === "context") value = await guest.context(id, fields.classId, fields.event, fields.isGroup)
    else if (operation === "call") value = await guest.call(id, fields.classId, fields.method, fields.event, undefined, undefined, false, fields.contextHandle)
    else if (operation === "advanceClock") { clockOffset += fields.milliseconds; value = true }
    else throw new Error("Unexpected fixture operation")
    process.send({ type: "result", id, ok: true, value })
  } catch (error) {
    process.send({ type: "result", id, ok: false, error: { code: error.code, message: error.message } })
  }
})
process.send({ type: "ready" })
`,
  )
  const pending = new Map()
  const messages = []
  let sequence = 0
  let output = ""
  let readyResolve
  let readyReject
  const ready = new Promise((resolve, reject) => {
    readyResolve = resolve
    readyReject = reject
  })
  const readyTimer = setTimeout(
    () => readyReject(new Error("Context fixture readiness timeout: " + output)),
    5000,
  )
  const child = fork(path.join(root, "driver.mjs"), [], {
    cwd: root,
    execArgv: [],
    silent: true,
    env: {
      ...process.env,
      NODE_OPTIONS: "",
      YUNZAI_GUARD_PIPE: "",
      YUNZAI_GUARD_RUNTIME_MANIFEST: "",
    },
  })
  child.stdout.on("data", bytes => {
    output += bytes
  })
  child.stderr.on("data", bytes => {
    output += bytes
  })
  child.on("error", readyReject)
  child.on("message", message => {
    messages.push(message)
    if (message.type === "ready") {
      clearTimeout(readyTimer)
      readyResolve()
    }
    if (message.type === "result") {
      const request = pending.get(message.id)
      if (request) {
        clearTimeout(request.timer)
        pending.delete(message.id)
        request.resolve(message)
      }
    }
  })
  child.on("exit", () => {
    const error = new Error("Context fixture exited before request completion: " + output)
    for (const request of pending.values()) {
      clearTimeout(request.timer)
      request.reject(error)
    }
    pending.clear()
  })
  t.after(async () => {
    clearTimeout(readyTimer)
    if (child.exitCode === null && child.signalCode === null) {
      const exited = new Promise(resolve => child.once("exit", resolve))
      child.kill()
      await exited
    }
    assert.equal(
      hash(fs.readFileSync(baseSource)),
      hash(bytes),
      "Original core source must remain unchanged",
    )
    assert.equal(hash(fs.readFileSync(path.join(root, "lib/plugins/plugin.js"))), hash(bytes))
    assert.equal(
      fs.readFileSync(path.join(root, "plugins/conversation/index.js"), "utf8"),
      pluginSource,
    )
    const canonicalRoot = fs.realpathSync.native(root)
    assert.equal(path.dirname(canonicalRoot), fs.realpathSync.native(runs))
    assert.ok(path.basename(canonicalRoot).startsWith("native-context-"))
    fs.rmSync(canonicalRoot, { recursive: true, force: true })
  })
  await ready
  const request = (operation, fields) => {
    const id = String(++sequence)
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        pending.delete(id)
        reject(new Error(`Context ${operation} timeout: ${output}`))
      }, 5000)
      pending.set(id, { resolve, reject, timer })
      child.send({ id, operation, fields })
    })
  }
  const loaded = await request("load", {
    root,
    pluginRoot: path.join(root, "plugins/conversation"),
  })
  assert.equal(loaded.ok, true, JSON.stringify(loaded))
  assert.equal(loaded.value.classes.length, 2)
  return {
    child,
    messages,
    call: (method, event, fields = {}) => request("call", { classId, method, event, ...fields }),
    context: (event, isGroup = false, id = classId) =>
      request("context", { classId: id, event, isGroup }),
    advanceClock: milliseconds => request("advanceClock", { milliseconds }),
  }
}

function value(response) {
  assert.equal(response.ok, true, JSON.stringify(response))
  return response.value
}

function handle(response, method) {
  const token = value(response)[method]
  assert.deepEqual(Object.keys(token).sort(), ["$type", "id"])
  assert.equal(token.$type, "NativeContext")
  assert.match(token.id, /^ctx-[0-9a-f-]{36}$/)
  return token.id
}

function rejected(response) {
  assert.equal(response.ok, false, JSON.stringify(response))
  assert.equal(response.error.code, "UNKNOWN_CONTEXT")
}

test(
  "native context lookup exports an opaque capability without serializing the saved event",
  { timeout: 15000 },
  async t => {
    const f = await fixture(t)
    assert.deepEqual(value(await f.call("remember", event("private old event"))).result, {
      sameEvent: true,
      replyType: "function",
    })
    const lookup = await f.context(event("current event"))
    const token = handle(lookup, "resume")
    assert.doesNotMatch(JSON.stringify(lookup), /private old event|guestOnly|reply|user_id/)
    const result = value(await f.call("resume", event("current event"), { contextHandle: token }))
    assert.equal(result.result, "private old event|current event|function|guest-memory")
    assert.deepEqual(value(await f.context(event("later"))), {})
  },
)

test(
  "native context lookup preserves per-user private and per-group core routing",
  { timeout: 15000 },
  async t => {
    const f = await fixture(t)
    value(await f.call("remember", event("private")))
    value(await f.call("rememberGroup", event("group")))
    assert.deepEqual(Object.keys(value(await f.context(event("next"), false))), ["resume"])
    assert.deepEqual(Object.keys(value(await f.context(event("next"), true))), ["resumeGroup"])
    assert.deepEqual(value(await f.context(event("other-user", { user_id: 102 }), false)), {})
    assert.deepEqual(value(await f.context(event("other-group", { group_id: 702 }), true)), {})
    assert.deepEqual(
      Object.keys(value(await f.context(event("same-user", { group_id: 702 }), false))),
      ["resume"],
    )
    assert.deepEqual(
      Object.keys(value(await f.context(event("same-group", { user_id: 102 }), true))),
      ["resumeGroup"],
    )
    assert.deepEqual(value(await f.context(event("other-bot", { self_id: 43 }), false)), {})
  },
)

test(
  "resolveContext completes an awaiting RPC while keeping each call's current event",
  { timeout: 15000 },
  async t => {
    const f = await fixture(t)
    const waiting = f.call("wait", event("question"))
    const token = handle(await f.context(event("answer")), "resolveContext")
    const resolution = f.call("resolveContext", event("answer"), { contextHandle: token })
    const [resolved, answered] = await Promise.all([resolution, waiting])
    assert.equal(value(resolved).result, null)
    assert.deepEqual(value(answered).result, {
      first: "question",
      answer: "answer",
      current: "question",
      replyType: "function",
    })
    assert.deepEqual(value(await f.context(event("after"))), {})
  },
)

test(
  "forged, cross-class and cross-method context capabilities are rejected",
  { timeout: 15000 },
  async t => {
    const f = await fixture(t)
    value(await f.call("remember", event("saved")))
    const token = handle(await f.context(event("current")), "resume")
    rejected(
      await f.call("resume", event("current"), {
        contextHandle: "ctx-00000000-0000-0000-0000-000000000000",
      }),
    )
    rejected(
      await f.call("resume", event("current"), { classId: otherClassId, contextHandle: token }),
    )
    rejected(await f.call("resumeGroup", event("current"), { contextHandle: token }))
    assert.equal(
      value(await f.call("resume", event("current"), { contextHandle: token })).result,
      "saved|current|function|guest-memory",
    )
  },
)

test(
  "expired and already consumed context capabilities cannot be replayed",
  { timeout: 15000 },
  async t => {
    const f = await fixture(t)
    value(await f.call("remember", event("first")))
    const first = handle(await f.context(event("second")), "resume")
    value(await f.call("resume", event("second"), { contextHandle: first }))
    rejected(await f.call("resume", event("replay"), { contextHandle: first }))
    value(await f.call("remember", event("expiry")))
    const expired = handle(await f.context(event("next")), "resume")
    value(await f.advanceClock(60001))
    rejected(await f.call("resume", event("too-late"), { contextHandle: expired }))
  },
)

test(
  "concurrent replay cannot execute the same context capability twice",
  { timeout: 15000 },
  async t => {
    const f = await fixture(t)
    value(await f.call("rememberSlow", event("old")))
    const token = handle(await f.context(event("new")), "resumeSlow")
    const replies = await Promise.all([
      f.call("resumeSlow", event("one"), { contextHandle: token }),
      f.call("resumeSlow", event("two"), { contextHandle: token }),
    ])
    assert.equal(replies.filter(reply => reply.ok).length, 1, JSON.stringify(replies))
    rejected(replies.find(reply => !reply.ok))
  },
)

test(
  "identical display names in separate processes never share host or guest context state",
  { timeout: 15000 },
  async t => {
    const baseBytes = fs.readFileSync(baseSource)
    assert.equal(
      hash(baseBytes),
      JSON.parse(fs.readFileSync(manifestFile))["lib/plugins/plugin.js"],
    )
    const { default: CorePlugin } = await import(pathToFileURL(baseSource).href)
    const host = new CorePlugin({ name: displayName })
    host.e = event("host-only-event")
    host.setContext("resume", false, 0)
    t.after(() => host.finish("resume", false))
    const first = await fixture(t)
    const second = await fixture(t)
    assert.notEqual(first.child.pid, second.child.pid)
    assert.deepEqual(value(await first.context(event("lookup"))), {})
    assert.deepEqual(value(await second.context(event("lookup"))), {})
    value(await first.call("remember", event("guest-one")))
    const token = handle(await first.context(event("lookup")), "resume")
    assert.deepEqual(value(await second.context(event("lookup"))), {})
    rejected(await second.call("resume", event("borrowed"), { contextHandle: token }))
    assert.equal(host.getContext("resume", false).msg, "host-only-event")
    assert.equal(
      value(await first.call("resume", event("next"), { contextHandle: token })).result,
      "guest-one|next|function|guest-memory",
    )
  },
)
