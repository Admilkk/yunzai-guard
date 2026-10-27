import assert from "node:assert/strict"
import test from "node:test"
import { auditModule } from "./audit-core-fixture.mjs"
const { sanitizeAuditEvent } = await auditModule("audit/event")
const { createAuditSourceCounters } = await auditModule("audit/protocol")
const redact = value => value.replaceAll("secret", "[redacted]")

test("persistent native evidence keeps observability and reported blocking separate from trusted runtime identity", () => {
  const source = {
    kind: "process",
    operation: "execFileSync",
    target: "node",
    plugin: "business",
    action: "deny",
    details: {
      source: "guest-reported",
      observability: "js-entrypoints",
      reportedBlocked: true,
      secret: "not-retained",
      args: ["secret"],
      guestRuntime: { id: "thread-secret", kind: "thread", pid: 9999, threadId: 2 },
    },
  }
  const event = sanitizeAuditEvent(source, redact)
  assert.deepEqual(event.details, {
    source: "guest-reported",
    observability: "js-entrypoints",
    argumentsRedacted: true,
    reportedBlocked: true,
    guestRuntime: { id: "thread-[redacted]", kind: "thread", threadId: 2 },
  })
  assert.equal(event.runtime, undefined)
  assert.equal(JSON.stringify(event).includes("not-retained"), false)
})

test("policy attempt and service error outcomes remain visible without exporting service arguments", () => {
  const base = {
    kind: "plugin-sandbox",
    operation: "native.redis.get",
    target: "get",
    action: "audit",
  }
  assert.deepEqual(
    sanitizeAuditEvent(
      { ...base, details: { phase: "policy", blocked: false, args: ["private-key"] } },
      redact,
    ).details,
    { phase: "policy" },
  )
  const event = sanitizeAuditEvent(
    {
      ...base,
      operation: "native.service-error",
      details: {
        phase: "result",
        result: "error",
        code: "NATIVE_REDIS_DENIED",
        message: "private-key",
        env: { secret: 1 },
      },
    },
    redact,
  )
  assert.deepEqual(event.details, { phase: "result", result: "error", code: "NATIVE_REDIS_DENIED" })
  assert.equal(JSON.stringify(event).includes("private-key"), false)
})

test("audit sanitization omits accessors and rejects malformed required fields without evaluation", () => {
  let read = false
  assert.equal(
    sanitizeAuditEvent(
      {
        kind: "process",
        get operation() {
          read = true
          return "exec"
        },
        target: "node",
      },
      redact,
    ),
    undefined,
  )
  assert.equal(read, false)
})

test("module Hook evidence persists bounded detection and attribution without retaining code or arguments", () => {
  const base = {
    kind: "integrity",
    operation: "module-function-change",
    target: "plugins/genshin/model/mys/mysApi.js#default.prototype.getData",
    plugin: "ji-plugin",
    action: "audit",
  }
  const event = sanitizeAuditEvent(
    {
      ...base,
      details: {
        blocked: false,
        detection: "after-change",
        reason: "descriptor",
        attribution: "observed-function",
        source: "secret code",
        args: ["secret argument"],
      },
    },
    redact,
  )
  assert.equal(event.blocked, false)
  assert.deepEqual(event.details, {
    detection: "after-change",
    reason: "descriptor",
    attribution: "observed-function",
  })
  assert.doesNotMatch(JSON.stringify(event), /secret|argument|code/)
  let coercions = 0
  const unknown = {
    toString() {
      coercions++
      return "descriptor"
    },
  }
  const malformed = sanitizeAuditEvent(
    {
      ...base,
      details: { detection: "after-change", reason: unknown, attribution: unknown },
    },
    redact,
  )
  assert.deepEqual(malformed.details, { detection: "after-change" })
  assert.equal(coercions, 0)
})

test("module audit coverage keeps known partial-coverage reasons and drops free-form errors", () => {
  const base = {
    kind: "coverage",
    operation: "module-audit-unavailable",
    target: "plugin-modules",
    action: "audit",
  }
  assert.deepEqual(
    sanitizeAuditEvent(
      {
        ...base,
        details: { coverage: "partial", reason: "unsupported-format", error: "secret" },
      },
      redact,
    ).details,
    { coverage: "partial", reason: "unsupported-format" },
  )
  assert.deepEqual(
    sanitizeAuditEvent(
      {
        ...base,
        details: { coverage: "partial", reason: "secret" },
      },
      redact,
    ).details,
    { coverage: "partial" },
  )
})

