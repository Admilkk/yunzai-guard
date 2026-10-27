import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import test from "node:test"
import {
  ownedProcessRows,
  sameProcessIdentity,
  writeProcessOwnershipSnapshot,
} from "./helpers/process-ownership.mjs"

test("old orphans whose parent PID was reused are excluded from cleanup ownership", () => {
  const root = { pid: 100, parent: 50, start: "1000" }
  const rows = [
    root,
    { pid: 101, parent: 100, start: "900" },
    { pid: 102, parent: 100, start: "1001" },
    { pid: 103, parent: 102, start: "1002" },
    { pid: 104, parent: 101, start: "1003" },
  ]
  assert.deepEqual(
    ownedProcessRows(rows, [root]).map(row => row.pid),
    [100, 102, 103],
  )
})

test("known owned orphans retain identity while a reused PID never inherits ownership", () => {
  const original = { pid: 200, parent: 100, start: "1000" }
  assert.equal(sameProcessIdentity(original, { ...original, start: "1001" }), false)
  assert.deepEqual(ownedProcessRows([{ ...original, start: "1001" }], [original]), [])
  const orphan = { ...original, parent: 1 }
  assert.deepEqual(ownedProcessRows([orphan], [original]), [orphan])
  assert.deepEqual(ownedProcessRows([{ ...original, start: null }], [original]), [])
})

test("interrupted test evidence retains exact identities without process secrets or false cleanup", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "guard-ownership-test-"))
  try {
    const filename = path.join(directory, "process-ownership.json")
    const owner = { pid: 100, parent: 1, start: "1000", commandLine: "secret" }
    const child = { pid: 200, parent: 100, start: "1001", env: { TOKEN: "secret" } }
    const snapshot = { project: directory, owner, observed: [child], state: "observing" }
    writeProcessOwnershipSnapshot(filename, snapshot)
    const before = fs.readFileSync(filename)
    const restored = JSON.parse(before)
    assert.equal(before.includes("secret"), false)
    assert.deepEqual(restored.owner, { pid: 100, parent: 1, start: "1000" })
    assert.deepEqual(ownedProcessRows([{ ...child, start: "1002" }], restored.observed), [])
    assert.throws(() =>
      writeProcessOwnershipSnapshot(filename, {
        ...snapshot,
        state: "observed-processes-exited",
        remaining: [child],
      }),
    )
    assert.deepEqual(fs.readFileSync(filename), before)
    writeProcessOwnershipSnapshot(filename, {
      ...snapshot,
      state: "observed-processes-exited",
      remaining: [],
    })
    assert.equal(JSON.parse(fs.readFileSync(filename)).boundaryCleanupConfirmed, false)
    assert.deepEqual(fs.readdirSync(directory), ["process-ownership.json"])
  } finally {
    const target = fs.realpathSync.native(directory)
    assert.equal(path.dirname(target), fs.realpathSync.native(os.tmpdir()))
    assert.ok(path.basename(target).startsWith("guard-ownership-test-"))
    fs.rmSync(target, { recursive: true, force: true })
  }
})
