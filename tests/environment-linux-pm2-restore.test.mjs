import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { execFile } from "node:child_process"
import { createHash } from "node:crypto"
import { promisify } from "node:util"
import { fileURLToPath } from "node:url"
import test from "node:test"
import { isSupportedPm2Version } from "../dist/pm2/versions.js"
import { createEnvironmentFixture, snapshot, until, waitScopeGone } from "./environment-fixture.mjs"

const execute = promisify(execFile)
const enabled = process.platform === "linux" && process.env.GUARD_TEST_PM2_RESTORE === "1"
const modes = process.env.GUARD_TEST_PM2_MODES?.split(",") || ["managed", "os-sandbox"]
assert.ok(modes.every(mode => ["managed", "os-sandbox"].includes(mode)))
const cliOption = process.env.GUARD_PM2_CLI || "/usr/local/lib/node_modules/pm2/bin/pm2"
const nodeOption = process.env.GUARD_TEST_PM2_NODE || process.execPath
const ticketKey = "YUNZAI_GUARD_PM2_TICKET"
const read = file => (fs.existsSync(file) ? fs.readFileSync(file, "utf8") : "")
const digest = value => createHash("sha256").update(value).digest("hex")

function fileHashes(root) {
  const result = {}
  function visit(directory) {
    for (const entry of fs
      .readdirSync(directory, { withFileTypes: true })
      .sort((a, b) => a.name.localeCompare(b.name))) {
      const file = path.join(directory, entry.name)
      const relative = path.relative(root, file)
      if (entry.isDirectory()) visit(file)
      else if (entry.isSymbolicLink()) result[relative] = { link: fs.readlinkSync(file) }
      else if (entry.isFile()) result[relative] = digest(fs.readFileSync(file))
    }
  }
  visit(root)
  return result
}

function assertHashes(root, expected, description) {
  const current = fileHashes(root)
  assert.deepEqual(Object.keys(current), Object.keys(expected), `${description}: file set changed`)
  for (const file of Object.keys(expected))
    assert.deepEqual(current[file], expected[file], `${description}: ${file} changed`)
}

function identity(pid) {
  if (!Number.isSafeInteger(pid) || pid <= 1) return undefined
  return snapshot(pid).find(row => row.pid === pid)
}

function outsideDaemonState(home) {
  const contents = read(path.join(home, "pm2.pid"))
  const processIdentity = identity(Number(contents.trim()))
  return { pidFileDigest: digest(contents), processIdentity }
}

function assertNoTicket(value, location = "dump") {
  if (!value || typeof value !== "object") return
  for (const [key, nested] of Object.entries(value)) {
    assert.notEqual(key, ticketKey, `${location} must not persist a generation ticket`)
    assertNoTicket(nested, location)
  }
}

function assertNoPreload(row) {
  for (const environment of [row.pm2_env, row.pm2_env?.env, row, row.env]) {
    if (!environment) continue
    for (const key of ["NODE_OPTIONS", "PM2_NODE_OPTIONS"])
      assert.ok(!environment[key], "The restore test must not use an operator preload")
  }
}

function savedApplication(row) {
  return {
    name: row.name,
    script: row.pm_exec_path,
    interpreter: row.exec_interpreter,
    mode: row.exec_mode,
    restartCount: row.restart_time,
  }
}

// 私有 PM2 环境及其转储中不携带真实凭据。
function privateEnvironment(home) {
  const result = { PM2_HOME: home, PM2_NO_INTERACTION: "true" }
  for (const key of [
    "PATH",
    "HOME",
    "USER",
    "LOGNAME",
    "LANG",
    "LC_ALL",
    "LC_CTYPE",
    "TZ",
    "TMPDIR",
    "TMP",
    "TEMP",
  ])
    if (process.env[key] !== undefined) result[key] = process.env[key]
  return result
}

