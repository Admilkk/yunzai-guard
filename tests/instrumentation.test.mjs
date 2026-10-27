import assert from "node:assert/strict"
import test from "node:test"
import childProcess, { execFileSync as namedExecFileSync } from "node:child_process"
import http, { get as namedHttpGet } from "node:http"
import { promisify } from "node:util"
import diagnostics from "node:diagnostics_channel"
import { once } from "node:events"
import path from "node:path"
import os from "node:os"
import { randomUUID } from "node:crypto"
import { parseSettings } from "../dist/config/index.js"
import { installInstrumentation } from "../dist/instrumentation/index.js"
import { IntegrityMonitor } from "../dist/monitor/integrity.js"

test("all command entrypoints and synchronized ESM bindings reject before execution", async () => {
  const events = []
  const settings = parseSettings({
    rules: [{ id: "deny-execution", kind: "process", action: "deny" }],
  })
  const dispose = installInstrumentation(settings, event => events.push(event))
  try {
    const calls = {
      exec: () => childProcess.exec("unused-command"),
      execFile: () => childProcess.execFile(process.execPath, ["--version"]),
      spawn: () => childProcess.spawn(process.execPath, ["--version"]),
      fork: () => childProcess.fork("unused-module.mjs"),
      execSync: () => childProcess.execSync("unused-command"),
      execFileSync: () => namedExecFileSync(process.execPath, ["--version"]),
      spawnSync: () => childProcess.spawnSync(process.execPath, ["--version"]),
    }
    for (const call of Object.values(calls)) assert.throws(call, { code: "GUARD_DENIED" })
    const lowLevel = new childProcess.ChildProcess()
    try {
      assert.throws(
        () => lowLevel.spawn({ file: process.execPath, args: [process.execPath, "--version"] }),
        { code: "GUARD_DENIED" },
      )
    } finally {
      lowLevel._handle.close()
    }
    await assert.rejects(promisify(childProcess.exec)("unused-command"), { code: "GUARD_DENIED" })
    await assert.rejects(promisify(childProcess.execFile)(process.execPath, ["--version"]), {
      code: "GUARD_DENIED",
    })
    assert.deepEqual(
      new Set(events.filter(event => event.kind === "process").map(event => event.operation)),
      new Set(Object.keys(calls)),
    )
    assert.ok(
      events.filter(event => event.kind === "process").every(event => event.details.blocked),
    )
  } finally {
    dispose()
  }
})

test("default audit preserves execFile promisify result and child handle", async () => {
  const events = []
  const dispose = installInstrumentation(parseSettings({}), event => events.push(event))
  try {
    const result = promisify(childProcess.execFile)(process.execPath, [
      "-p",
      "'guard-audit-result'",
    ])
    assert.ok(result.child?.pid)
    assert.equal((await result).stdout.trim(), "guard-audit-result")
    assert.ok(events.some(event => event.operation === "execFile" && event.action === "audit"))
    assert.equal(events.filter(event => event.kind === "process").length, 1)
  } finally {
    dispose()
  }
})

test("normalized ChildProcess launch retains Guard preload through diagnostic callbacks", async () => {
  const events = []
  const manifestPath = path.join(os.tmpdir(), `guard-missing-${randomUUID()}.json`)
  const dispose = installInstrumentation(
    parseSettings({}),
    event => events.push(event),
    undefined,
    {
      manifestPath,
      runtimeId: "launch-fixture",
      originPlugin: () => "fixture-plugin",
    },
  )
  const channel = diagnostics.channel("tracing:child_process.spawn:start")
  let frozen = false
  const change = ({ options }) => {
    frozen =
      Object.isFrozen(options) && Object.isFrozen(options.args) && Object.isFrozen(options.envPairs)
    Reflect.set(options, "args", [process.execPath, "-e", "console.log('unguarded-payload')"])
    Reflect.set(options, "envPairs", [])
  }
  channel.subscribe(change)
  const child = new childProcess.ChildProcess()
  const argv = ["business-argv0", "-e", "console.log('unguarded-payload')"]
  const pairs = Object.entries(process.env)
    .filter(([key]) => key.toUpperCase() !== "NODE_OPTIONS")
    .map(([key, value]) => `${key}=${value}`)
  let stdout = "",
    stderr = ""
  let watchdog
  try {
    child.spawn({
      file: process.execPath,
      args: argv,
      envPairs: pairs,
      stdio: ["ignore", "pipe", "pipe"],
    })
    watchdog = setTimeout(() => child.kill("SIGKILL"), 10000)
    child.stdout.on("data", chunk => {
      stdout += chunk
    })
    child.stderr.on("data", chunk => {
      stderr += chunk
    })
    const [code] = await once(child, "close")
    assert.notEqual(code, 0)
    assert.equal(stdout.includes("unguarded-payload"), false)
    assert.ok(stderr.includes(manifestPath), stderr)
    assert.equal(frozen, true)
    assert.equal(events.filter(event => event.kind === "process").length, 1)
    assert.deepEqual(argv, ["business-argv0", "-e", "console.log('unguarded-payload')"])
    assert.equal(
      pairs.some(pair => pair.startsWith("YUNZAI_GUARD_RUNTIME_MANIFEST=")),
      false,
    )
  } finally {
    clearTimeout(watchdog)
    channel.unsubscribe(change)
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL")
    dispose()
  }
})

test("http get and fetch refuse calls and redact authentication and query data", async () => {
  const events = []
  const dispose = installInstrumentation(
    parseSettings({
      rules: [{ id: "deny-network", kind: "network", action: "deny" }],
    }),
    event => events.push(event),
  )
  try {
    assert.throws(
      () =>
        namedHttpGet("http://guard-user:guard-secret@127.0.0.1:1/path?token=query-secret#fragment"),
      { code: "GUARD_DENIED" },
    )
    await assert.rejects(fetch("http://127.0.0.1:1/path?token=fetch-secret"), {
      code: "GUARD_DENIED",
    })
    const data = JSON.stringify(events)
    for (const secret of ["guard-user", "guard-secret", "query-secret", "fetch-secret", "fragment"])
      assert.equal(data.includes(secret), false)
    assert.ok(
      events.some(
        event => event.operation === "http.get" && event.target === "http://127.0.0.1:1/path",
      ),
    )
  } finally {
    dispose()
  }
})

test("critical function monitor catches instance shadows even when the function value is unchanged", () => {
  const original = () => {}
  const instance = Object.create({ em: original })
  const events = []
  const monitor = new IntegrityMonitor(
    parseSettings({ protect: { targets: ["Bot.em"] } }),
    { Bot: instance },
    event => events.push(event),
  )
  monitor.capture()
  instance.em = original
  monitor.check()
  assert.equal(events.length, 1)
  assert.equal(events[0].kind, "integrity")
  assert.equal(events[0].details.reason, "descriptor")
  assert.equal(events[0].action, "audit")
})

test("instrumentation integrity reports replacement and does not overwrite the replacement on dispose", () => {
  const original = http.get
  const events = []
  const dispose = installInstrumentation(parseSettings({}), event => events.push(event))
  const changed = () => {
    throw new Error("test replacement")
  }
  try {
    http.get = changed
    dispose.checkIntegrity()
    assert.ok(events.some(event => event.kind === "integrity" && event.target === "http.get"))
    dispose()
    assert.equal(http.get, changed)
  } finally {
    dispose()
    http.get = original
  }
})
