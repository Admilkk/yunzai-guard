import assert from "node:assert/strict"
import fs from "node:fs"
import path from "node:path"
import test from "node:test"
import { fileURLToPath, pathToFileURL } from "node:url"
import { spawn } from "node:child_process"
import { once } from "node:events"
import { createHash } from "node:crypto"

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")
const fixture = path.join(root, "tests/native/windows-identity-probe.mjs")
const enabled = process.env.GUARD_TEST_NATIVE_REAL === "1" && process.platform === "win32"
const moduleRoot = path.resolve(process.env.GUARD_TEST_NATIVE_BUILD ?? path.join(root, "dist"))
const bundleRoot = process.env.GUARD_TEST_NATIVE_REAL_BUNDLE
const api = enabled
  ? await import(pathToFileURL(path.join(moduleRoot, "native-process/index.js")).href)
  : undefined
const sha = file => createHash("sha256").update(fs.readFileSync(file)).digest("hex")
const output = enabled
  ? fs.mkdtempSync(path.join(root, "tests/runs/native-windows-real-r29-"))
  : undefined
const skip = enabled
  ? false
  : "requires explicit GUARD_TEST_NATIVE_REAL=1 and pinned real native bundle"
if (enabled) {
  assert.ok(path.isAbsolute(bundleRoot))
  fs.writeFileSync(
    path.join(output, "inputs.json"),
    JSON.stringify(
      {
        nodeVersion: process.version,
        nodeSha256: sha(process.execPath),
        fixtureSha256: sha(fixture),
        manifestSha256: sha(path.join(bundleRoot, "manifest.json")),
        adapterSha256: sha(path.join(moduleRoot, "native-process/index.js")),
      },
      null,
      2,
    ) + "\n",
  )
}
for (const orphan of [false, true])
  test(
    `Windows real original-handle capture, held descendant cleanup${orphan ? " after root exit" : ""}`,
    { skip, timeout: 25000, concurrency: false },
    async () => {
      const child = spawn(process.execPath, [fixture, "tree-root"], {
        windowsHide: true,
        stdio: ["ignore", "ignore", "pipe", "ipc"],
      })
      const probe = api.createOriginalWindowsChildProbe(child)
      const childExited = once(child, "exit")
      let session,
        records = [],
        terminated = false
      try {
        const [ready] = await once(child, "message")
        session = await api.createNativeIdentityAdapter({ bundleRoot }).openRoot(probe, 20000)
        const commits = []
        const captured = await session.captureInto({
          commitVerifiedSnapshot(identity, rows) {
            commits.push({ identity, rows })
            records = [...rows]
          },
        })
        assert.equal(captured.committed, true)
        assert.equal(captured.observation, "complete")
        assert.equal(commits.length, 1)
        assert.ok(records.some(row => row.identity.pid === ready.grandchild))
        assert.ok(!records.some(row => row.identity.pid === child.pid))
        assert.ok(records.every(row => row.identity.birth.kind === "windows-filetime-100ns"))
        if (orphan) {
          child.send("exit-with-child")
          assert.equal((await childExited)[0], 0)
          const incomplete = await session.captureInto({
            commitVerifiedSnapshot() {
              assert.fail("A missing original root cannot authorize a new snapshot")
            },
          })
          assert.equal(incomplete.committed, false)
          assert.equal(incomplete.observation, "incomplete")
        } else {
          const grand = records.find(row => row.identity.pid === ready.grandchild)
          const first = await session.terminateCaptured([grand.recordId])
          assert.equal(first.results[0].result, "terminated-and-exited")
          child.send("close")
          assert.equal((await childExited)[0], 0)
        }
        const result = await session.terminateCaptured(records.map(row => row.recordId))
        fs.writeFileSync(
          path.join(output, `capture-${orphan ? "orphan" : "live"}-receipt.json`),
          JSON.stringify(
            {
              captured: commits,
              result,
              rootNativeExit: { code: child.exitCode, signal: child.signalCode },
            },
            null,
            2,
          ) + "\n",
        )
        assert.ok(
          result.results.every(row =>
            ["original-exited", "terminated-and-exited"].includes(row.result),
          ),
        )
        terminated = true
        assert.equal(probe.probeOriginalNow().live, false)
        if (!orphan && child.connected) {
          child.send("close")
          await childExited
        }
        await session.close()
        session = undefined
        fs.writeFileSync(
          path.join(output, `capture-${orphan ? "orphan" : "live"}.json`),
          JSON.stringify(
            {
              status: "passed",
              scope: "own-direct-child-only",
              captured: commits,
              result,
              rootNativeExit: { code: child.exitCode, signal: child.signalCode },
            },
            null,
            2,
          ) + "\n",
        )
      } finally {
        if (child.connected) child.send("close")
        if (!terminated && records.length)
          await session?.terminateCaptured(records.map(row => row.recordId)).catch(() => {})
        await session?.close().catch(() => {})
        if (child.exitCode === null && child.signalCode === null) child.kill()
        await childExited
      }
    },
  )
test(
  "Windows real native parent activation confirms its specific established WebSocket and closes owned endpoint",
  {
    skip,
    timeout: 25000,
    concurrency: false,
  },
  async () => {
    const child = spawn(
      process.execPath,
      ["--inspect-port=127.0.0.1:0", fixture, "inspector-daemon", bundleRoot, moduleRoot],
      {
        windowsHide: true,
        stdio: ["ignore", "ignore", "pipe", "ipc"],
      },
    )
    let result
    let stderr = ""
    child.stderr.on("data", data => {
      stderr += data
      assert.ok(stderr.length <= 65536)
    })
    child.on("message", value => {
      result = value
    })
    const [code, signal] = await once(child, "exit")
    fs.writeFileSync(
      path.join(output, "inspector-receipt.json"),
      JSON.stringify(
        {
          result,
          native: { code, signal },
          stderr,
        },
        null,
        2,
      ) + "\n",
    )
    assert.equal(code, 0)
    assert.equal(signal, null)
    assert.equal(result.status, "passed")
    assert.equal(result.inspectorClosed, true)
    assert.equal(result.duplicateActionRefused, true)
    assert.equal(result.duplicateConfirmationRefused, true)
    fs.writeFileSync(
      path.join(output, "inspector.json"),
      JSON.stringify(
        {
          ...result,
          native: { code, signal },
          scope: "own-parent-only-no-PM2-claim",
        },
        null,
        2,
      ) + "\n",
    )
  },
)
