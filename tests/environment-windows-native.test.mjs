import assert from "node:assert/strict"
import fs from "node:fs"
import path from "node:path"
import test from "node:test"
import { createWindowsPm2Fixture } from "./pm2-windows-fixture.mjs"
import { waitScopeGone } from "./environment-fixture.mjs"

const enabled = process.platform === "win32" && process.env.GUARD_TEST_WINDOWS_PM2_NATIVE === "1"
const selectedModes = process.env.GUARD_TEST_PM2_MODES?.split(",") || ["managed", "os-sandbox"]
assert.ok(selectedModes.every(mode => ["managed", "os-sandbox"].includes(mode)))
const cycles = Number(process.env.GUARD_TEST_PM2_CYCLES || 10)
assert.ok(
  Number.isSafeInteger(cycles) && cycles >= 10,
  "Native acceptance requires at least ten of each action",
)
const pause = ms => new Promise(resolve => setTimeout(resolve, ms))
const readLog = file => (fs.existsSync(file) ? fs.readFileSync(file, "utf8") : "")
function compatibilityEvents(text) {
  const events = []
  for (const line of text.split("\n").slice(0, -1)) {
    const marker = "[Yunzai Guard PM2] "
    const index = line.indexOf(marker)
    if (index < 0) continue
    const payload = line.slice(index + marker.length).trim()
    if (!payload.startsWith("{")) continue
    events.push(JSON.parse(payload))
  }
  return events
}
function assertUnrelatedUntouched(events, unrelated) {
  assert.equal(
    events.filter(
      event =>
        ["pm2-exit-barrier-wait", "pm2-exit-barrier-complete"].includes(event.event) &&
        (String(event.pmId) === String(unrelated.id) || event.pid === unrelated.pid),
    ).length,
    0,
    "Compatibility must not install an exit barrier for the unrelated application",
  )
}

