import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { execFile, spawn } from "node:child_process"
import { createHash } from "node:crypto"
import { promisify } from "node:util"
import { fileURLToPath } from "node:url"
import test from "node:test"
import { createEnvironmentFixture, snapshot, until, waitScopeGone } from "./environment-fixture.mjs"

const execute = promisify(execFile)
const enabled = process.platform === "linux" && process.env.GUARD_TEST_PM2_AUTO === "1"
const modes = process.env.GUARD_TEST_PM2_MODES?.split(",") || ["managed", "os-sandbox"]
const daemonStates = process.env.GUARD_TEST_PM2_AUTO_DAEMONS?.split(",") || ["cold", "existing"]
assert.ok(modes.every(mode => ["managed", "os-sandbox"].includes(mode)))
assert.ok(daemonStates.every(state => ["cold", "existing"].includes(state)))
const cycles = Number(process.env.GUARD_TEST_PM2_CYCLES || 10)
assert.ok(Number.isSafeInteger(cycles) && cycles >= 10)
const interpreterSelection = process.env.GUARD_TEST_PM2_INTERPRETER || "absolute"
const interpreter = interpreterSelection === "absolute" ? process.execPath : interpreterSelection
assert.ok(interpreter === "node" || path.isAbsolute(interpreter))
const interpreterKind = interpreter === "node" ? "node" : "absolute"
const cli =
  process.env.GUARD_PM2_CLI ||
  path.join(process.env.GUARD_TEST_PM2_PACKAGE || "/usr/local/lib/node_modules/pm2", "bin/pm2")
const digest = value => createHash("sha256").update(JSON.stringify(value)).digest("hex")
const pause = ms => new Promise(resolve => setTimeout(resolve, ms))
const read = file => (fs.existsSync(file) ? fs.readFileSync(file, "utf8") : "")
let priorMatrixFailure = false

function normalized(value) {
  if (Array.isArray(value)) return value.map(normalized)
  if (!value || typeof value !== "object") return value
  return Object.fromEntries(
    Object.keys(value)
      .sort()
      .map(key => [key, normalized(value[key])]),
  )
}

function unrelatedState(row) {
  assert.ok(row)
  return {
    pid: row.pid,
    id: row.pm_id,
    status: row.pm2_env.status,
    restarts: row.pm2_env.restart_time,
    environmentDigest: digest(normalized(row.pm2_env.env)),
    script: row.pm2_env.pm_exec_path,
    cwd: row.pm2_env.pm_cwd,
    interpreter: row.pm2_env.exec_interpreter,
    nodeArgs: row.pm2_env.node_args,
  }
}

function assertNoPreload(row) {
  assert.ok(row.pm2_env.env && typeof row.pm2_env.env === "object")
  for (const key of ["NODE_OPTIONS", "PM2_NODE_OPTIONS"])
    assert.equal(Object.hasOwn(row.pm2_env.env, key), false, `Application inherited ${key}`)
  assert.doesNotMatch(
    JSON.stringify(row.pm2_env.node_args || []),
    /pm2-preload|namespace|--require/,
  )
}

function guardEvents(text) {
  return text.split("\n").flatMap(line => {
    const marker = "[Yunzai Guard PM2] "
    const index = line.indexOf(marker)
    const payload = index < 0 ? "" : line.slice(index + marker.length).trim()
    return payload.startsWith("{") ? [JSON.parse(payload)] : []
  })
}

function assertUnrelatedEvents(events, unrelated) {
  assert.ok(
    !events.some(
      event => event.pid === unrelated.pid || String(event.pmId) === String(unrelated.id),
    ),
    "Guard must not register or stop the unrelated application",
  )
}

function pm2SourceHashes(root) {
  const result = {}
  function visit(directory) {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const file = path.join(directory, entry.name)
      if (entry.isDirectory()) visit(file)
      else if (entry.isFile()) result[path.relative(root, file)] = digest(read(file))
    }
  }
  visit(path.join(root, "lib"))
  if (fs.existsSync(path.join(root, "modules"))) visit(path.join(root, "modules"))
  for (const file of ["paths.js", "package.json"])
    result[file] = digest(read(path.join(root, file)))
  return result
}

