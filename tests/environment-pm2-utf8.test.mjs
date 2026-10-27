import assert from "node:assert/strict"
import fs from "node:fs"
import path from "node:path"
import { execFileSync } from "node:child_process"
import { fileURLToPath } from "node:url"
import test from "node:test"
import { createWindowsPm2Fixture, environmentDigest } from "./pm2-windows-fixture.mjs"
import { waitScopeGone } from "./environment-fixture.mjs"

const repository = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
const enabled = process.platform === "win32" && process.env.GUARD_TEST_PM2_UTF8 === "1"
const packages = [
  [
    "global",
    process.env.GUARD_TEST_PM2_PACKAGE_GLOBAL ||
      path.join(process.env.APPDATA || "", "npm/node_modules/pm2"),
  ],
  [
    "local",
    process.env.GUARD_TEST_PM2_PACKAGE_LOCAL ||
      path.resolve(repository, "../TRSS-Yunzai/node_modules/pm2"),
  ],
]
const read = file => (fs.existsSync(file) ? fs.readFileSync(file, "utf8") : "")
function state(row) {
  assert.ok(row)
  return {
    id: row.pm_id,
    pid: row.pid,
    status: row.pm2_env.status,
    restarts: row.pm2_env.restart_time,
    script: row.pm2_env.pm_exec_path,
    envDigest: environmentDigest(row.pm2_env.env),
  }
}
function events(text) {
  return text.split("\n").flatMap(line => {
    const marker = "[Yunzai Guard PM2] ",
      index = line.indexOf(marker)
    const payload = index < 0 ? "" : line.slice(index + marker.length).trim()
    return payload.startsWith("{") ? [JSON.parse(payload)] : []
  })
}
for (const [label, packagePath] of packages)
  test(
    `Windows PM2 auto takeover preserves Chinese spaced daemon entry (${label})`,
    { skip: enabled ? false : "requires GUARD_TEST_PM2_UTF8=1 on Windows", timeout: 180000 },
    async context => {
      const physical = fs.realpathSync(packagePath)
      const aliasRoot = fs.mkdtempSync(path.join(repository, "tests/runs/pm2u-pkg-"))
      const alias = path.join(aliasRoot, "PM2 中文 路径")
      let harness,
        failure,
        cleanupFailure,
        cleanup,
        aliasRemoved = false
      let commandLineVerified = false,
        sourceChecked = false,
        barrierConfirmed = false
      fs.symlinkSync(physical, alias, "junction")
      assert.equal(fs.lstatSync(alias).isSymbolicLink(), true)
      try {
        harness = await createWindowsPm2Fixture({
          mode: "managed",
          zeroConfig: true,
          label: label === "global" ? "pm2u-6" : "pm2u-7",
          pm2Root: physical,
          daemonEntryPath: path.join(alias, "lib/Daemon.js"),
          interpreter: "node",
        })
        const { fixture, pm2, name, unrelatedName } = harness
        context.diagnostic(`Evidence: ${fixture.runRoot}`)
        const daemon = await pm2.startDaemon({ inspectPort: 0 })
        const script = `[Console]::OutputEncoding=[Text.UTF8Encoding]::new($false);(Get-CimInstance Win32_Process -Filter 'ProcessId=${daemon.pid}' -ErrorAction Stop).CommandLine|ConvertTo-Json -Compress`
        const commandLine = JSON.parse(
          execFileSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script], {
            encoding: "utf8",
            windowsHide: true,
            timeout: 10000,
          }),
        )
        assert.ok(
          commandLine.includes(alias),
          "Actual parent command line must retain the Chinese spaced alias",
        )
        assert.ok(commandLine.includes("PM2 中文 路径"))
        commandLineVerified = true
        const daemonEnv = await pm2.daemonEnvironment()
        assert.equal(daemonEnv.nodeOptionsAbsent, true)
        assert.equal(daemonEnv.pm2NodeOptionsAbsent, true)
        await pm2.cli(["start", harness.unrelatedConfigPath])
        const unrelated = state((await pm2.listRaw()).find(row => row.name === unrelatedName))
        await pm2.cli(["start", harness.targetConfigPath])
        const first = await fixture.waitOnline()
        const before = state((await pm2.listRaw()).find(row => row.name === name))
        assert.equal(before.id, 1)
        assert.equal(before.pid, first.hostPid)
        assert.equal(before.restarts, 1)
        assert.equal(before.script.toLowerCase(), harness.launcherPath.toLowerCase())
        const oldScope = harness.capture(first.hostPid)
        const offset = read(path.join(pm2.home, "pm2.log")).length
        await pm2.cli(["restart", name])
        const current = await fixture.waitForStatus(
          value => value.phase === "online" && value.hostPid !== first.hostPid,
        )
        await waitScopeGone(oldScope)
        const rows = await pm2.listRaw()
        const after = state(rows.find(row => row.name === name))
        assert.equal(after.id, before.id)
        assert.equal(after.pid, current.hostPid)
        assert.equal(after.status, "online")
        assert.equal(after.restarts, before.restarts + 1)
        assert.equal(current.recoveryCount, 0)
        assert.deepEqual(state(rows.find(row => row.name === unrelatedName)), unrelated)
        assert.deepEqual(pm2.observeDaemon(), daemon)
        assert.deepEqual(await pm2.daemonEnvironment(), daemonEnv)
        const segment = events(read(path.join(pm2.home, "pm2.log")).slice(offset))
        assert.equal(
          segment.filter(
            event =>
              event.event === "pm2-exit-barrier-complete" &&
              event.pid === first.hostPid &&
              String(event.pmId) === String(before.id),
          ).length,
          1,
        )
        assert.ok(!segment.some(event => event.event === "pm2-exit-barrier-failed"))
        assert.ok(
          !segment.some(
            event => event.pid === unrelated.pid || String(event.pmId) === String(unrelated.id),
          ),
        )
        barrierConfirmed = true
        harness.capture(current.hostPid)
        harness.captureSession()
        fixture.verifyCoreHashes()
        harness.assertPreserved()
        sourceChecked = true
      } catch (error) {
        failure = error
      } finally {
        try {
          if (harness) cleanup = await harness.cleanup()
        } catch (error) {
          cleanupFailure = error
        }
        // 仅移除 junction 本身，不递归删除其目标。
        if (fs.existsSync(alias)) {
          assert.equal(fs.lstatSync(alias).isSymbolicLink(), true)
          assert.equal(fs.realpathSync(alias), physical)
          fs.rmdirSync(alias)
        }
        aliasRemoved = !fs.existsSync(alias)
        if (harness)
          fs.writeFileSync(
            path.join(harness.fixture.runRoot, "pm2-auto-utf8-report.json"),
            JSON.stringify(
              {
                platform: process.platform,
                pm2Version: harness.pm2Version,
                testedNode: harness.nodeVersion,
                interpreterKind: harness.interpreterKind,
                mode: "managed",
                daemonState: "existing",
                status: failure || cleanupFailure ? "failed" : "passed",
                operatorGuardPreload: false,
                actualChineseSpacedCommandLineVerified: commandLineVerified,
                targetedHandoffRestarts: 1,
                nativeRestartActions: 1,
                exactBarrierConfirmed: barrierConfirmed,
                daemonAndUnrelatedEnvironmentUnchanged: sourceChecked,
                coreFileHashCount: 47,
                originalSourcesUnchanged: sourceChecked,
                sourceSnapshot: harness.sourceSnapshot,
                aliasJunctionRemovedWithoutRecursion: aliasRemoved,
                cleanup,
                error: failure?.stack,
                cleanupError: cleanupFailure?.stack,
              },
              null,
              2,
            ) + "\n",
          )
      }
      if (failure && cleanupFailure) throw new AggregateError([failure, cleanupFailure])
      if (failure) throw failure
      if (cleanupFailure) throw cleanupFailure
    },
  )
