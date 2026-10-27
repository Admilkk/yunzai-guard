import fs from "node:fs"
import path from "node:path"
import assert from "node:assert/strict"
import { test } from "node:test"
import { createHash } from "node:crypto"
import { fileURLToPath } from "node:url"
import {
  inspectReclaimHelper,
  prepareLinuxReclaimRequest,
  executeLinuxReclaim,
  settlePrerequisiteChecks,
} from "./cached-upgrade-prerequisites.mjs"

const root = path.dirname(fileURLToPath(import.meta.url))
const stage = fs.mkdtempSync(path.join(root, "runs", "cached-prerequisites-unit-"))
const bootId = "11111111-2222-3333-4444-555555555555"
const original = { pid: 12345, parent: 101, start: "555555555555555555" }
const ledger = () => new Map([[`${original.pid}:${original.start}`, { ...original }]])
const dependencies = overrides => ({
  readBirth: () => ({ ...original, parent: 1 }),
  readNamespace: () => "4:12345",
  readBootId: () => bootId,
  ...overrides,
})
const hash = file => createHash("sha256").update(fs.readFileSync(file)).digest("hex")
function elf(name = "native-test-elf") {
  const bytes = Buffer.alloc(120)
  Buffer.from([127, 69, 76, 70, 2, 1]).copy(bytes)
  bytes.writeUInt16LE(62, 18)
  bytes.writeBigUInt64LE(64n, 32)
  bytes.writeUInt16LE(56, 54)
  bytes.writeUInt16LE(1, 56)
  bytes.writeUInt32LE(1, 64)
  const file = path.join(stage, name)
  fs.writeFileSync(file, bytes, { flag: "wx", mode: 0o700 })
  return { file, sha256: hash(file) }
}

