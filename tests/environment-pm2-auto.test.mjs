import assert from "node:assert/strict"
import fs from "node:fs"
import net from "node:net"
import path from "node:path"
import { execFileSync } from "node:child_process"
import test from "node:test"
import { createWindowsPm2Fixture, environmentDigest } from "./pm2-windows-fixture.mjs"
import { until, waitScopeGone } from "./environment-fixture.mjs"

const enabled = process.platform === "win32" && process.env.GUARD_TEST_PM2_AUTO === "1"
const selections = process.env.GUARD_TEST_PM2_AUTO_CASES?.split(",") || ["matrix"]
assert.ok(selections.every(value => ["matrix", "reuse", "collision"].includes(value)))
const modes = process.env.GUARD_TEST_PM2_MODES?.split(",") || ["managed", "os-sandbox"]
const daemonStates = process.env.GUARD_TEST_PM2_AUTO_DAEMONS?.split(",") || ["cold", "existing"]
assert.ok(modes.every(mode => ["managed", "os-sandbox"].includes(mode)))
assert.ok(daemonStates.every(state => ["cold", "existing"].includes(state)))
const cycles = Number(process.env.GUARD_TEST_PM2_CYCLES || 10)
assert.ok(Number.isSafeInteger(cycles) && cycles >= 10)
const pause = ms => new Promise(resolve => setTimeout(resolve, ms))
const read = file => (fs.existsSync(file) ? fs.readFileSync(file, "utf8") : "")
let priorMatrixFailure = false

function guardEvents(text) {
  return text.split("\n").flatMap(line => {
    const marker = "[Yunzai Guard PM2] "
    const start = line.indexOf(marker)
    const payload = start < 0 ? "" : line.slice(start + marker.length).trim()
    return payload.startsWith("{") ? [JSON.parse(payload)] : []
  })
}