test("Worker exit retains validated guest counters with parent-hop evidence, never Host append evidence", () => {
  const counters = createAuditSourceCounters()
  Object.assign(counters, {
    offered: 8,
    accepted: 5,
    sendCompleted: 4,
    hopReceived: 3,
    pendingRecords: 1,
    pendingBytes: 200,
    highWaterRecords: 2,
    highWaterBytes: 400,
    invalidReplies: 9,
  })
  counters.rejected["queue-bytes"] = 2
  const audit = {
    evidence: "parent-hop-only",
    countersProvenance: "guest-reported",
    receivedThrough: 3,
    lastSentSeq: 4,
    sourceCounters: counters,
    complete: false,
    args: ["secret"],
  }
  const base = {
    kind: "runtime",
    operation: "worker-runtime-exited",
    target: "thread-1",
    action: "audit",
  }
  const result = sanitizeAuditEvent({ ...base, details: { audit } }, redact)
  const snapshot = result.details.audit.sourceCounters
  assert.equal(Object.getPrototypeOf(snapshot), null)
  assert.equal(Object.getPrototypeOf(snapshot.rejected), null)
  assert.deepEqual(JSON.parse(JSON.stringify(snapshot)), counters)
  assert.notEqual(result.details.audit.sourceCounters, counters)
  assert.equal(result.details.audit.reportedComplete, false)
  assert.equal(result.details.audit.evidence, "parent-hop-only")
  assert.equal(JSON.stringify(result).includes("secret"), false)
  assert.equal(
    sanitizeAuditEvent(
      { ...base, details: { audit: { ...audit, evidence: "host-append-completed" } } },
      redact,
    ).details,
    undefined,
  )
  const malformed = sanitizeAuditEvent(
    {
      ...base,
      details: {
        audit: {
          ...audit,
          complete: true,
          sourceCounters: { ...counters, accepted: counters.offered + 1 },
        },
      },
    },
    redact,
  )
  assert.equal(malformed.details, undefined)
})

test("audit sanitization refuses Proxy traps before inspecting a record or nested counters", () => {
  let traps = 0
  const hostile = new Proxy(
    {},
    {
      getPrototypeOf() {
        traps++
        throw new Error("trap")
      },
      ownKeys() {
        traps++
        throw new Error("trap")
      },
    },
  )
  assert.equal(sanitizeAuditEvent(hostile, redact), undefined)
  const result = sanitizeAuditEvent(
    {
      kind: "runtime",
      operation: "worker-runtime-exited",
      target: "thread-1",
      details: {
        audit: {
          evidence: "parent-hop-only",
          countersProvenance: "guest-reported",
          receivedThrough: 0,
          lastSentSeq: 0,
          sourceCounters: hostile,
          complete: true,
        },
      },
    },
    redact,
  )
  assert.equal(result.details, undefined)
  assert.equal(traps, 0)
})

test("Windows guest transport snapshots stay separate from audit source counters and Host append facts", () => {
  const base = {
    kind: "runtime",
    operation: "worker-transport-summary",
    target: "primary",
    details: {
      transport: {
        scope: "worker-to-native-control-only",
        evidence: "transport-callback-only",
        provenance: "guest-reported",
        offered: 5,
        accepted: 4,
        completed: 3,
        rejected: 1,
        unknown: 10,
        closed: 9,
      },
    },
  }
  const result = sanitizeAuditEvent(base, redact)
  assert.equal(result.details.transport.unknown, 10)
  assert.equal(result.details.transport.coverage, "prefix-before-summary-send")
  assert.equal(result.details.transport.evidence, "transport-callback-only")
  for (const change of [
    { evidence: "host-append-completed" },
    { completed: 5 },
    { offered: Infinity },
    { args: ["secret"] },
  ])
    assert.equal(
      sanitizeAuditEvent(
        { ...base, details: { transport: { ...base.details.transport, ...change } } },
        redact,
      ).details,
      undefined,
    )
})

test("per-plugin native metadata summaries retain unknown cleanup as relayed guest evidence", () => {
  const event = sanitizeAuditEvent(
    {
      kind: "plugin-sandbox",
      operation: "native.process-closed",
      target: "appcontainer",
      plugin: "legacy-plugin",
      details: {
        windowsCanonical: {
          scope: "canonical-metadata-only",
          provenance: "native-broker-reported",
          capabilityRequested: true,
          cleanupUnknown: true,
          finalSnapshotMissing: false,
          nativeOutputClosed: true,
          nativeHelperResourcesReleased: true,
          cleanupConfirmed: false,
          latestStage: "cleanup",
          snapshot: {
            protocol: 1,
            enabled: true,
            disabled: true,
            offered: 2,
            acceptedRoot: 1,
            completed: 4,
            rejected: 1,
            unsupported: 1,
            timedOut: 1,
            unknown: 1,
            path: "secret",
          },
          args: ["secret"],
        },
      },
    },
    redact,
  )
  const summary = event.details.windowsCanonical
  assert.equal(summary.source, "guest-reported")
  assert.equal(summary.evidence, "native-broker-snapshot-relayed-by-parent")
  assert.equal(summary.reportedCleanupConfirmed, false)
  assert.equal(summary.cleanupUnknown, true)
  assert.equal(summary.nativeHelperResourcesReleased, true)
  assert.equal(summary.reportedCounters.completed, 4)
  assert.equal(summary.reportedCounters.offered, 2)
  assert.doesNotMatch(JSON.stringify(event), /secret|host-append-completed/)
})