test("reclaim never reads namespace or birth for a PID outside the prior admission ledger", () => {
  let lookups = 0
  assert.throws(
    () =>
      prepareLinuxReclaimRequest(
        [{ ...original, pid: 12346 }],
        ledger(),
        dependencies({
          readBirth() {
            lookups++
            throw new Error("not reached")
          },
          readNamespace() {
            lookups++
            throw new Error("not reached")
          },
        }),
      ),
    /not atomically admitted/,
  )
  assert.equal(lookups, 0)
})
test("reclaim preserves exact ticks and accepts legitimate reparenting only for an admitted birth", () => {
  let reads = 0
  const result = prepareLinuxReclaimRequest(
    [original],
    ledger(),
    dependencies({ readBirth: () => ({ ...original, parent: ++reads === 1 ? 1 : 2 }) }),
  )
  assert.deepEqual(result.request.records, [
    { pid: original.pid, startTicks: original.start, pidNamespace: "4:12345" },
  ])
  assert.equal(reads, 2)
  assert.equal(result.request.budgetMs, 15000)
})
test("changed or unknown current birth does not grant a reclaim target", () => {
  for (const current of [undefined, { ...original, start: "5556" }, { ...original, start: null }]) {
    let namespaceReads = 0
    const result = prepareLinuxReclaimRequest(
      [original],
      ledger(),
      dependencies({
        readBirth: () => current,
        readNamespace() {
          namespaceReads++
          return "4:12345"
        },
      }),
    )
    assert.deepEqual(result.request.records, [])
    assert.equal(namespaceReads, 0)
    assert.equal(result.skipped.length, 1)
  }
})
test("birth change during namespace lookup and boot change reject the whole unsent request", () => {
  let reads = 0
  assert.throws(
    () =>
      prepareLinuxReclaimRequest(
        [original],
        ledger(),
        dependencies({
          readBirth: () => ({ ...original, start: ++reads === 1 ? original.start : "9999" }),
        }),
      ),
    /birth changed/,
  )
  let boots = 0
  assert.throws(
    () =>
      prepareLinuxReclaimRequest(
        [original],
        ledger(),
        dependencies({ readBootId: () => (++boots === 1 ? bootId : "new-boot") }),
      ),
    /boot changed/,
  )
})
test("duplicate and excessive reclaim ledger requests reject before native action", () => {
  assert.throws(
    () => prepareLinuxReclaimRequest([original, original], ledger(), dependencies()),
    /not atomically admitted/,
  )
  assert.throws(
    () => prepareLinuxReclaimRequest(Array(257).fill(original), ledger(), dependencies()),
    /Invalid admitted/,
  )
})
test("helper pin rejects a mismatch, relative route, or dynamic ELF before executing", () => {
  const helper = elf()
  assert.equal(inspectReclaimHelper(helper.file, helper.sha256).sha256, helper.sha256)
  assert.throws(() => inspectReclaimHelper(helper.file, "0".repeat(64)), /hash mismatch/)
  assert.throws(() => inspectReclaimHelper("relative-helper", helper.sha256), /must be absolute/)
  const bytes = fs.readFileSync(helper.file)
  bytes.writeUInt32LE(3, 64)
  const dynamic = path.join(stage, "dynamic-elf")
  fs.writeFileSync(dynamic, bytes, { mode: 0o700 })
  assert.throws(() => inspectReclaimHelper(dynamic, hash(dynamic)), /no PT_INTERP/)
})
test("helper pin refuses a symlink route", t => {
  const helper = elf("symlink-target"),
    link = path.join(stage, "linked-helper")
  try {
    fs.symlinkSync(helper.file, link)
  } catch (error) {
    if (error.code === "EPERM") {
      t.skip("Host cannot create a test symlink with existing privileges")
      return
    }
    throw error
  }
  assert.throws(() => inspectReclaimHelper(link, helper.sha256), /Linked/)
})
test("native self eligibility is request-bound and never becomes cleanup evidence", async () => {
  const helper = elf("self-preflight"),
    request = { protocol: 1, nonce: "a".repeat(48), bootId, budgetMs: 15000, records: [] }
  const value = {
    protocol: 1,
    nonce: request.nonce,
    nativeEligibility: "pidfd-self-open-send0-poll",
    scopeObservationComplete: false,
    results: [],
  }
  const run = async (executable, args, options) => {
    assert.equal(executable, helper.file)
    assert.deepEqual(args, [])
    assert.ok(JSON.parse(options.input).budgetMs > 0 && JSON.parse(options.input).budgetMs <= 15000)
    return { native: { code: 0, signal: null }, stdout: JSON.stringify(value), stderr: "" }
  }
  assert.equal(
    (await executeLinuxReclaim(helper, request, run)).reply.scopeObservationComplete,
    false,
  )
  await assert.rejects(
    executeLinuxReclaim(helper, request, run, { deadline: 0 }),
    /deadline before dispatch/,
  )
  await assert.rejects(
    executeLinuxReclaim(helper, request, async () => ({
      native: { code: 0, signal: null },
      stdout: JSON.stringify({ ...value, nonce: "b".repeat(48) }),
      stderr: "",
    })),
    /not bound/,
  )
})
test("native reclaim rejects an extra target or optimistic scope-complete claim", async () => {
  const helper = elf("reclaim-bind"),
    request = {
      protocol: 1,
      nonce: "a".repeat(48),
      bootId,
      budgetMs: 15000,
      records: [{ pid: original.pid, startTicks: original.start, pidNamespace: "4:12345" }],
    }
  for (const reply of [
    {
      protocol: 1,
      nonce: request.nonce,
      scopeObservationComplete: true,
      results: [{ pid: original.pid, startTicks: original.start, result: "terminated-and-exited" }],
    },
    {
      protocol: 1,
      nonce: request.nonce,
      scopeObservationComplete: false,
      results: [{ pid: 9999, startTicks: original.start, result: "terminated-and-exited" }],
    },
  ])
    await assert.rejects(
      executeLinuxReclaim(helper, request, async () => ({
        native: { code: 0, signal: null },
        stdout: JSON.stringify(reply),
        stderr: "",
      })),
    )
})
test("all prerequisite failures settle once and persist before any daemon or fixture exists", async () => {
  const directory = path.join(stage, "all-fail")
  fs.mkdirSync(directory)
  const calls = []
  await assert.rejects(
    settlePrerequisiteChecks({
      directory,
      version: "6.0.14",
      root: stage,
      checks: [
        {
          name: "missing-node",
          run() {
            calls.push("node")
            throw new Error("missing")
          },
        },
        {
          name: "missing-helper",
          run() {
            calls.push("helper")
            throw new Error("missing")
          },
        },
        {
          name: "cim",
          run() {
            calls.push("cim")
            throw new Error("missing")
          },
        },
      ],
    }),
    error => {
      assert.equal(error.eligibilityReceipt, path.join(directory, "6.0.14.json"))
      return true
    },
  )
  assert.deepEqual(calls, ["node", "helper", "cim"])
  const report = JSON.parse(fs.readFileSync(path.join(directory, "6.0.14.json")))
  assert.equal(report.eligible, false)
  assert.equal(report.checks.length, 3)
  for (const field of ["pm2DaemonsStarted", "fixtureEnvironmentsCreated", "productActionsStarted"])
    assert.equal(report[field], 0)
  assert.equal(report.cleanupEvidence, false)
  assert.equal(fs.existsSync(report.startedReceipt), true)
})
test("conditional statistics failure is visible without claiming statistics qualification", async () => {
  const result = await settlePrerequisiteChecks({
    version: "7.1.0",
    root: stage,
    checks: [
      {
        name: "wmic-conditional",
        required: false,
        run() {
          throw new Error("unavailable; stats not qualified")
        },
      },
    ],
  })
  assert.equal(result.receipt.eligible, true)
  assert.equal(result.receipt.checks[0].status, "failed")
  assert.equal(result.receipt.checks[0].required, false)
})
test("reused receipt paths cannot overwrite historical eligibility; failure gets a fresh receipt", async () => {
  const directory = path.join(stage, "reused")
  fs.mkdirSync(directory)
  const first = await settlePrerequisiteChecks({
      directory,
      version: "7.0.3",
      root: stage,
      checks: [],
    }),
    originalHash = hash(first.receiptFile)
  await assert.rejects(
    settlePrerequisiteChecks({ directory, version: "7.0.3", root: stage, checks: [] }),
    error => {
      assert.notEqual(error.eligibilityReceipt, first.receiptFile)
      assert.equal(fs.existsSync(error.eligibilityReceipt), true)
      return true
    },
  )
  assert.equal(hash(first.receiptFile), originalHash)
})