for (const mode of modes)
  test(
    `Linux PM2 save and fresh-daemon resurrect restore one controlled instance (${mode})`,
    { skip: enabled ? false : "requires GUARD_TEST_PM2_RESTORE=1 on Linux", timeout: 900000 },
    async context => {
      const cli = fs.realpathSync(cliOption)
      const interpreter = fs.realpathSync(nodeOption)
      assert.ok(path.isAbsolute(cli) && path.isAbsolute(interpreter))
      const packageRoot = fs.realpathSync(path.resolve(path.dirname(cli), ".."))
      const pm2Version = JSON.parse(read(path.join(packageRoot, "package.json"))).version
      assert.ok(isSupportedPm2Version(pm2Version), "Use an eligible real PM2 package")
      const pm2Hashes = fileHashes(packageRoot)
      const outsideHomes = new Set([path.join(os.homedir(), ".pm2")])
      if (process.env.PM2_HOME) outsideHomes.add(path.resolve(process.env.PM2_HOME))
      const outsideBefore = new Map([...outsideHomes].map(home => [home, outsideDaemonState(home)]))
      const fixture = await createEnvironmentFixture({ mode, label: "pm2-restore-linux" })
      const dist = path.join(fixture.pluginDir, "dist")
      const distHashes = fileHashes(dist)
      assert.deepEqual(
        distHashes,
        fileHashes(fileURLToPath(new URL("../dist/", import.meta.url))),
        "Record the exact tested Guard build",
      )
      const home = path.join(fixture.runRoot, "pm2-home")
      fs.mkdirSync(home)
      assert.equal(fs.realpathSync(path.dirname(home)), fs.realpathSync(fixture.runRoot))
      const env = privateEnvironment(home)
      const name = "guard-restore"
      const residentName = "guard-restore-resident"
      const residentScript = path.join(fixture.runRoot, "resident.cjs")
      const config = path.join(fixture.runRoot, "original.config.cjs")
      const residentConfig = path.join(fixture.runRoot, "resident.config.cjs")
      const dumpPath = path.join(home, "dump.pm2")
      fs.writeFileSync(residentScript, "setInterval(() => {}, 1000)\n")
      const declare = (file, application) =>
        fs.writeFileSync(file, "module.exports=" + JSON.stringify({ apps: [application] }) + "\n")
      declare(residentConfig, {
        name: residentName,
        script: residentScript,
        cwd: fixture.root,
        exec_mode: "fork",
        instances: 1,
        interpreter,
      })
      declare(config, {
        name,
        script: path.join(fixture.root, "app.js"),
        cwd: fixture.root,
        exec_mode: "fork",
        instances: 1,
        interpreter,
        env: { app_type: "pm2" },
      })
      const originalConfigHash = digest(fs.readFileSync(config))
      const originalResidentConfigHash = digest(fs.readFileSync(residentConfig))
      const commands = []
      const steps = []
      const ownedDaemons = new Map()
      const observed = new Map()
      let daemon, original, restored, residentBefore, residentAfter, saved, finalDump
      let restartCounters
      let failure, cleanupFailure, cleanup

      const rememberScope = pid => {
        const scope = snapshot(pid)
        for (const item of scope) observed.set(`${item.pid}:${item.start}`, item)
        return scope
      }
      const readDaemon = () => {
        const contents = read(path.join(home, "pm2.pid")).trim()
        if (!contents) return undefined
        assert.match(contents, /^\d+$/, "The private daemon pidfile must contain one PID")
        const value = identity(Number(contents))
        assert.ok(value, "The private PM2 daemon must still exist")
        return value
      }
      const recordDaemon = () => {
        const value = readDaemon()
        assert.ok(value, "The private PM2 daemon pidfile must exist")
        for (const outside of outsideBefore.values())
          assert.notDeepEqual(value, outside.processIdentity, "Never adopt an outside daemon")
        ownedDaemons.set(`${value.pid}:${value.start}`, value)
        daemon = value
        rememberScope(value.pid)
        return value
      }
      const pm2 = async args => {
        assert.equal(env.PM2_HOME, home)
        assert.ok(!outsideHomes.has(home), "Every command must use this test's unique PM2_HOME")
        const started = Date.now()
        try {
          const result = await execute(interpreter, [cli, ...args, "--silent"], {
            cwd: fixture.root,
            env,
            encoding: "utf8",
            timeout: 90000,
            maxBuffer: 4 * 1024 * 1024,
          })
          commands.push({ action: args[0], status: "passed", elapsedMs: Date.now() - started })
          return result.stdout.trim()
        } catch (error) {
          commands.push({ action: args[0], status: "failed", elapsedMs: Date.now() - started })
          // execFile 错误可能包含守护进程输出及完整应用环境，记录前须脱敏。
          throw new Error(`Private PM2 ${args[0]} failed (${String(error.code || "unknown")})`)
        }
      }
      const list = async () => {
        const value = JSON.parse(await pm2(["jlist"]))
        assert.ok(Array.isArray(value))
        return value
      }
      const checkDump = () => {
        assert.ok(fs.statSync(dumpPath).size < 4 * 1024 * 1024, "Bound the saved dump size")
        const rows = JSON.parse(read(dumpPath))
        assert.ok(Array.isArray(rows))
        assert.deepEqual(
          rows.map(row => row.name).sort(),
          [name, residentName].sort(),
          "The saved list must contain exactly Guard and the unrelated resident",
        )
        assertNoTicket(rows)
        const guard = rows.find(row => row.name === name)
        const resident = rows.find(row => row.name === residentName)
        assert.equal(fs.realpathSync(guard.pm_exec_path), fixture.launcher)
        assert.equal(fs.realpathSync(resident.pm_exec_path), residentScript)
        for (const row of [guard, resident]) {
          assert.equal(fs.realpathSync(row.exec_interpreter), interpreter)
          assert.equal(row.exec_mode, "fork_mode")
          assertNoPreload(row)
        }
        return {
          applications: rows.map(savedApplication),
          sha256: digest(fs.readFileSync(dumpPath)),
          launcherSaved: true,
          generationTicketAbsent: true,
        }
      }
      const checkOnline = async () => {
        const current = await fixture.waitOnline()
        const rows = await list()
        assert.deepEqual(rows.map(row => row.name).sort(), [name, residentName].sort())
        const guard = rows.find(row => row.name === name)
        const resident = rows.find(row => row.name === residentName)
        assert.equal(guard.pid, current.hostPid)
        assert.equal(guard.pm2_env.status, "online")
        assert.equal(guard.pm2_env.pm_exec_path, fixture.launcher)
        assert.equal(fs.realpathSync(guard.pm2_env.exec_interpreter), interpreter)
        assert.equal(resident.pm2_env.status, "online")
        assert.equal(resident.pm2_env.pm_exec_path, residentScript)
        assert.equal(fs.realpathSync(resident.pm2_env.exec_interpreter), interpreter)
        assertNoTicket(rows, "live daemon metadata")
        assertNoPreload(guard)
        assertNoPreload(resident)
        assert.equal(current.generation, 1)
        assert.equal(current.recoveryCount, 0)
        // 主 Yunzai Worker 使用 supervisor IPC；此计数仅覆盖 RuntimeBroker 中的辅助 Node 进程，本夹具没有此类进程。
        assert.equal(current.activeNodeRuntimes, 0)
        const scope = rememberScope(current.hostPid)
        assert.ok(scope.some(row => row.pid === current.hostPid))
        assert.ok(scope.some(row => row.pid === current.workerPid))
        const hosts = fixture.events().filter(event => event.hostPid === current.hostPid)
        assert.equal(hosts.filter(event => event.type === "host-lock-acquired").length, 1)
        assert.equal(hosts.filter(event => event.type === "worker-spawn").length, 1)
        assert.equal(hosts.filter(event => event.type === "worker-online").length, 1)
        assert.ok(!hosts.some(event => /failed|tripped/.test(event.type)))
        return {
          current,
          guardId: guard.pm_id,
          guardRestarts: guard.pm2_env.restart_time,
          resident: identity(resident.pid),
          residentRestarts: resident.pm2_env.restart_time,
        }
      }
      const stopOwnedDaemon = async () => {
        const current = readDaemon()
        if (!current) {
          if (daemon) await waitScopeGone(rememberedScopes())
          return
        }
        assert.ok(
          ownedDaemons.has(`${current.pid}:${current.start}`),
          "Refusing cleanup against an unrecorded daemon identity",
        )
        const scope = rememberScope(current.pid)
        await pm2(["kill"])
        await waitScopeGone(scope)
        await waitScopeGone(rememberedScopes())
        await until(
          () => !fs.existsSync(path.join(home, "pm2.pid")),
          "The private daemon pidfile must be removed before another daemon is started",
        )
        daemon = undefined
      }
      const rememberedScopes = () => [...observed.values()]
      try {
        // 先启动常驻应用，以验证 Guard 注册到已有守护进程。
        try {
          await pm2(["start", residentConfig])
        } finally {
          if (fs.existsSync(path.join(home, "pm2.pid"))) recordDaemon()
        }
        const firstDaemon = daemon
        const residentRow = (await list()).find(row => row.name === residentName)
        residentBefore = identity(residentRow.pid)
        assert.ok(residentBefore)
        await pm2(["start", config])
        const before = await checkOnline()
        original = before.current
        assert.equal(before.guardId, 1, "Only the existing resident may occupy PM2 id 0")
        assert.equal(before.guardRestarts, 1, "Ordinary app.js must perform one cold handoff")
        assert.deepEqual(before.resident, residentBefore, "Initial takeover must preserve resident")
        assert.deepEqual(readDaemon(), firstDaemon)
        steps.push({ action: "original-app-auto-takeover", status: "passed", preloadUsed: false })

        await pm2(["save"])
        saved = checkDump()
        restartCounters = {
          beforeSave: { guard: before.guardRestarts, resident: before.residentRestarts },
        }
        assert.equal(
          saved.applications.find(row => row.name === name).restartCount,
          before.guardRestarts,
        )
        assert.equal(digest(fs.readFileSync(config)), originalConfigHash)
        steps.push({ action: "save-launcher-without-ticket", status: "passed", applications: 2 })

        await stopOwnedDaemon()
        assert.ok(
          !identity(firstDaemon.pid) || identity(firstDaemon.pid).start !== firstDaemon.start,
        )
        await until(
          () => !fs.existsSync(path.join(fixture.stateDir, "control.json")),
          "The old Guard control entry must be removed before resurrect",
        )
        finalDump = checkDump()
        const daemonLogOffset = read(path.join(home, "pm2.log")).length
        const eventOffset = fixture.events().length
        const lifecycleOffset = fixture.lifecycle().length
        steps.push({
          action: "private-daemon-complete-exit",
          status: "passed",
          oldScopesGone: true,
          oldControlEntryGone: true,
        })
        // kill 到 resurrect 之间不调用 jlist，避免它提前启动新守护进程。
        try {
          await pm2(["resurrect"])
        } finally {
          if (fs.existsSync(path.join(home, "pm2.pid"))) recordDaemon()
        }
        const secondDaemon = daemon
        assert.ok(secondDaemon)
        assert.notDeepEqual(secondDaemon, firstDaemon, "Resurrect must use a fresh daemon identity")
        const after = await checkOnline()
        restored = after.current
        residentAfter = after.resident
        assert.ok(residentAfter, "The unrelated resident must be restored")
        assert.notDeepEqual(residentAfter, residentBefore, "Resident restoration is a new process")
        // PM2 可能通过 dump.env.pm_id 保留 restart_time，应按增量统计重启次数。
        restartCounters.afterResurrect = {
          guard: after.guardRestarts,
          resident: after.residentRestarts,
        }
        for (const role of ["guard", "resident"])
          assert.ok(
            [0, restartCounters.beforeSave[role]].includes(restartCounters.afterResurrect[role]),
            "Unexpected restore restart count",
          )
        assert.doesNotMatch(
          read(path.join(home, "pm2.log")).slice(daemonLogOffset),
          /"event":"pm2-handoff-requested"/,
          "Restoring launcher must not perform a cold handoff",
        )
        const postRestoreEvents = fixture.events().slice(eventOffset)
        assert.equal(
          new Set(postRestoreEvents.map(event => event.hostPid)).size,
          1,
          "Only one Guard host may log after resurrect",
        )
        assert.equal(postRestoreEvents.filter(event => event.type === "worker-spawn").length, 1)
        assert.equal(fixture.lifecycle().slice(lifecycleOffset).length, 1)
        assert.deepEqual(readDaemon(), secondDaemon)
        finalDump = checkDump()
        assert.equal(digest(fs.readFileSync(config)), originalConfigHash)
        assert.equal(digest(fs.readFileSync(residentConfig)), originalResidentConfigHash)
        fixture.verifyCoreHashes()
        assertHashes(dist, distHashes, "Guard dist")
        assertHashes(packageRoot, pm2Hashes, "Installed PM2 package")
        steps.push({
          action: "fresh-daemon-resurrect",
          status: "passed",
          daemonCreationChanged: true,
          residentRestored: true,
          guardHosts: 1,
          initialWorkers: 1,
          newColdHandoffRequired: false,
        })
        context.diagnostic(`PASS ${mode} save -> private daemon exit -> resurrect`)
      } catch (error) {
        failure = error
      } finally {
        try {
          await stopOwnedDaemon()
          await fixture.finish({ stop: false })
          await waitScopeGone(rememberedScopes())
          for (const [outsideHome, before] of outsideBefore)
            assert.deepEqual(
              outsideDaemonState(outsideHome),
              before,
              "An outside daemon pidfile or process identity changed",
            )
          fixture.verifyCoreHashes()
          assertHashes(dist, distHashes, "Guard dist")
          assertHashes(packageRoot, pm2Hashes, "Installed PM2 package")
          assert.equal(digest(fs.readFileSync(config)), originalConfigHash)
          assert.equal(digest(fs.readFileSync(residentConfig)), originalResidentConfigHash)
          cleanup = {
            confirmed: true,
            allObservedScopesGone: true,
            privateDaemonGone: true,
            outsideDaemonsReadOnlyAndUnchanged: true,
          }
        } catch (error) {
          cleanupFailure = error
        }
        fs.writeFileSync(
          path.join(fixture.runRoot, "pm2-restore-linux-report.json"),
          JSON.stringify(
            {
              platform: process.platform,
              node: process.version,
              interpreter,
              pm2: pm2Version,
              mode,
              status: failure || cleanupFailure ? "failed" : "passed",
              scope: "PM2 save/resurrect recovery chain; no service registration or host reboot",
              originalEntry: "app.js",
              originalEcosystemUnchanged: digest(fs.readFileSync(config)) === originalConfigHash,
              privateDaemonIdentities: [...ownedDaemons.values()],
              initialGuard: original && {
                hostPid: original.hostPid,
                workerPid: original.workerPid,
                generation: original.generation,
                activeNodeRuntimes: original.activeNodeRuntimes,
              },
              restoredGuard: restored && {
                hostPid: restored.hostPid,
                workerPid: restored.workerPid,
                generation: restored.generation,
                activeNodeRuntimes: restored.activeNodeRuntimes,
              },
              runtimeCounterMeaning:
                "activeNodeRuntimes counts authenticated auxiliary Node broker peers; the primary Yunzai worker uses separate supervisor IPC and is checked by PID, scope and lifecycle events",
              residentBefore,
              residentAfter,
              restartCounters,
              saved,
              finalDump,
              sourceSnapshot: {
                guardDistHashes: distHashes,
                guardDistFileCount: Object.keys(distHashes).length,
                coreFileHashCount: 47,
                installedPm2FileHashCount: Object.keys(pm2Hashes).length,
                installedPm2HashesDigest: digest(JSON.stringify(pm2Hashes)),
              },
              redisFixture: fixture.redisFixture,
              steps,
              commands,
              cleanup,
              error: failure?.stack,
              cleanupError: cleanupFailure?.stack,
            },
            null,
            2,
          ) + "\n",
        )
        context.diagnostic(`Evidence: ${fixture.runRoot}`)
      }
      if (failure && cleanupFailure) throw new AggregateError([failure, cleanupFailure])
      if (failure) throw failure
      if (cleanupFailure) throw cleanupFailure
    },
  )
