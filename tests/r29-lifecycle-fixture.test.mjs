import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { spawnSync } from "node:child_process"
import test from "node:test"
import {
  r29Budgets,
  r29NodeDigests,
  r29ProbeSources,
  validateR29Manifest,
  verifyR29Product,
  readR29Coverage,
} from "./r29-lifecycle-fixture.mjs"

const required = [
  "index.js",
  "dist/launcher.js",
  "dist/host/supervisor.js",
  "dist/worker-preload.js",
  "dist/runtime/index.js",
  "dist/runtime/broker.js",
  "dist/runtime/worker-monitor.js",
  "dist/runtime/worker-transport.js",
  "dist/audit/receiver.js",
  "dist/audit/sender.js",
  "dist/audit/protocol.js",
  "dist/audit/buffer.js",
  "dist/audit/sink.js",
  "native/windows/GuardSandbox.cs",
  "native/windows/CanonicalMetadata.cs",
]
function manifest(platform = "linux", mode = "managed") {
  const files = Object.fromEntries(required.map(file => [file, "a".repeat(64)]))
  if (platform === "win32") {
    files["native/process-identity/manifest.json"] = "b".repeat(64)
    files["native/process-identity/bin/win32-x64/process-identity.exe"] = "c".repeat(64)
  }
  return {
    schemaVersion: 1,
    revision: "r29",
    platform,
    mode,
    node: {
      path: path.resolve("official-node"),
      sha256: r29NodeDigests[platform],
      version: "24.22.1",
      arch: "x64",
    },
    coreManifestSha256: "f737bd5b119fff7fe9e7e1fddc4ba5bb112d8e91ff7b3f14bf41d51fe4db5f3a",
    budgets: { ...r29Budgets },
    guard: { root: path.resolve("frozen-r29"), files },
    tests: Object.fromEntries(
      [
        "environment-r29-managed.test.mjs",
        "r29-lifecycle-fixture.mjs",
        "environment-fixture.mjs",
        "audit-reader.mjs",
      ].map(file => [file, "d".repeat(64)]),
    ),
  }
}
test("R29 lifecycle input separates default managed and Linux namespace cases with fixed original budgets", () => {
  for (const [platform, mode] of [
    ["win32", "managed"],
    ["linux", "managed"],
    ["linux", "os-sandbox"],
  ])
    assert.equal(validateR29Manifest(manifest(platform, mode), platform, mode).mode, mode)
  assert.throws(
    () => validateR29Manifest(manifest("win32", "os-sandbox"), "win32", "os-sandbox"),
    /not qualified/,
  )
  const changed = manifest()
  changed.budgets.shutdownMs++
  assert.throws(() => validateR29Manifest(changed, "linux", "managed"), /fixed before the batch/)
  assert.equal(r29Budgets.shutdownMs, 10000)
})
test("R29 lifecycle rejects unknown Node, absent final Windows held-native artifacts, traversal and missing test hashes before launch", () => {
  const unknown = manifest()
  unknown.node.sha256 = "f".repeat(64)
  assert.throws(() => validateR29Manifest(unknown, "linux", "managed"))
  const missing = manifest("win32")
  delete missing.guard.files["native/process-identity/manifest.json"]
  assert.throws(() => validateR29Manifest(missing, "win32", "managed"), /final prebuilt/)
  const escaped = manifest()
  escaped.guard.files["native/../outside"] = "a".repeat(64)
  assert.throws(() => validateR29Manifest(escaped, "linux", "managed"))
  const unpinned = manifest()
  delete unpinned.tests["environment-fixture.mjs"]
  assert.throws(() => validateR29Manifest(unpinned, "linux", "managed"))
})
test("R29 product verification refuses added/mutated files and does not need to start a process", t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "yunzai-guard-r29-product-input-"))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  fs.mkdirSync(path.join(root, "dist"))
  fs.mkdirSync(path.join(root, "native"))
  fs.writeFileSync(path.join(root, "index.js"), "")
  const input = {
    guard: {
      root,
      files: { "index.js": "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855" },
    },
  }
  verifyR29Product(input)
  fs.writeFileSync(path.join(root, "dist/unfrozen.js"), "")
  assert.throws(() => verifyR29Product(input), /file set changed/)
  fs.rmSync(path.join(root, "dist/unfrozen.js"))
  fs.writeFileSync(path.join(root, "index.js"), "changed")
  assert.throws(() => verifyR29Product(input), /Product changed/)
})
test("flat R29 coverage retains every declared active source and the complete retired aggregate", () => {
  const source = {
    generation: 1,
    stage: "generation-close",
    type: "audit-source-summary",
    sourceId: 1,
    transportCounterUnit: "channel-incidents-not-records",
    received: 0,
    receivedThrough: 0,
    written: 0,
    rejected: 0,
    unknown: 0,
    sourceUnknown: 0,
    sourceRejected: 0,
    sourceCoalesced: 0,
    sourcePendingRecords: 0,
    transportUnknown: 0,
    pending: 0,
    outcome: "incomplete",
  }
  const records = [
    {
      generation: 1,
      stage: "generation-close",
      type: "audit-coverage-summary",
      activeSources: 24,
      retiredSources: 3,
      retiredDetail: "aggregate-only",
    },
    {
      generation: 1,
      stage: "generation-close",
      type: "audit-retired-summary",
      sources: 3,
      sourceRejected: 9,
    },
    ...Array.from({ length: 24 }, (_, index) => ({ ...source, sourceId: index + 1 })),
  ]
  const result = readR29Coverage(records, "generation-close", 1)
  assert.equal(result.sources.length, 24)
  assert.equal(result.retired.sourceRejected, 9)
  assert.throws(() => readR29Coverage(records.slice(0, -1), "generation-close", 1), /declaration/)
  const duplicate = structuredClone(records)
  duplicate.at(-1).sourceId = 1
  assert.throws(() => readR29Coverage(duplicate, "generation-close", 1), /duplicate Host/)
  const falseComplete = structuredClone(records)
  Object.assign(falseComplete[2], {
    outcome: "all-offered-written",
    sourceUnknown: 1,
    evidence: "host-append-completed",
    sealed: true,
    nestedCoverage: "settled",
  })
  assert.throws(() => readR29Coverage(falseComplete, "generation-close", 1))
})
test("all three self-authored legacy/Worker/external Node sources parse without executing any business fixture", t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "yunzai-guard-r29-parse-only-"))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  for (const [name, source] of Object.entries(r29ProbeSources)) {
    const file = path.join(root, name.replace(/\.js$/, ".mjs"))
    fs.writeFileSync(file, source)
    const result = spawnSync(process.execPath, ["--check", file], {
      encoding: "utf8",
      windowsHide: true,
      timeout: 5000,
    })
    assert.equal(result.status, 0, result.stderr)
  }
})