for (const mode of selectedModes)
  test(
    `Windows native PM2 mixed restart/reload stress (${mode})`,
    {
      skip: !enabled ? "requires GUARD_TEST_WINDOWS_PM2_NATIVE=1 on Windows" : false,
      timeout: 900000,
    },
    async context => {
      const testFixture = await createWindowsPm2Fixture({ mode })
      const { fixture, pm2, name, configPath, unrelatedName } = testFixture
      const errorLog = path.join(fixture.runRoot, "application-error.log")
      const daemonLog = path.join(pm2.home, "pm2.log")
      const steps = []
      const progressPath = path.join(fixture.runRoot, "native-progress.json")
      const progress = status =>
        fs.writeFileSync(
          progressPath,
          JSON.stringify(
            {
              mode,
              interpreterKind: testFixture.interpreterKind,
              compat: testFixture.compat,
              status,
              steps,
            },
            null,
            2,
          ) + "\n",
        )
      let failure, cleanup, cleanupFailure, unrelated
      try {
        progress("starting")
        await pm2.cli(["start", configPath])
        let current = await fixture.waitOnline()
        let rows = await pm2.list()
        let app = rows.find(row => row.name === name)
        unrelated = rows.find(row => row.name === unrelatedName)
        assert.equal(rows.length, 2)
        assert.equal(app.pid, current.hostPid)
        assert.equal(app.status, "online")
        assert.equal(app.restarts, 0)
        assert.ok(unrelated.pid > 1)
        assert.equal(unrelated.status, "online")
        assert.equal(unrelated.restarts, 0)
        if (testFixture.compat)
          assert.match(
            readLog(daemonLog),
            /PM2 兼容层已启用/,
            "The real daemon must confirm compatibility activation",
          )
        assert.equal(current.capabilities.osSandbox, mode === "os-sandbox")
        const daemon = pm2.daemonIdentity
        assert.ok(daemon)
        testFixture.capture(current.hostPid)
        testFixture.captureSession()
        assert.doesNotMatch(readLog(errorLog), /已有实例在运行|project-lock-error/)
        for (let round = 0; round < cycles; round++) {
          for (const action of ["restart", "reload"]) {
            const route = round % 2 === 0 ? "name" : "ecosystem"
            const previous = current
            const previousApp = app
            const oldScope = testFixture.capture(previous.hostPid)
            assert.ok(oldScope.length >= 2, "Expected the previous host and worker scope")
            const eventOffset = fixture.events().length
            const logOffset = readLog(errorLog).length
            const lifecycleCount = fixture.lifecycle().length
            const daemonOffset = readLog(daemonLog).length
            const step = {
              index: steps.length + 1,
              round: round + 1,
              action,
              route,
              status: "running",
            }
            steps.push(step)
            progress("running")
            await pm2.cli(route === "name" ? [action, name] : [action, configPath, "--only", name])
            current = await fixture.waitForStatus(
              state => state.phase === "online" && state.hostPid !== previous.hostPid,
              { timeout: 90000, description: `Native ${action} did not produce a new online host` },
            )
            await waitScopeGone(oldScope)
            await pause(1000)
            current = await fixture.status()
            rows = await pm2.list()
            app = rows.find(row => row.name === name)
            assert.equal(current.phase, "online")
            assert.notEqual(current.hostPid, previous.hostPid)
            assert.equal(
              current.recoveryCount,
              0,
              "A native operation must not spend recovery budget",
            )
            assert.equal(rows.length, 2)
            assert.deepEqual(
              rows.find(row => row.name === unrelatedName),
              unrelated,
              "Guard operations must not restart or change the unrelated application",
            )
            assert.equal(app.status, "online", "PM2 must agree that the real Guard host is online")
            assert.equal(
              app.pid,
              current.hostPid,
              "PM2 PID must match the authenticated Guard host",
            )
            assert.equal(app.id, previousApp.id)
            assert.equal(
              app.restarts,
              previousApp.restarts + 1,
              "One native action must restart exactly once",
            )
            assert.deepEqual(
              pm2.observeDaemon(),
              daemon,
              "The private PM2 daemon must remain the same",
            )
            const events = fixture.events().slice(eventOffset)
            assert.equal(events.filter(event => event.type === "host-lock-acquired").length, 1)
            assert.equal(events.filter(event => event.type === "worker-spawn").length, 1)
            assert.equal(fixture.lifecycle().length, lifecycleCount + 1)
            assert.doesNotMatch(
              readLog(errorLog).slice(logOffset),
              /已有实例在运行|project-lock-error/,
            )
            let barrierConfirmed = false
            if (testFixture.compat) {
              const barriers = compatibilityEvents(readLog(daemonLog).slice(daemonOffset))
              assert.equal(
                barriers.filter(event => event.event === "pm2-exit-barrier-failed").length,
                0,
                "No compatibility barrier may fail during an accepted operation",
              )
              assert.ok(
                barriers.some(
                  event =>
                    event.event === "pm2-exit-barrier-complete" &&
                    event.pid === previous.hostPid &&
                    String(event.pmId) === String(previousApp.id),
                ),
                "Each operation must complete the barrier for its exact previous Guard process",
              )
              assertUnrelatedUntouched(barriers, unrelated)
              barrierConfirmed = true
            }
            testFixture.capture(current.hostPid)
            testFixture.captureSession()
            Object.assign(step, {
              status: "passed",
              restartCounter: app.restarts,
              killRetryTime: app.killRetryTime,
              unrelatedApplicationUnchanged: true,
              barrierConfirmed,
            })
            progress("running")
            context.diagnostic(
              `PASS ${mode}: ${action} by ${route}, round ${round + 1}, counter ${app.restarts}`,
            )
          }
        }
        assert.equal(
          steps.filter(step => step.action === "restart" && step.status === "passed").length,
          cycles,
        )
        assert.equal(
          steps.filter(step => step.action === "reload" && step.status === "passed").length,
          cycles,
        )
        fixture.verifyCoreHashes()
        testFixture.assertPreserved()
      } catch (error) {
        failure = error
        const running = steps.find(step => step.status === "running")
        if (running) running.status = "failed"
      } finally {
        try {
          cleanup = await testFixture.cleanup()
          if (testFixture.compat && unrelated)
            assertUnrelatedUntouched(compatibilityEvents(readLog(daemonLog)), unrelated)
        } catch (error) {
          cleanupFailure = error
        }
        progress(failure || cleanupFailure ? "failed" : "passed")
        fs.writeFileSync(
          path.join(fixture.runRoot, "environment-windows-native-report.json"),
          JSON.stringify(
            {
              platform: process.platform,
              arch: process.arch,
              runnerNode: process.version,
              testedNode: testFixture.nodeVersion,
              interpreter: testFixture.interpreter,
              interpreterKind: testFixture.interpreterKind,
              pm2Version: testFixture.pm2Version,
              mode,
              launcher: path.relative(fixture.pluginDir, testFixture.launcherPath),
              daemonCompatibilityPreload: testFixture.compat,
              barrierEventsVerified:
                testFixture.compat &&
                steps.length === cycles * 2 &&
                steps.every(step => step.barrierConfirmed === true) &&
                !failure,
              status: failure || cleanupFailure ? "failed" : "passed",
              cyclesPerAction: cycles,
              steps,
              cleanup,
              commands: pm2.commands,
              coreFileHashCount: 47,
              redisFixture: fixture.redisFixture,
              dependencyLayout: fixture.dependencyLayout,
              namespaceNote:
                "Real installed PM2 CLI/daemon; namespace wrapper replaces only three IPC addresses. Optional Guard daemon compatibility preload is recorded separately.",
              error: failure?.stack,
              cleanupError: cleanupFailure?.stack,
            },
            null,
            2,
          ) + "\n",
        )
        context.diagnostic(`Evidence: ${fixture.runRoot}`)
      }
      if (failure && cleanupFailure)
        throw new AggregateError(
          [failure, cleanupFailure],
          "Native PM2 acceptance and cleanup failed",
        )
      if (failure) throw failure
      if (cleanupFailure) throw cleanupFailure
    },
  )