function guardDistHashes(pluginDir) {
  const root = path.join(pluginDir, "dist")
  const result = {}
  function visit(directory) {
    for (const entry of fs
      .readdirSync(directory, { withFileTypes: true })
      .sort((a, b) => a.name.localeCompare(b.name))) {
      const file = path.join(directory, entry.name)
      if (entry.isDirectory()) visit(file)
      else {
        assert.equal(
          entry.isFile(),
          true,
          "Guard dist must contain only directories and regular files",
        )
        result[path.relative(root, file)] = createHash("sha256")
          .update(fs.readFileSync(file))
          .digest("hex")
      }
    }
  }
  visit(root)
  return result
}

function identity(pid) {
  const result = snapshot(pid).find(row => row.pid === pid)
  assert.ok(result, "Expected a live private process")
  return result
}

function execEnvironment(processIdentity) {
  assert.deepEqual(identity(processIdentity.pid), processIdentity)
  const entries = fs
    .readFileSync(`/proc/${processIdentity.pid}/environ`, "utf8")
    .split("\0")
    .filter(Boolean)
    .sort()
  assert.deepEqual(identity(processIdentity.pid), processIdentity)
  return {
    digest: digest(entries),
    keyCount: entries.length,
    nodeOptionsAbsent: !entries.some(value => value.startsWith("NODE_OPTIONS=")),
    pm2NodeOptionsAbsent: !entries.some(value => value.startsWith("PM2_NODE_OPTIONS=")),
  }
}

function privateEnvironment(home) {
  const result = {}
  for (const key of [
    "PATH",
    "HOME",
    "USER",
    "LOGNAME",
    "SHELL",
    "TMPDIR",
    "TMP",
    "TEMP",
    "LANG",
    "LC_ALL",
    "LC_CTYPE",
    "TZ",
    "XDG_RUNTIME_DIR",
  ])
    if (process.env[key] !== undefined) result[key] = process.env[key]
  return {
    ...result,
    PM2_HOME: home,
    PM2_NO_INTERACTION: "true",
    PM2_DISCRETE_MODE: "true",
    NO_COLOR: "1",
  }
}

function telemetry(file, after = 0) {
  return until(
    () => {
      try {
        const value = JSON.parse(read(file))
        return value.observedAt >= after ? value : false
      } catch (error) {
        if (error instanceof SyntaxError || error.code === "ENOENT") return false
        throw error
      }
    },
    "Resident did not publish fresh environment telemetry",
    10000,
  )
}

