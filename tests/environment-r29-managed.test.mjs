import assert from "node:assert/strict"
import fs from "node:fs"
import path from "node:path"
import { spawn } from "node:child_process"
import { fileURLToPath } from "node:url"
import test from "node:test"
import {
  createR29LifecycleFixture,
  readR29Inputs,
  readR29Coverage,
  r29Budgets,
} from "./r29-lifecycle-fixture.mjs"

const enabled = process.env.GUARD_R29_REAL === "1"
const mode = process.env.GUARD_R29_MODE || "managed"
const platform = process.env.GUARD_R29_PLATFORM || process.platform
const testRoot = path.dirname(fileURLToPath(import.meta.url))
const timeout = (work, ms, label) => {
  let timer
  return Promise.race([
    work,
    new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(label)), ms)
    }),
  ]).finally(() => clearTimeout(timer))
}

test(
  `real R29 frozen minimal Core47 lifecycle ${platform}/${mode}`,
  {
    skip:
      !enabled &&
      "not run: requires GUARD_R29_REAL=1 and exact final input SHA; no platform qualification is claimed",
    timeout: r29Budgets.caseMs,
  },
  async t => {
    // 启动夹具或客户进程前，先持久化前置条件失败。
    fs.mkdirSync(path.join(testRoot, "runs"), { recursive: true })
    const preflight = fs.mkdtempSync(path.join(testRoot, "runs/r29-minimal-preflight-"))
    const prerequisite = {
      schemaVersion: 1,
      status: "checking-not-run",
      platform,
      mode,
      launched: false,
      errors: [],
      budgets: r29Budgets,
    }
    let input
    try {
      assert.equal(platform, process.platform)
      input = readR29Inputs({
        file: process.env.GUARD_R29_INPUT_MANIFEST,
        inputSha256: process.env.GUARD_R29_INPUT_SHA256,
        platform,
        mode,
      })
      prerequisite.status = "passed-not-run"
    } catch (error) {
      prerequisite.status = "rejected-before-launch"
      prerequisite.errors.push(error.stack || String(error))
      throw error
    } finally {
      fs.writeFileSync(
        path.join(preflight, "prerequisites.json"),
        JSON.stringify(prerequisite, null, 2) + "\n",
      )
    }

    let fixture
    try {
      fixture = await createR29LifecycleFixture(input)
    } catch (error) {
      prerequisite.status = "fixture-preparation-failed-before-launch"
      prerequisite.errors.push(error.stack || String(error))
      fs.writeFileSync(
        path.join(preflight, "prerequisites.json"),
        JSON.stringify(prerequisite, null, 2) + "\n",
      )
      throw error
    }
    const report = fixture.report
    report.inputSha256 = process.env.GUARD_R29_INPUT_SHA256
    report.prerequisites = path.join(preflight, "prerequisites.json")
    const checks = (name, details = {}) => {
      report.checks.push({ name, ...details })
      fixture.save()
    }
    const errors = []
    const outputs = []
    let child,
      childClosed,
      originalExit,
      initialStatus,
      observed = [],
      normalExitRequested = false
    try {
      fixture.verify()
      checks("frozen Node/product/helper/tests/Core47 and default resource budgets verified")
      const env = { ...process.env }
      for (const key of Object.keys(env))
        if (
          [
            "NODE_OPTIONS",
            "NODE_PATH",
            "ELECTRON_RUN_AS_NODE",
            "PM_ID",
            "NODE_APP_INSTANCE",
            "APP_TYPE",
          ].includes(key.toUpperCase()) ||
          key.startsWith("YUNZAI_GUARD_")
        )
          delete env[key]
      child = spawn(process.execPath, ["app.js"], {
        cwd: fixture.root,
        env,
        windowsHide: true,
        stdio: ["ignore", "pipe", "pipe"],
      })
      report.originalPid = child.pid
      report.status = "running"
      originalExit = new Promise((resolve, reject) => {
        child.once("error", reject)
        child.once("exit", (code, signal) => resolve({ code, signal }))
      })
      // bootstrap 原生退出后，分离的 Host 仍可能持有原 stdout 管道。
      childClosed = new Promise(resolve =>
        child.once("close", (code, signal) => resolve({ code, signal })),
      )
      void originalExit.catch(() => {})
      for (const [name, stream] of [
        ["stdout", child.stdout],
        ["stderr", child.stderr],
      ]) {
        const file = fs.createWriteStream(path.join(fixture.runRoot, `${name}.log`))
        const completed = new Promise((resolve, reject) => {
          file.once("error", reject)
          file.once("finish", resolve)
        })
        void completed.catch(() => {})
        stream.pipe(file)
        outputs.push(completed)
      }
      fixture.save()
      initialStatus = await fixture.waitOnline(1, { timeout: r29Budgets.onlineMs })
      assert.deepEqual(
        await timeout(
          originalExit,
          r29Budgets.handshakeMs,
          "Original bootstrap native exit unconfirmed",
        ),
        { code: 0, signal: null },
      )
      assert.equal(initialStatus.generation, 1)
      assert.notEqual(initialStatus.hostPid, child.pid)
      const startup = fixture.events()
      assert.ok(startup.findIndex(row => row.type === "bootstrap-exit-confirmed") >= 0)
      assert.ok(
        startup.findIndex(row => row.type === "bootstrap-exit-confirmed") <
          startup.findIndex(row => row.type === "worker-spawn"),
      )
      assert.equal(startup.filter(row => row.type === "worker-spawn").length, 1)
      checks(
        "plain node app.js hands off only after original native exit and starts one generation",
        {
          hostPid: initialStatus.hostPid,
          workerPid: initialStatus.workerPid,
          namespacePid: initialStatus.namespacePid,
        },
      )

      await fixture.until(
        () => fixture.markers().some(row => row.event === "business-ready"),
        "Worker/external Node did not become ready",
        r29Budgets.businessReadyMs,
      )
      const markers = fixture.markers().map(row => row.event)
      for (const event of ["hook-called", "worker-effect", "child-effect"])
        assert.ok(markers.includes(event))
      assert.ok(!markers.includes("worker-error") && !markers.includes("child-error"))
      checks("unchanged legacy plugin/TLA/default hook/Worker/external Node retain their effects")
      assert.ok(markers.includes("forged-controls-sent"))
      assert.ok(markers.includes("control-read-denied"))
      assert.ok(
        !markers.includes("control-read-allowed") && !markers.includes("control-read-unexpected"),
      )
      await fixture.until(
        async () => (await fixture.status()).invalidMessages >= 4,
        "Host did not reject forged control frames",
        r29Budgets.handshakeMs,
      )
      assert.equal((await fixture.status()).generation, 1)
      checks("Host rejects forged controls and worker cannot read management credentials")

      await fixture.until(
        () => {
          const events = fixture
            .events()
            .filter(row => row.type === "audit")
            .map(row => row.event)
          return (
            events.some(
              event => event?.operation === "protected-target-change" && event.target === "Bot.em",
            ) &&
            events.some(event => event?.runtime?.kind === "thread") &&
            events.some(event => event?.runtime?.kind === "node-process")
          )
        },
        "Expected scoped Hook/Worker/external Node observations did not reach Host append",
        r29Budgets.hookMs,
      )
      assert.equal((await fixture.status()).generation, initialStatus.generation)
      checks("default audit records all three sources and observes the hook without restarting")

      // 进程普查记录只作证据，不能授权向数字 PID 发送信号。
      observed = fixture.snapshot(initialStatus.hostPid)
      fs.writeFileSync(
        path.join(fixture.runRoot, "scope-before-stop.json"),
        JSON.stringify(observed, null, 2) + "\n",
      )
      const credential = fs.readFileSync(path.join(fixture.stateDir, "control.json"), "utf8")
      assert.equal((await fixture.status()).hostPid, initialStatus.hostPid)
      assert.equal(fs.readFileSync(path.join(fixture.stateDir, "control.json"), "utf8"), credential)
      fixture.triggerBotExit()
      normalExitRequested = true
      const stopMs = platform === "win32" ? r29Budgets.windowsStopMs : r29Budgets.linuxStopMs
      await fixture.waitScopeGone(observed, { timeout: stopMs })
      assert.deepEqual(
        await timeout(childClosed, stopMs, "Original output/close settlement unconfirmed"),
        { code: 0, signal: null },
      )
      const ended = fixture.markers().map(row => row.event)
      for (const event of [
        "bot-exit-request",
        "core-exit-hook",
        "worker-exit-effect",
        "child-exit-effect",
        "worker-native-exit-0",
        "child-native-exit-0",
        "business-cleanup-complete",
      ])
        assert.ok(ended.includes(event), `Missing normal business exit marker ${event}`)
      checks(
        "Bot.exit runs normal business hooks and both original child roles exit natively with zero",
      )

      const timeline = fixture.events()
      for (const type of [
        "worker-force-kill",
        "worker-cleanup-error",
        "recovery-tripped",
        "lifecycle-error",
      ])
        assert.equal(
          timeline.some(row => row.type === type),
          false,
          `Unexpected ${type}`,
        )
      assert.equal(timeline.filter(row => row.type === "worker-spawn").length, 1)
      const closed = timeline.find(row => row.type === "audit-generation-close")
      assert.ok(closed)
      assert.equal(timeline.find(row => row.type === "host-stop")?.code, 0)
      assert.equal(timeline.find(row => row.type === "host-process-exit")?.code, 0)
      const generationCoverage = readR29Coverage(
        timeline,
        "generation-close",
        initialStatus.generation,
      )
      const hostCoverage = readR29Coverage(timeline, "host-stop", initialStatus.generation)
      assert.equal(closed.activeSources, generationCoverage.summary.activeSources)
      assert.equal(closed.retiredSources, generationCoverage.summary.retiredSources)
      report.auditCoverage = { generationClose: generationCoverage, hostStop: hostCoverage }
      report.auditMeaning =
        "Natural synchronous exits may have missing seals; incomplete must remain explicit. Append completion is not fsync or a Worker-hop receipt."
      checks(
        "source outcomes remain scoped and known incomplete delivery cannot become all-offered-written",
      )
      fixture.verify()
      assert.equal(fs.existsSync(path.join(fixture.stateDir, "control.json")), false)
      checks(
        "Core47/frozen product/existing business data remain unchanged and observed original scope is gone",
      )
      report.status = "passed"
    } catch (error) {
      errors.push(error)
      report.status = "failed"
    } finally {
      // 即使普查或断言失败，仍独立尝试原有的认证停止流程。
      try {
        await fixture.finish({
          stop: true,
          timeout: platform === "win32" ? r29Budgets.windowsStopMs : r29Budgets.linuxStopMs,
        })
      } catch (error) {
        errors.push(error)
      }
      try {
        fixture.verify()
      } catch (error) {
        errors.push(error)
      }
      if (child && originalExit)
        try {
          report.originalNativeExit = await timeout(
            originalExit,
            5000,
            "Original bootstrap exit remains unconfirmed",
          )
        } catch (error) {
          errors.push(error)
        }
      if (outputs.length)
        try {
          await timeout(Promise.all(outputs), 5000, "Raw output streams did not drain")
        } catch (error) {
          errors.push(error)
        }
      report.normalExitRequested = normalExitRequested
      report.observedScope = observed
      report.errors = errors.map(error => error.stack || String(error))
      if (errors.length) report.status = "failed-or-incomplete"
      fixture.save()
      t.diagnostic(
        `R29 raw report retained at ${fixture.reportFile}; source is not a real-platform pass until executed against the frozen input`,
      )
    }
    if (errors.length)
      throw new AggregateError(
        errors,
        "R29 minimal lifecycle or cleanup could not be confirmed; do not continue the batch",
      )
  },
)
