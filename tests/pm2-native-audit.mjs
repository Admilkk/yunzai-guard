import assert from "node:assert/strict"
import fs from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"

const escape = text => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")

/** 严格核对已完成原生 PM2 运行记录中的退出屏障。 */
export function auditWindowsPm2NativeRun(runRoot) {
  runRoot = fs.realpathSync(runRoot)
  const source = JSON.parse(
    fs.readFileSync(path.join(runRoot, "environment-windows-native-report.json"), "utf8"),
  )
  assert.equal(source.status, "passed", "Only a fully passed lifecycle run can be upgraded")
  assert.equal(source.daemonCompatibilityPreload, true)
  assert.equal(source.cleanup?.confirmed, true)
  assert.ok(source.cyclesPerAction >= 10)
  const actionCount = source.cyclesPerAction * 2
  assert.equal(source.steps.length, actionCount)
  for (const [index, step] of source.steps.entries()) {
    assert.equal(step.index, index + 1)
    assert.equal(step.status, "passed")
    assert.equal(step.restartCounter, index + 1)
    assert.equal(step.action, index % 2 === 0 ? "restart" : "reload")
  }
  const eventText = fs.readFileSync(
    path.join(runRoot, "project/data/yunzai-guard/events.jsonl"),
    "utf8",
  )
  const hosts = eventText
    .split("\n")
    .filter(Boolean)
    .map(line => JSON.parse(line))
    .filter(event => event.type === "host-lock-acquired")
  assert.equal(hosts.length, actionCount + 1, "One initial host and one host per native action")
  const configuration = JSON.parse(
    fs
      .readFileSync(path.join(runRoot, "ecosystem.config.cjs"), "utf8")
      .replace(/^module\.exports\s*=\s*/, "")
      .trim(),
  )
  const guard = configuration.apps.find(app => app.name === `guard-native-${source.mode}`)
  const unrelated = configuration.apps.find(app => app.name === "guard-native-control")
  assert.ok(guard && unrelated, "Both the Guard and unrelated control application are required")
  const controlLifecycle = fs
    .readFileSync(path.join(runRoot, "control-lifecycle.jsonl"), "utf8")
    .split("\n")
    .filter(Boolean)
    .map(line => JSON.parse(line))
  const controlStarts = controlLifecycle.filter(event => event.event === "started")
  assert.equal(controlStarts.length, 1, "The unrelated control must never restart")
  const controlPid = controlStarts[0].pid
  const text = fs.readFileSync(path.join(runRoot, "pm2-home/pm2.log"), "utf8")
  const lines = text.split("\n")
  const starting = []
  const barriers = []
  const startingPattern = new RegExp(
    `App \\[${escape(guard.name)}:(\\d+)\\] starting in -fork mode-`,
  )
  for (const [index, line] of lines.entries()) {
    const match = startingPattern.exec(line)
    if (match) starting.push({ line: index, pmId: match[1] })
    const marker = "[Yunzai Guard PM2] "
    const at = line.indexOf(marker)
    if (at < 0) continue
    const payload = line.slice(at + marker.length).trim()
    if (payload.startsWith("{")) barriers.push({ line: index, ...JSON.parse(payload) })
  }
  assert.equal(starting.length, actionCount + 1, "PM2 must start Guard exactly once per operation")
  const pmId = starting[0].pmId
  assert.ok(starting.every(event => event.pmId === pmId))
  assert.equal(barriers.filter(event => event.event === "pm2-exit-barrier-failed").length, 0)
  const liveGuardPids = new Set(hosts.map(event => event.hostPid))
  for (const event of barriers.filter(event =>
    ["pm2-exit-barrier-wait", "pm2-exit-barrier-complete"].includes(event.event),
  )) {
    assert.equal(String(event.pmId), pmId, "The unrelated PM2 ID must never be hooked")
    assert.ok(liveGuardPids.has(event.pid), "Every barrier PID must be a recorded Guard host")
    assert.notEqual(event.pid, controlPid, "The control application must never receive a barrier")
  }
  const completes = barriers.filter(event => event.event === "pm2-exit-barrier-complete")
  const used = new Set()
  const operations = hosts.slice(0, -1).map((host, index) => {
    const matches = completes.filter(
      event =>
        event.line >= starting[index].line &&
        event.line < starting[index + 1].line &&
        event.pid === host.hostPid &&
        String(event.pmId) === pmId,
    )
    assert.equal(
      matches.length,
      1,
      `Operation ${index + 1} needs exactly one matching old-host barrier`,
    )
    used.add(matches[0])
    assert.ok(
      barriers.some(
        event =>
          event.event === "pm2-exit-barrier-wait" &&
          event.pid === host.hostPid &&
          String(event.pmId) === pmId &&
          event.line >= starting[index].line &&
          event.line <= matches[0].line,
      ),
      "A completion must follow a wait for the same old host",
    )
    return {
      index: index + 1,
      action: source.steps[index].action,
      route: source.steps[index].route,
      oldHostPid: host.hostPid,
      pmId,
      barrierLine: matches[0].line,
      oldStartLine: starting[index].line,
      nextStartLine: starting[index + 1].line,
      barrierConfirmed: true,
    }
  })
  const cleanupCompletes = completes.filter(event => !used.has(event))
  assert.ok(cleanupCompletes.length <= 1, "Only one additional final cleanup completion is allowed")
  for (const event of cleanupCompletes) {
    assert.equal(event.pid, hosts.at(-1).hostPid)
    assert.ok(event.line > starting.at(-1).line)
  }
  const result = {
    status: "passed",
    validation: "strict posthoc audit of actual daemon and core lifecycle logs",
    platform: source.platform,
    testedNode: source.testedNode,
    pm2Version: source.pm2Version,
    mode: source.mode,
    interpreterKind: source.interpreterKind,
    operations: actionCount,
    guardStartingCount: starting.length,
    guardHostCount: hosts.length,
    matchingOldHostCompletions: used.size,
    cleanupCompletions: cleanupCompletes.length,
    barrierFailures: 0,
    unrelatedHooks: 0,
    unrelatedStarts: controlStarts.length,
    strictBarrierConfirmation: true,
    cleanupConfirmed: true,
    steps: operations,
  }
  fs.writeFileSync(path.join(runRoot, "barrier-audit.json"), JSON.stringify(result, null, 2) + "\n")
  return result
}

const ownPath = path.resolve(fileURLToPath(import.meta.url)).toLowerCase()
if (process.argv[1] && path.resolve(process.argv[1]).toLowerCase() === ownPath) {
  assert.ok(process.argv[2], "Pass the completed native PM2 run directory")
  const result = auditWindowsPm2NativeRun(process.argv[2])
  console.log(
    JSON.stringify({
      status: result.status,
      mode: result.mode,
      interpreterKind: result.interpreterKind,
      operations: result.operations,
      matchingOldHostCompletions: result.matchingOldHostCompletions,
      cleanupCompletions: result.cleanupCompletions,
      unrelatedHooks: result.unrelatedHooks,
    }),
  )
}
