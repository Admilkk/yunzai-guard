import assert from "node:assert/strict"
import fs from "node:fs"
import path from "node:path"
import { spawn } from "node:child_process"
import test from "node:test"
import { createWindowsPm2Fixture } from "./pm2-windows-fixture.mjs"

test(
  "Windows PM2 fixture rejects a changed owner PID before capturing any foreign scope",
  {
    skip:
      process.platform === "win32" && process.env.GUARD_TEST_PM2_OWNER === "1"
        ? false
        : "requires the private Windows PM2 owner fixture gate",
    timeout: 180000,
  },
  async context => {
    const harness = await createWindowsPm2Fixture({
      mode: "managed",
      zeroConfig: true,
      label: "pm2-owner-r16",
    })
    const file = path.join(harness.pm2.home, "pm2.pid")
    const canary = spawn(process.execPath, ["--eval", "setInterval(()=>{},1000)"], {
      stdio: "ignore",
      windowsHide: true,
    })
    const canaryExit = new Promise(resolve => {
      canary.once("exit", resolve)
      canary.once("error", resolve)
    })
    let original, cleanup
    const report = {
      scope: "Self-authored non-daemon canary; no foreign daemon PID is used",
      sourceFixture: "tests/pm2-windows-fixture.mjs",
    }
    try {
      await new Promise((resolve, reject) => {
        canary.once("spawn", resolve)
        canary.once("error", reject)
      })
      report.daemon = await harness.pm2.startDaemon()
      original = fs.readFileSync(file)
      assert.notEqual(canary.pid, report.daemon.pid)
      fs.writeFileSync(file, String(canary.pid))
      assert.throws(
        () => harness.pm2.observeDaemon(),
        /Private PM2 owner identity changed; refusing foreign process capture/,
      )
      report.changedOwnerRejected = true
      fs.writeFileSync(file, original)
      assert.deepEqual(harness.pm2.observeDaemon(), report.daemon)
      cleanup = await harness.cleanup()
      assert.equal(cleanup.confirmed, true)
      assert.equal(fs.existsSync(file), false)
      assert.equal(canary.exitCode, null)
      assert.equal(canary.signalCode, null)
      assert.doesNotThrow(() => process.kill(canary.pid, 0))
      report.canaryRemainedAliveAfterPrivateDaemonCleanup = true
      report.status = "passed"
    } catch (error) {
      report.status = "failed"
      report.error = error.stack
      throw error
    } finally {
      if (original && fs.existsSync(file)) fs.writeFileSync(file, original)
      try {
        cleanup ??= await harness.cleanup()
      } finally {
        if (canary.exitCode === null && canary.signalCode === null) canary.kill()
        await canaryExit
        report.canaryFinallyStopped = true
        report.cleanup = cleanup
        report.privatePidFileRemoved = !fs.existsSync(file)
        fs.writeFileSync(
          path.join(harness.fixture.runRoot, "pm2-owner-report.json"),
          JSON.stringify(report, null, 2) + "\n",
        )
        context.diagnostic(`Evidence: ${harness.fixture.runRoot}`)
      }
    }
  },
)
