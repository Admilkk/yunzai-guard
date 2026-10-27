import assert from "node:assert/strict"
import fs from "node:fs"
import path from "node:path"
import test from "node:test"
import { createWindowsPm2Fixture, environmentDigest } from "./pm2-windows-fixture.mjs"
import { createLinuxRollbackFixture } from "./pm2-linux-rollback-fixture.mjs"
import { until, waitScopeGone } from "./environment-fixture.mjs"

const enabled =
  ["win32", "linux"].includes(process.platform) && process.env.GUARD_TEST_PM2_ROLLBACK === "1"
const identity = row => ({
  pid: row.pid,
  id: row.pm_id,
  uniqueId: row.pm2_env.unique_id,
  restarts: row.pm2_env.restart_time,
  environment: environmentDigest(row.pm2_env.env),
  script: row.pm2_env.pm_exec_path,
})

test(
  "real PM2 target removal, saved rollback and reinstall leave resident application untouched",
  {
    skip: enabled ? false : "requires GUARD_TEST_PM2_ROLLBACK=1 on Windows/Linux",
    timeout: 300000,
  },
  async context => {
    const h =
      process.platform === "win32"
        ? await createWindowsPm2Fixture({
            zeroConfig: true,
            mode: "managed",
            label: "pm2-rollback",
          })
        : await createLinuxRollbackFixture()
    const { fixture, pm2, name, unrelatedName } = h
    const backup = path.join(fixture.runRoot, "guard-disabled")
    assert.equal(path.dirname(backup), fixture.runRoot)
    assert.equal(path.dirname(fixture.pluginDir), path.join(fixture.root, "plugins"))
    let moved = false
    let failure, cleanup
    const steps = []
    try {
      context.diagnostic(`Evidence: ${fixture.runRoot}`)
      const daemon = await pm2.startDaemon()
      await pm2.cli(["start", h.unrelatedConfigPath])
      const resident = identity((await pm2.listRaw()).find(row => row.name === unrelatedName))
      const assertResident = async () => {
        assert.deepEqual(
          identity((await pm2.listRaw()).find(row => row.name === unrelatedName)),
          resident,
        )
        assert.deepEqual(pm2.observeDaemon(), daemon)
      }
      await pm2.cli(["start", h.targetConfigPath])
      const controlled = await fixture.waitOnline()
      const registered = (await pm2.listRaw()).find(row => row.name === name)
      assert.equal(registered.pid, controlled.hostPid)
      assert.equal(registered.pm2_env.pm_exec_path.toLowerCase(), h.launcherPath.toLowerCase())
      await pm2.cli(["save"])
      steps.push("automatic registration and launcher save")

      const scope = h.capture(controlled.hostPid)
      await pm2.cli(["stop", String(registered.pm_id)])
      await waitScopeGone(scope)
      await pm2.cli(["delete", String(registered.pm_id)])
      await assertResident()
      fs.renameSync(fixture.pluginDir, backup)
      moved = true
      await pm2.cli(["start", h.targetConfigPath])
      const plain = await until(
        async () => {
          const row = (await pm2.listRaw()).find(row => row.name === name)
          return row?.pm2_env.status === "online" &&
            fixture.lifecycle().some(event => event.pid === row.pid)
            ? row
            : false
        },
        "Original app did not start after rollback",
        60000,
      )
      h.capture(plain.pid)
      assert.notEqual(plain.pm2_env.unique_id, registered.pm2_env.unique_id)
      assert.equal(
        plain.pm2_env.pm_exec_path.toLowerCase(),
        path.join(fixture.root, "app.js").toLowerCase(),
      )
      await pm2.cli(["save"])
      const dump = JSON.parse(fs.readFileSync(path.join(pm2.home, "dump.pm2"), "utf8"))
      assert.equal(
        dump.find(row => row.name === name).pm_exec_path.toLowerCase(),
        path.join(fixture.root, "app.js").toLowerCase(),
      )
      assert.equal(dump.length, 2)
      await assertResident()
      steps.push("target-only stop/delete, plain app start and saved app.js entry")

      const plainScope = h.capture(plain.pid)
      await pm2.cli(["stop", String(plain.pm_id)])
      await waitScopeGone(plainScope)
      await pm2.cli(["delete", String(plain.pm_id)])
      fs.renameSync(backup, fixture.pluginDir)
      moved = false
      await pm2.cli(["start", h.targetConfigPath])
      const reinstalled = await fixture.waitOnline()
      assert.notEqual(reinstalled.hostPid, controlled.hostPid)
      assert.notEqual(reinstalled.hostPid, plain.pid)
      await pm2.cli(["restart", name])
      const restarted = await fixture.waitForStatus(
        state => state.phase === "online" && state.hostPid !== reinstalled.hostPid,
      )
      h.capture(restarted.hostPid)
      await assertResident()
      steps.push(
        "reinstall automatically registers, native restart succeeds, resident and daemon unchanged",
      )
    } catch (error) {
      failure = error
    } finally {
      // 先还原测试目录，再让已验证的清理流程导入 helper。
      if (moved) fs.renameSync(backup, fixture.pluginDir)
      cleanup = await h.cleanup()
      fs.writeFileSync(
        path.join(fixture.runRoot, "rollback-report.json"),
        JSON.stringify(
          {
            platform: process.platform,
            node: process.version,
            pm2: h.pm2Version,
            steps,
            cleanup,
            failure: failure?.stack,
          },
          null,
          2,
        ),
      )
    }
    if (failure) throw failure
  },
)