function appState(row) {
  assert.ok(row, "Expected PM2 application")
  return {
    id: row.pm_id,
    pid: row.pid,
    status: row.pm2_env.status,
    restarts: row.pm2_env.restart_time,
    script: row.pm2_env.pm_exec_path,
    cwd: row.pm2_env.pm_cwd,
    interpreter: row.pm2_env.exec_interpreter,
    nodeArgs: row.pm2_env.node_args,
    environmentDigest: environmentDigest(row.pm2_env.env),
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

function ownedListeners(pid) {
  const raw = execFileSync("netstat.exe", ["-ano", "-p", "TCP"], {
    encoding: "utf8",
    windowsHide: true,
    timeout: 5000,
    maxBuffer: 4 * 1024 * 1024,
  })
  return raw.split(/\r?\n/).flatMap(line => {
    const fields = line.trim().split(/\s+/)
    if (fields[0] !== "TCP" || fields[3] !== "LISTENING" || Number(fields[4]) !== pid) return []
    const match = /^(127\.0\.0\.1|\[::1\]):(\d+)$/.exec(fields[1])
    return match ? [{ host: match[1], port: Number(match[2]) }] : []
  })
}

async function inspectorEndpoints(pid) {
  const result = []
  for (const { host, port } of ownedListeners(pid)) {
    try {
      const response = await fetch(`http://${host}:${port}/json/list`, {
        signal: AbortSignal.timeout(1000),
        redirect: "error",
      })
      const targets = await response.json()
      if (Array.isArray(targets))
        for (const target of targets)
          if (target.type === "node" && typeof target.webSocketDebuggerUrl === "string")
            result.push({ port, url: target.webSocketDebuggerUrl })
    } catch {}
  }
  return result.sort((a, b) => a.port - b.port)
}

async function assertDefaultPortFree() {
  const server = net.createServer()
  await new Promise((resolve, reject) => {
    server.once("error", () => reject(new Error("Default Inspector port 9229 is already occupied")))
    server.listen(9229, "127.0.0.1", resolve)
  })
  await new Promise(resolve => server.close(resolve))
}

function assertUnrelatedEvents(events, unrelated) {
  assert.ok(
    !events.some(
      event => event.pid === unrelated.pid || String(event.pmId) === String(unrelated.id),
    ),
    "Guard registration and barriers must not touch the unrelated application",
  )
}

function waitAutoOnline(fixture) {
  return until(
    async () => {
      assert.doesNotMatch(
        read(path.join(fixture.runRoot, "application-error.log")),
        /PM2 自动接管失败/,
        "Original app.js automatic takeover failed",
      )
      try {
        const state = await fixture.status()
        assert.notEqual(state.phase, "tripped", "Automatic takeover tripped")
        return state.phase === "online" ? state : false
      } catch (error) {
        if (["ENOENT", "ECONNREFUSED", "ECONNRESET"].includes(error.code)) return false
        throw error
      }
    },
    "Original app.js did not become controlled and online",
    90000,
  )
}

function readTelemetry(file) {
  return until(
    () => {
      try {
        return JSON.parse(read(file))
      } catch (error) {
        if (error instanceof SyntaxError || ["ENOENT", "EBUSY"].includes(error.code)) return false
        throw error
      }
    },
    "Unrelated resident did not publish complete telemetry",
    10000,
  )
}

for (const mode of modes)
  for (const daemonState of daemonStates)
    test(
      `Windows zero-config PM2 app.js (${mode}, ${daemonState} daemon)`,
      {
        skip:
          enabled && selections.includes("matrix")
            ? false
            : "requires Windows PM2 auto matrix gate",
        timeout: 1200000,
      },
      async context => {
        if (priorMatrixFailure) {
          context.skip("An earlier matrix case failed; its cleanup has completed")
          return
        }
        const harness = await createWindowsPm2Fixture({ mode, zeroConfig: true })
        const { fixture, pm2, name, unrelatedName } = harness
        const daemonLog = path.join(pm2.home, "pm2.log")
        const applicationLog = path.join(fixture.runRoot, "application-error.log")
        const progressPath = path.join(fixture.runRoot, "auto-progress.json")
        const useDefaultPort =
          process.env.GUARD_TEST_PM2_AUTO_DEFAULT_PORT === "1" &&
          mode === modes[0] &&
          daemonState === "cold"
        const steps = []
        let failure, cleanup, cleanupFailure, daemon, daemonEnvironment, unrelated, telemetry
        let initialHandoff,
          inspectorClosed = false
        const progress = status =>
          fs.writeFileSync(
            progressPath,
            JSON.stringify(
              { mode, daemonState, interpreterKind: harness.interpreterKind, status, steps },
              null,
              2,
            ) + "\n",
          )
        async function assertResident(rows) {
          assert.deepEqual(appState(rows.find(row => row.name === unrelatedName)), unrelated)
          const current = await readTelemetry(harness.unrelatedTelemetry)
          assert.equal(current.pid, telemetry.pid)
          assert.equal(current.envDigest, telemetry.envDigest)
          assert.equal(current.nodeOptionsAbsent, true)
          assert.equal(current.pm2NodeOptionsAbsent, true)
          assert.deepEqual(pm2.observeDaemon(), daemon)
          assert.deepEqual(await pm2.daemonEnvironment(), daemonEnvironment)
        }
        try {
          context.diagnostic(`Evidence: ${fixture.runRoot}`)
          progress("starting")
          if (useDefaultPort) await assertDefaultPortFree()
          daemon = await pm2.startDaemon({ inspectPort: useDefaultPort ? null : 0 })
          daemonEnvironment = await pm2.daemonEnvironment()
          assert.equal(daemonEnvironment.nodeOptionsAbsent, true)
          assert.equal(daemonEnvironment.pm2NodeOptionsAbsent, true)
          assert.deepEqual(await inspectorEndpoints(daemon.pid), [])
          assert.equal((await pm2.listRaw()).length, 0)
          if (daemonState === "existing") {
            await pm2.cli(["start", harness.unrelatedConfigPath])
            const row = (await pm2.listRaw()).find(row => row.name === unrelatedName)
            unrelated = appState(row)
            assertNoPreload(row)
            assert.equal(unrelated.status, "online")
            assert.equal(unrelated.restarts, 0)
            telemetry = await readTelemetry(harness.unrelatedTelemetry)
          }
          await pm2.cli(["start", harness.targetConfigPath])
          let current = await waitAutoOnline(fixture)
          let rows = await pm2.listRaw()
          let row = rows.find(row => row.name === name)
          let app = appState(row)
          assertNoPreload(row)
          assert.equal(app.id, daemonState === "existing" ? 1 : 0)
          assert.equal(app.pid, current.hostPid)
          assert.equal(app.status, "online")
          assert.equal(app.script.toLowerCase(), harness.launcherPath.toLowerCase())
          assert.equal(
            app.restarts,
            1,
            "The original app must hand off exactly once under its same PM2 id",
          )
          assert.equal(current.capabilities.osSandbox, mode === "os-sandbox")
          const initialEvents = guardEvents(read(daemonLog))
          const registrations = initialEvents.filter(
            event => event.event === "pm2-application-registered",
          )
          const handoffs = initialEvents.filter(event => event.event === "pm2-handoff-requested")
          assert.equal(registrations.length, 1)
          assert.equal(handoffs.length, 1)
          assert.equal(String(registrations[0].pmId), String(app.id))
          assert.equal(handoffs[0].pid, registrations[0].pid)
          assert.notEqual(handoffs[0].pid, current.hostPid)
          assert.ok(
            initialEvents.some(
              event => event.event === "pm2-exit-barrier-complete" && event.pid === handoffs[0].pid,
            ),
          )
          initialHandoff = { sameApplicationId: true, targetedRestarts: 1, barrierConfirmed: true }
          assert.deepEqual(await inspectorEndpoints(daemon.pid), [])
          inspectorClosed = true
          if (daemonState === "cold") {
            await pm2.cli(["start", harness.unrelatedConfigPath])
            rows = await pm2.listRaw()
            const other = rows.find(row => row.name === unrelatedName)
            unrelated = appState(other)
            assertNoPreload(other)
            assert.equal(unrelated.restarts, 0)
            telemetry = await readTelemetry(harness.unrelatedTelemetry)
          }
          await assertResident(rows)
          harness.capture(current.hostPid)
          harness.captureSession()
          for (let round = 0; round < cycles; round++)
            for (const action of ["restart", "reload"]) {
              const previous = current
              const previousApp = app
              const oldScope = harness.capture(previous.hostPid)
              assert.ok(oldScope.length >= 2)
              const daemonOffset = read(daemonLog).length
              const errorOffset = read(applicationLog).length
              const eventOffset = fixture.events().length
              const lifecycleCount = fixture.lifecycle().length
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
              await pm2.cli(
                route === "name"
                  ? [action, name]
                  : [action, harness.targetConfigPath, "--only", name],
              )
              current = await fixture.waitForStatus(
                state => state.phase === "online" && state.hostPid !== previous.hostPid,
                {
                  timeout: 90000,
                  description: `Native ${action} did not produce a new online host`,
                },
              )
              await waitScopeGone(oldScope)
              await pause(250)
              current = await fixture.status()
              rows = await pm2.listRaw()
              row = rows.find(item => item.name === name)
              app = appState(row)
              assertNoPreload(row)
              assert.equal(rows.length, 2)
              assert.equal(current.phase, "online")
              assert.equal(current.recoveryCount, 0)
              assert.equal(app.status, "online")
              assert.equal(app.pid, current.hostPid)
              assert.equal(app.id, previousApp.id)
              assert.equal(app.restarts, previousApp.restarts + 1)
              assert.equal(app.script.toLowerCase(), harness.launcherPath.toLowerCase())
              await assertResident(rows)
              assert.deepEqual(await inspectorEndpoints(daemon.pid), [])
              const segment = guardEvents(read(daemonLog).slice(daemonOffset))
              assert.equal(
                segment.filter(event => event.event === "pm2-exit-barrier-failed").length,
                0,
              )
              assert.equal(
                segment.filter(
                  event =>
                    event.event === "pm2-exit-barrier-complete" &&
                    event.pid === previous.hostPid &&
                    String(event.pmId) === String(previousApp.id),
                ).length,
                1,
              )
              assertUnrelatedEvents(segment, unrelated)
              assert.equal(
                segment.filter(event => event.event === "pm2-handoff-requested").length,
                0,
              )
              const events = fixture.events().slice(eventOffset)
              assert.equal(events.filter(event => event.type === "host-lock-acquired").length, 1)
              assert.equal(events.filter(event => event.type === "worker-spawn").length, 1)
              assert.equal(fixture.lifecycle().length, lifecycleCount + 1)
              assert.doesNotMatch(
                read(applicationLog).slice(errorOffset),
                /宿主锁被拒绝|project-lock-error/,
              )
              harness.capture(current.hostPid)
              harness.captureSession()
              Object.assign(step, {
                status: "passed",
                restartCounter: app.restarts,
                barrierConfirmed: true,
                daemonIdentityUnchanged: true,
                daemonEnvironmentUnchanged: true,
                unrelatedApplicationAndEnvironmentUnchanged: true,
                inspectorClosed: true,
              })
              progress("running")
              context.diagnostic(
                `PASS ${mode}/${daemonState}/${harness.interpreterKind}: ${action} ${route} ${round + 1}`,
              )
            }
          assert.equal(steps.length, cycles * 2)
          assertUnrelatedEvents(guardEvents(read(daemonLog)), unrelated)
          fixture.verifyCoreHashes()
          harness.assertPreserved()
        } catch (error) {
          priorMatrixFailure = true
          failure = error
          const step = steps.find(step => step.status === "running")
          if (step) step.status = "failed"
        } finally {
          try {
            cleanup = await harness.cleanup()
          } catch (error) {
            priorMatrixFailure = true
            cleanupFailure = error
          }
          progress(failure || cleanupFailure ? "failed" : "passed")
          fs.writeFileSync(
            path.join(fixture.runRoot, "pm2-auto-windows-report.json"),
            JSON.stringify(
              {
                platform: process.platform,
                arch: process.arch,
                runnerNode: process.version,
                testedNode: harness.nodeVersion,
                interpreterKind: harness.interpreterKind,
                pm2Version: harness.pm2Version,
                mode,
                daemonState,
                status: failure || cleanupFailure ? "failed" : "passed",
                originalEntry: "app.js",
                operatorGuardPreload: false,
                applicationNodeOptionsAbsent: true,
                daemonStartedWithoutInspector: true,
                inspectorPortSelection: useDefaultPort ? "node-default-9229" : "ephemeral-unopened",
                inspectorClosed,
                initialHandoff,
                cyclesPerAction: cycles,
                steps,
                cleanup,
                sourceSnapshot: harness.sourceSnapshot,
                coreFileHashCount: 47,
                redisFixture: fixture.redisFixture,
                dependencyLayout: fixture.dependencyLayout,
                commands: pm2.commands,
                namespaceNote:
                  "Real PM2; daemon argv and CLI require only the three-address transport shim. CLI-only PM2_NODE_OPTIONS protects fallback transport; native filter_env excludes both NODE_OPTIONS variables from apps. No Guard preload or installed source edits.",
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

async function runtimeClient(url) {
  const socket = new WebSocket(url)
  await new Promise((resolve, reject) => {
    socket.addEventListener("open", resolve, { once: true })
    socket.addEventListener("error", () => reject(new Error("Owned Inspector client failed")), {
      once: true,
    })
  })
  let serial = 0
  return {
    socket,
    evaluate(expression) {
      const id = ++serial
      return new Promise((resolve, reject) => {
        const timer = setTimeout(
          () => finish(new Error("Owned Inspector heartbeat timed out")),
          5000,
        )
        const finish = (error, value) => {
          clearTimeout(timer)
          socket.removeEventListener("message", message)
          socket.removeEventListener("close", closed)
          error ? reject(error) : resolve(value)
        }
        const closed = () => finish(new Error("Pre-existing Inspector client was disconnected"))
        const message = event => {
          const reply = JSON.parse(event.data)
          if (reply.id !== id) return
          if (reply.error || reply.result?.exceptionDetails)
            finish(new Error("Owned Runtime operation failed"))
          else finish(undefined, reply.result?.result?.value)
        }
        socket.addEventListener("message", message)
        socket.addEventListener("close", closed, { once: true })
        socket.send(
          JSON.stringify({
            id,
            method: "Runtime.evaluate",
            params: { expression, returnByValue: true },
          }),
        )
      })
    },
  }
}

for (const scenario of ["reuse", "collision"])
  test(
    `Windows PM2 automatic takeover Inspector ${scenario}`,
    {
      skip: enabled && selections.includes(scenario) ? false : `requires PM2 auto ${scenario} gate`,
      timeout: 180000,
    },
    async context => {
      let listener
      if (scenario === "collision") {
        listener = net.createServer(socket =>
          socket.end("HTTP/1.1 403 Forbidden\r\nContent-Length: 0\r\n\r\n"),
        )
        try {
          await new Promise((resolve, reject) => {
            listener.once("error", reject)
            listener.listen(9229, "127.0.0.1", resolve)
          })
        } catch (error) {
          if (error.code === "EADDRINUSE") {
            context.skip("Port 9229 is occupied; no signal or connection sent to its owner")
            return
          }
          throw error
        }
      }
      let harness, client, failure, cleanup, cleanupFailure, unchanged, endpointPreserved
      try {
        harness = await createWindowsPm2Fixture({
          mode: "managed",
          zeroConfig: true,
          label: scenario === "reuse" ? "pm2a-ir" : "pm2a-ic",
          // PM2 6 即使因 stop_exit_codes 不重启，也可能显示 waiting restart；拒绝用例关闭退避，正常矩阵保留原退避。
          app:
            scenario === "collision"
              ? { stop_exit_codes: [78], exp_backoff_restart_delay: undefined }
              : {},
        })
        const { fixture, pm2, name, unrelatedName } = harness
        context.diagnostic(`Evidence: ${fixture.runRoot}`)
        const daemon = await pm2.startDaemon(
          scenario === "reuse" ? { inspectPort: 0, openInspector: true } : { inspectPort: null },
        )
        const daemonEnv = await pm2.daemonEnvironment()
        const beforeEndpoints = await inspectorEndpoints(daemon.pid)
        if (scenario === "reuse") {
          assert.equal(beforeEndpoints.length, 1)
          client = await runtimeClient(beforeEndpoints[0].url)
          assert.equal(await client.evaluate("process.pid"), daemon.pid)
        } else assert.deepEqual(beforeEndpoints, [])
        await pm2.cli(["start", harness.unrelatedConfigPath])
        const unrelated = appState((await pm2.listRaw()).find(row => row.name === unrelatedName))
        await pm2.cli(["start", harness.targetConfigPath])
        if (scenario === "reuse") {
          const first = await waitAutoOnline(fixture)
          const oldScope = harness.capture(first.hostPid)
          await pm2.cli(["restart", name])
          const current = await fixture.waitForStatus(
            state => state.phase === "online" && state.hostPid !== first.hostPid,
          )
          await waitScopeGone(oldScope)
          assert.notEqual(current.hostPid, first.hostPid)
          assert.equal(await client.evaluate("process.pid"), daemon.pid)
          assert.deepEqual(await inspectorEndpoints(daemon.pid), beforeEndpoints)
          endpointPreserved = true
          harness.capture(current.hostPid)
          harness.captureSession()
        } else {
          await until(
            async () => {
              if (
                !/PM2 自动接管失败/.test(read(path.join(fixture.runRoot, "application-error.log")))
              )
                return false
              const row = (await pm2.listRaw()).find(row => row.name === name)
              return row?.pm2_env.status === "stopped" && row.pm2_env.exit_code === 78 && row
            },
            "Inspector collision did not fail closed without restart",
            60000,
          )
          const row = (await pm2.listRaw()).find(row => row.name === name)
          assert.equal(row.pm2_env.restart_time, 0)
          assert.equal(
            fixture.events().filter(event => event.type === "host-lock-acquired").length,
            0,
          )
          assert.equal(
            guardEvents(read(path.join(pm2.home, "pm2.log"))).filter(
              event => event.event === "pm2-application-registered",
            ).length,
            0,
          )
          assert.deepEqual(await inspectorEndpoints(daemon.pid), [])
          assert.equal(listener.listening, true)
          endpointPreserved = true
        }
        assert.deepEqual(
          appState((await pm2.listRaw()).find(row => row.name === unrelatedName)),
          unrelated,
        )
        assert.deepEqual(pm2.observeDaemon(), daemon)
        assert.deepEqual(await pm2.daemonEnvironment(), daemonEnv)
        harness.assertPreserved()
        fixture.verifyCoreHashes()
        unchanged = true
      } catch (error) {
        failure = error
      } finally {
        client?.socket.close()
        try {
          if (harness) cleanup = await harness.cleanup()
        } catch (error) {
          cleanupFailure = error
        }
        if (listener?.listening) await new Promise(resolve => listener.close(resolve))
        if (harness)
          fs.writeFileSync(
            path.join(harness.fixture.runRoot, "pm2-auto-inspector-report.json"),
            JSON.stringify(
              {
                platform: process.platform,
                scenario,
                status: failure || cleanupFailure ? "failed" : "passed",
                operatorGuardPreload: false,
                ownRuntimeOnlyClient: scenario === "reuse",
                debuggerDomainEnabled: false,
                daemonAndUnrelatedEnvironmentUnchanged: unchanged,
                endpointPreserved,
                sourceSnapshot: harness.sourceSnapshot,
                coreFileHashCount: 47,
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