for (const mode of modes)
  for (const daemonState of daemonStates)
    test(
      `Linux zero-config PM2 app.js (${mode}, ${daemonState} daemon, ${interpreterKind})`,
      { skip: enabled ? false : "requires GUARD_TEST_PM2_AUTO=1 on Linux", timeout: 1200000 },
      async context => {
        if (priorMatrixFailure) {
          context.skip("An earlier matrix case failed; its cleanup has completed")
          return
        }
        const defaultPidFile = path.join(
          process.env.PM2_HOME || path.join(os.homedir(), ".pm2"),
          "pm2.pid",
        )
        const defaultPidBefore = fs.existsSync(defaultPidFile)
          ? fs.readFileSync(defaultPidFile)
          : null
        const fixture = await createEnvironmentFixture({ mode, label: "pm2a-linux" })
        const testedDist = guardDistHashes(fixture.pluginDir)
        assert.deepEqual(
          testedDist,
          guardDistHashes(
            process.env.GUARD_TEST_GUARD_SOURCE ?? fileURLToPath(new URL("../", import.meta.url)),
          ),
        )
        assert.equal(Object.keys(fixture.expectedHashes).length, 47)
        const home = path.join(fixture.runRoot, "pm2-home")
        for (const directory of ["", "logs", "pids", "modules"])
          fs.mkdirSync(path.join(home, directory), { recursive: true })
        fs.writeFileSync(path.join(home, "module_conf.json"), "{}\n")
        fs.writeFileSync(path.join(home, "touch"), "test-owned\n")
        const env = privateEnvironment(home)
        const packageRoot = fs.realpathSync(path.resolve(path.dirname(cli), ".."))
        const pm2Version = JSON.parse(read(path.join(packageRoot, "package.json"))).version
        const sources = pm2SourceHashes(packageRoot)
        const name = "guard-auto",
          unrelatedName = "guard-unrelated"
        const config = path.join(fixture.runRoot, "original.config.cjs")
        const other = path.join(fixture.runRoot, "other.config.cjs")
        const resident = path.join(fixture.runRoot, "resident.cjs")
        const residentTelemetry = path.join(fixture.runRoot, "resident-telemetry.json")
        const applicationLog = path.join(fixture.runRoot, "application-error.log")
        const daemonLog = path.join(home, "pm2.log")
        fs.writeFileSync(
          resident,
          `const fs=require("node:fs"),crypto=require("node:crypto");const sample=()=>fs.writeFileSync(${JSON.stringify(residentTelemetry)},JSON.stringify({pid:process.pid,observedAt:Date.now(),environmentDigest:crypto.createHash("sha256").update(JSON.stringify(Object.fromEntries(Object.keys(process.env).sort().map(key=>[key,process.env[key]])))).digest("hex"),nodeOptionsAbsent:!("NODE_OPTIONS" in process.env),pm2NodeOptionsAbsent:!("PM2_NODE_OPTIONS" in process.env)}));sample();setInterval(sample,100);\n`,
        )
        const declare = (file, application) =>
          fs.writeFileSync(file, "module.exports=" + JSON.stringify({ apps: [application] }) + "\n")
        declare(other, {
          name: unrelatedName,
          script: resident,
          cwd: fixture.root,
          exec_mode: "fork",
          instances: 1,
          interpreter: process.execPath,
        })
        declare(config, {
          name,
          script: path.join(fixture.root, "app.js"),
          cwd: fixture.root,
          exec_mode: "fork",
          instances: 1,
          interpreter,
          merge_logs: true,
          error_file: applicationLog,
          out_file: path.join(fixture.runRoot, "application-output.log"),
          env: { app_type: "pm2" },
        })
        const configHashes = { original: digest(read(config)), unrelated: digest(read(other)) }
        const commands = [],
          steps = [],
          observed = new Map()
        let daemonProcess, daemon, daemonExecEnvironment, daemonRuntimeEnvironment
        let unrelated, unrelatedIdentity, unrelatedExecEnvironment, residentRuntimeEnvironment
        let failure, cleanup, cleanupFailure, initialHandoff
        const capture = pid => {
          const scope = snapshot(pid)
          for (const value of scope) observed.set(`${value.pid}:${value.start}`, value)
          return scope
        }
        const progress = status =>
          fs.writeFileSync(
            path.join(fixture.runRoot, "auto-progress.json"),
            JSON.stringify(
              { mode, daemonState, interpreterKind, pm2Version, status, steps },
              null,
              2,
            ) + "\n",
          )
        const assertPreserved = () => {
          fixture.verifyCoreHashes()
          assert.deepEqual(guardDistHashes(fixture.pluginDir), testedDist)
          assert.deepEqual(pm2SourceHashes(packageRoot), sources)
          assert.equal(digest(read(config)), configHashes.original)
          assert.equal(digest(read(other)), configHashes.unrelated)
          assert.deepEqual(
            fs.existsSync(defaultPidFile) ? fs.readFileSync(defaultPidFile) : null,
            defaultPidBefore,
            "Default PM2 PID file changed",
          )
        }
        const daemonIdentity = () => {
          const pid = Number(read(path.join(home, "pm2.pid")).trim())
          assert.ok(Number.isSafeInteger(pid) && pid > 1)
          return identity(pid)
        }
        const pm2 = async args => {
          assert.equal(env.PM2_HOME, home)
          if (daemon)
            assert.deepEqual(
              daemonIdentity(),
              daemon,
              "Refusing PM2 CLI against a missing or replaced daemon",
            )
          commands.push({
            action: args[0],
            route: args.includes(config)
              ? "original-ecosystem"
              : args.includes(other)
                ? "resident-ecosystem"
                : "name",
          })
          try {
            const result = await execute(process.execPath, [cli, ...args, "--silent"], {
              cwd: fixture.root,
              env,
              encoding: "utf8",
              timeout: 90000,
              maxBuffer: 4 * 1024 * 1024,
            })
            return result.stdout.trim()
          } catch {
            throw new Error(`Private PM2 ${args[0]} command failed`)
          }
        }
        const list = async () => JSON.parse(await pm2(["jlist"]))
        const daemonEnvironment = async () => {
          assert.deepEqual(daemonIdentity(), daemon)
          // 私有 socket RPC 不会自动启动或回退到默认守护进程。
          const axon = fs.existsSync(path.join(packageRoot, "modules", "pm2-axon"))
            ? path.join(packageRoot, "modules", "pm2-axon")
            : "pm2-axon"
          const rpc = fs.existsSync(path.join(packageRoot, "modules", "pm2-axon"))
            ? path.join(packageRoot, "modules", "pm2-axon-rpc")
            : "pm2-axon-rpc"
          const script = `const req=require("node:module").createRequire(${JSON.stringify(path.join(packageRoot, "package.json"))}),crypto=require("node:crypto"),s=req(${JSON.stringify(axon)}).socket("req"),r=new(req(${JSON.stringify(rpc)}).Client)(s);const stable=v=>Array.isArray(v)?v.map(stable):v&&typeof v==="object"?Object.fromEntries(Object.keys(v).sort().map(k=>[k,stable(v[k])])):v;const timeout=setTimeout(()=>{s.close();process.exitCode=1},8000);s.connect(${JSON.stringify(path.join(home, "rpc.sock"))});r.call("getReport",{},(error,value)=>{clearTimeout(timeout);s.close();if(error||!value||!value.env){process.exitCode=1;return}process.stdout.write(JSON.stringify({digest:crypto.createHash("sha256").update(JSON.stringify(stable(value.env))).digest("hex"),nodeOptionsAbsent:!("NODE_OPTIONS" in value.env),pm2NodeOptionsAbsent:!("PM2_NODE_OPTIONS" in value.env)}))});`
          let result
          try {
            result = await execute(process.execPath, ["-e", script], {
              cwd: fixture.runRoot,
              env,
              timeout: 15000,
              maxBuffer: 1024 * 1024,
              encoding: "utf8",
            })
          } catch {
            throw new Error("Private daemon runtime environment RPC failed")
          }
          assert.deepEqual(daemonIdentity(), daemon)
          return JSON.parse(result.stdout)
        }
        const startResident = async () => {
          await pm2(["start", other])
          const row = (await list()).find(row => row.name === unrelatedName)
          unrelated = unrelatedState(row)
          assertNoPreload(row)
          assert.equal(unrelated.status, "online")
          assert.equal(unrelated.restarts, 0)
          unrelatedIdentity = identity(unrelated.pid)
          unrelatedExecEnvironment = execEnvironment(unrelatedIdentity)
          const current = await telemetry(residentTelemetry)
          residentRuntimeEnvironment = {
            environmentDigest: current.environmentDigest,
            nodeOptionsAbsent: current.nodeOptionsAbsent,
            pm2NodeOptionsAbsent: current.pm2NodeOptionsAbsent,
          }
          assert.equal(current.pid, unrelated.pid)
          assert.equal(current.nodeOptionsAbsent, true)
          assert.equal(current.pm2NodeOptionsAbsent, true)
          capture(unrelated.pid)
        }
        const assertResident = async (rows, after = 0) => {
          assert.deepEqual(unrelatedState(rows.find(row => row.name === unrelatedName)), unrelated)
          assert.deepEqual(identity(unrelated.pid), unrelatedIdentity)
          assert.deepEqual(execEnvironment(unrelatedIdentity), unrelatedExecEnvironment)
          const current = await telemetry(residentTelemetry, after)
          assert.equal(current.pid, unrelated.pid)
          assert.deepEqual(
            {
              environmentDigest: current.environmentDigest,
              nodeOptionsAbsent: current.nodeOptionsAbsent,
              pm2NodeOptionsAbsent: current.pm2NodeOptionsAbsent,
            },
            residentRuntimeEnvironment,
          )
          assert.deepEqual(daemonIdentity(), daemon)
          assert.deepEqual(execEnvironment(daemon), daemonExecEnvironment)
          assert.deepEqual(await daemonEnvironment(), daemonRuntimeEnvironment)
        }
        try {
          context.diagnostic(`Evidence: ${fixture.runRoot}`)
          progress("starting")
          const output = fs.openSync(daemonLog, "a")
          try {
            daemonProcess = spawn(
              process.execPath,
              ["--inspect-port=0", path.join(packageRoot, "lib", "Daemon.js")],
              {
                cwd: fixture.runRoot,
                env,
                detached: true,
                stdio: ["ignore", output, output, "ipc"],
              },
            )
          } finally {
            fs.closeSync(output)
          }
          if (daemonProcess.pid) capture(daemonProcess.pid)
          await new Promise((resolve, reject) => {
            const timer = setTimeout(
              () => reject(new Error("Private PM2 daemon readiness timeout")),
              30000,
            )
            daemonProcess.once("error", () => {
              clearTimeout(timer)
              reject(new Error("Private PM2 daemon failed to spawn"))
            })
            daemonProcess.once("exit", code => {
              clearTimeout(timer)
              reject(new Error(`Private PM2 daemon exited: ${code}`))
            })
            daemonProcess.on("message", message => {
              if (!message?.online || message.pid !== daemonProcess.pid) return
              clearTimeout(timer)
              daemonProcess.disconnect()
              resolve()
            })
          })
          daemonProcess.unref()
          daemon = daemonIdentity()
          assert.equal(daemon.pid, daemonProcess.pid)
          daemonExecEnvironment = execEnvironment(daemon)
          daemonRuntimeEnvironment = await daemonEnvironment()
          assert.equal(daemonRuntimeEnvironment.nodeOptionsAbsent, true)
          assert.equal(daemonRuntimeEnvironment.pm2NodeOptionsAbsent, true)
          assert.equal((await list()).length, 0)
          if (daemonState === "existing") await startResident()
          await pm2(["start", config])
          let current = await fixture.waitOnline(1, { timeout: 90000 })
          assert.ok(fs.existsSync(applicationLog), "Expected the configured application log")
          let rows = await list()
          let row = rows.find(item => item.name === name)
          assertNoPreload(row)
          assert.equal(row.pm_id, daemonState === "existing" ? 1 : 0)
          assert.equal(row.pid, current.hostPid)
          assert.equal(row.pm2_env.status, "online")
          assert.equal(row.pm2_env.pm_exec_path, fixture.launcher)
          assert.equal(
            row.pm2_env.restart_time,
            1,
            "Initial handoff must restart only its own app once",
          )
          assert.equal(current.capabilities.osSandbox, mode === "os-sandbox")
          const initialEvents = guardEvents(read(daemonLog))
          const registrations = initialEvents.filter(
            event => event.event === "pm2-application-registered",
          )
          const handoffs = initialEvents.filter(event => event.event === "pm2-handoff-requested")
          assert.equal(registrations.length, 1)
          assert.equal(handoffs.length, 1)
          assert.equal(String(registrations[0].pmId), String(row.pm_id))
          assert.equal(handoffs[0].pid, registrations[0].pid)
          assert.notEqual(handoffs[0].pid, current.hostPid)
          assert.ok(
            initialEvents.some(
              event => event.event === "pm2-exit-barrier-complete" && event.pid === handoffs[0].pid,
            ),
          )
          initialHandoff = { sameApplicationId: true, targetedRestarts: 1, barrierConfirmed: true }
          if (daemonState === "cold") {
            await startResident()
            rows = await list()
          }
          assert.equal(rows.length, 2)
          await assertResident(rows)
          capture(current.hostPid)
          assertPreserved()
          for (let round = 0; round < cycles; round++)
            for (const action of ["restart", "reload"]) {
              const old = current,
                oldScope = capture(old.hostPid)
              assert.ok(oldScope.length >= 2, "Controlled host and worker must both exist")
              const previousCounter = row.pm2_env.restart_time,
                previousId = row.pm_id
              const offset = read(daemonLog).length,
                eventOffset = fixture.events().length
              const lifecycleCount = fixture.lifecycle().length,
                errorOffset = read(applicationLog).length
              const route = round % 2 ? "original-ecosystem" : "name"
              const step = {
                index: steps.length + 1,
                round: round + 1,
                action,
                route,
                status: "running",
              }
              steps.push(step)
              progress("running")
              const operationAt = Date.now()
              await pm2(route === "name" ? [action, name] : [action, config, "--only", name])
              current = await fixture.waitForStatus(
                state => state.phase === "online" && state.hostPid !== old.hostPid,
                {
                  timeout: 90000,
                  description: `Native ${action} did not produce a new online host`,
                },
              )
              await waitScopeGone(oldScope)
              await pause(150)
              current = await fixture.status()
              rows = await list()
              row = rows.find(item => item.name === name)
              assertNoPreload(row)
              assert.equal(rows.length, 2)
              assert.equal(current.phase, "online")
              assert.equal(row.pid, current.hostPid)
              assert.equal(row.pm_id, previousId)
              assert.equal(row.pm2_env.status, "online")
              assert.equal(row.pm2_env.restart_time, previousCounter + 1)
              assert.equal(row.pm2_env.pm_exec_path, fixture.launcher)
              assert.equal(current.recoveryCount, 0)
              await assertResident(rows, operationAt)
              const events = guardEvents(read(daemonLog).slice(offset))
              assert.equal(
                events.filter(
                  event =>
                    event.event === "pm2-exit-barrier-complete" &&
                    event.pid === old.hostPid &&
                    String(event.pmId) === String(previousId),
                ).length,
                1,
              )
              assert.equal(
                events.filter(event => event.event === "pm2-exit-barrier-failed").length,
                0,
              )
              assert.equal(
                events.filter(event => event.event === "pm2-handoff-requested").length,
                0,
              )
              assertUnrelatedEvents(events, unrelated)
              const hostEvents = fixture.events().slice(eventOffset)
              assert.equal(
                hostEvents.filter(event => event.type === "host-lock-acquired").length,
                1,
              )
              assert.equal(hostEvents.filter(event => event.type === "worker-spawn").length, 1)
              assert.equal(fixture.lifecycle().length, lifecycleCount + 1)
              assert.doesNotMatch(
                read(applicationLog).slice(errorOffset),
                /宿主锁被拒绝|project-lock-error/,
              )
              capture(current.hostPid)
              assertPreserved()
              Object.assign(step, {
                status: "passed",
                previousHostPid: old.hostPid,
                hostPid: current.hostPid,
                workerPid: current.workerPid,
                restartCounter: row.pm2_env.restart_time,
                barrierConfirmed: true,
                oldObservedScopeGone: true,
                singletonConfirmed: true,
                daemonIdentityUnchanged: true,
                daemonExecEnvironmentUnchanged: true,
                daemonRuntimeEnvironmentUnchanged: true,
                unrelatedApplicationAndRuntimeEnvironmentUnchanged: true,
                coreAndDistUnchanged: true,
                originalConfigUnchanged: true,
                defaultPidFileUnchanged: true,
              })
              progress("running")
              context.diagnostic(
                `PASS ${mode}/${daemonState}/${interpreterKind}: ${action} ${route} ${round + 1}`,
              )
            }
          assert.equal(steps.length, cycles * 2)
          assertUnrelatedEvents(guardEvents(read(daemonLog)), unrelated)
          assertPreserved()
        } catch (error) {
          priorMatrixFailure = true
          failure = error
          const step = steps.find(step => step.status === "running")
          if (step) step.status = "failed"
        } finally {
          try {
            if (daemon) {
              assert.deepEqual(
                daemonIdentity(),
                daemon,
                "Refusing cleanup against a different daemon",
              )
              capture(daemon.pid)
              await pm2(["kill"])
            } else if (
              daemonProcess?.pid &&
              daemonProcess.exitCode === null &&
              daemonProcess.signalCode === null
            ) {
              capture(daemonProcess.pid)
              daemonProcess.kill("SIGTERM")
            }
            await waitScopeGone([...observed.values()])
            await fixture.finish({ stop: false })
            assertPreserved()
            cleanup = {
              confirmed: true,
              observedScopesGone: true,
              observedIdentities: observed.size,
              coreFilesUnchanged: true,
              guardDistUnchanged: true,
              installedPm2Unchanged: true,
              originalConfigsUnchanged: true,
              defaultPidFileUnchanged: true,
            }
          } catch (error) {
            priorMatrixFailure = true
            cleanupFailure = error
          }
          progress(failure || cleanupFailure ? "failed" : "passed")
          fs.writeFileSync(
            path.join(fixture.runRoot, "pm2-auto-linux-report.json"),
            JSON.stringify(
              {
                platform: process.platform,
                arch: process.arch,
                node: process.version,
                pm2: pm2Version,
                pm2Version,
                mode,
                daemonState,
                existingDaemon: daemonState === "existing",
                interpreterKind,
                interpreter,
                status: failure || cleanupFailure ? "failed" : "passed",
                originalEntry: "app.js",
                guardDaemonPreload: false,
                daemonStartedWithoutInspector: true,
                inspectorPortSelection: "ephemeral-unopened",
                initialHandoff,
                cyclesPerAction: cycles,
                daemonIdentity: daemon,
                environmentEvidence: {
                  daemonExecEnvironment,
                  daemonRuntimeEnvironment,
                  unrelatedExecEnvironment,
                  residentRuntimeEnvironment,
                },
                sourceSnapshot: {
                  guardDistHashes: testedDist,
                  guardDistFileCount: Object.keys(testedDist).length,
                  coreFileHashCount: 47,
                  installedPm2SourceDigest: digest(sources),
                },
                originalConfigHashes: configHashes,
                defaultPidFileExisted: defaultPidBefore !== null,
                redisFixture: fixture.redisFixture,
                dependencyLayout: fixture.dependencyLayout,
                namespaceNote:
                  "Real PM2 with private Unix sockets and an allowlisted daemon/CLI environment; no Guard preload or installed source edits. /proc hashes prove initial exec environment; getReport.env and resident self-telemetry independently prove runtime environment. Observed scope snapshots do not track future descendants exhaustively.",
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
