import assert from "node:assert/strict"
import test from "node:test"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import childProcess from "node:child_process"
import { once } from "node:events"
import { pathToFileURL } from "node:url"
import { parseSettings } from "../dist/config/index.js"
import { installInstrumentation } from "../dist/instrumentation/index.js"

test("allowed fork removes only inherited Guard preloading and preserves child execution", async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "yunzai-guard-fork-"))
  const modulePath = path.join(directory, "child.mjs")
  const marker = path.join(directory, "marker.json")
  const userPreload = path.join(directory, "user-preload.mjs")
  fs.writeFileSync(userPreload, "globalThis.guardUserPreload = true\n", "utf8")
  fs.writeFileSync(
    modulePath,
    `import fs from "node:fs"\nfs.writeFileSync(process.argv[2], JSON.stringify({execArgv:process.execArgv, userPreload:globalThis.guardUserPreload === true}))\n`,
    "utf8",
  )
  const previous = process.execArgv
  const guardPreload = new URL("../dist/worker-preload.js", import.meta.url).href
  const events = []
  let child
  const dispose = installInstrumentation(parseSettings({}), event => events.push(event))
  try {
    const userURL = pathToFileURL(userPreload).href
    for (const inherited of [
      ["--no-warnings", "--import", guardPreload, "--import", userURL],
      ["--no-warnings", `--import=${guardPreload}`, "--import", userURL],
    ]) {
      process.execArgv = inherited
      child = childProcess.fork(modulePath, [marker], { silent: true })
      const [code] = await once(child, "exit")
      assert.equal(
        code,
        0,
        "ordinary child should run instead of waiting for a supervisor handshake",
      )
      const result = JSON.parse(fs.readFileSync(marker, "utf8"))
      assert.deepEqual(result.execArgv, ["--no-warnings", "--import", userURL])
      assert.equal(result.userPreload, true)
    }
    process.execArgv = ["--import", guardPreload]
    child = childProcess.fork(modulePath, [marker], { silent: true, execArgv: ["--no-warnings"] })
    const [code] = await once(child, "exit")
    assert.equal(code, 0)
    assert.deepEqual(JSON.parse(fs.readFileSync(marker, "utf8")).execArgv, ["--no-warnings"])
    // 省略 args 数组时，第三参数仍须保留 env/stdio 选项。
    fs.writeFileSync(
      modulePath,
      'import fs from "node:fs"\nfs.writeFileSync(process.env.GUARD_FORK_MARKER, "optional-args-ok")\n',
      "utf8",
    )
    child = childProcess.fork(modulePath, undefined, {
      silent: true,
      env: { ...process.env, GUARD_FORK_MARKER: marker },
    })
    const [optionalCode] = await once(child, "exit")
    assert.equal(optionalCode, 0)
    assert.equal(fs.readFileSync(marker, "utf8"), "optional-args-ok")
    assert.ok(
      events.some(
        event =>
          event.operation === "fork" &&
          event.action === "audit" &&
          event.details.inheritedGuardPreloadRemoved === true,
      ),
    )
    assert.ok(
      events
        .filter(event => event.operation === "fork")
        .every(event => event.details.childMonitoring === "creation-only"),
    )
  } finally {
    process.execArgv = previous
    if (child && child.exitCode === null && child.signalCode === null) child.kill("SIGKILL")
    dispose()
    fs.rmSync(directory, { recursive: true, force: true })
  }
})
