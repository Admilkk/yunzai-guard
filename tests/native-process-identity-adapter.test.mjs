import fs from "node:fs"
import path from "node:path"
import assert from "node:assert/strict"
import { test } from "node:test"
import { createHash } from "node:crypto"
import { spawn, spawnSync } from "node:child_process"
import { fileURLToPath, pathToFileURL } from "node:url"
import ts from "typescript"

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")
const stage = path.join(
  root,
  "tests",
  "runs",
  `native-adapter-unit-r29-${process.pid}-${Date.now()}`,
)
fs.mkdirSync(stage, { recursive: true })
const sourceFile = path.join(root, "src/native-process/index.ts")
const moduleFile = path.join(stage, "native-process/index.js")
const moduleSources = fs
  .readdirSync(path.join(root, "src/native-process"))
  .filter(name => name.endsWith(".ts"))
  .map(name => `native-process/${name}`)
for (const relative of moduleSources) {
  const destination = path.join(stage, relative.replace(/\.ts$/, ".js"))
  fs.mkdirSync(path.dirname(destination), { recursive: true })
  fs.writeFileSync(
    destination,
    ts.transpileModule(fs.readFileSync(path.join(root, "src", relative), "utf8"), {
      compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ES2022 },
    }).outputText,
  )
}
const api = await import(pathToFileURL(moduleFile).href)
const sha = file => createHash("sha256").update(fs.readFileSync(file)).digest("hex")
const bundle = path.join(stage, "bundle")
let mockAvailable = false
if (process.platform === "win32" && process.arch === "x64") {
  const csc = path.join(
    process.env.WINDIR ?? "C:/Windows",
    "Microsoft.NET",
    "Framework64",
    "v4.0.30319",
    "csc.exe",
  )
  const sourceMock = path.join(root, "tests", "native", "MockIdentity.cs")
  const bin = path.join(bundle, "bin", "win32-x64")
  fs.mkdirSync(bin, { recursive: true })
  fs.copyFileSync(sourceMock, path.join(bundle, "MockIdentity.cs"))
  const exe = path.join(bin, "process-identity.exe")
  const args = [
    "/nologo",
    "/platform:x64",
    "/target:exe",
    "/r:System.Web.Extensions.dll",
    `/out:${exe}`,
    path.join(bundle, "MockIdentity.cs"),
  ]
  const result = spawnSync(csc, args, { encoding: "utf8", windowsHide: true })
  fs.writeFileSync(
    path.join(stage, "compile.json"),
    JSON.stringify(
      {
        csc,
        cscSha256: sha(csc),
        args,
        native: { code: result.status, signal: result.signal },
        stdout: result.stdout,
        stderr: result.stderr,
        sourceSha256: sha(sourceMock),
        error: result.error?.message,
      },
      null,
      2,
    ) + "\n",
  )
  assert.equal(result.status, 0)
  fs.writeFileSync(
    path.join(bundle, "manifest.json"),
    JSON.stringify({
      schemaVersion: 1,
      protocol: 1,
      profileSet: "node24.22.1-v1",
      sources: { "MockIdentity.cs": sha(sourceMock) },
      artifacts: [
        {
          platform: "win32",
          architecture: "x64",
          file: "bin/win32-x64/process-identity.exe",
          sha256: sha(exe),
          bytes: fs.statSync(exe).size,
          format: "pe-framework",
        },
      ],
      builds: [],
    }),
  )
  mockAvailable = true
}
fs.writeFileSync(
  path.join(stage, "inputs.json"),
  JSON.stringify(
    {
      sourceSha256: sha(sourceFile),
      moduleSourceSha256: Object.fromEntries(
        moduleSources.map(file => [file, sha(path.join(root, "src", file))]),
      ),
      transpiledSha256: sha(moduleFile),
      mockAvailable,
      productionNativeActions: 0,
    },
    null,
    2,
  ) + "\n",
)

test("native JSON decoder rejects duplicate nested keys, non-JSON whitespace and oversized frames", () => {
  for (const text of [
    '{"a":1,"a":2}',
    '{"a":{"x":1,"x":2}}',
    "\u00a0{}",
    '{"a":1} trailing',
    '{"a":NaN}',
    '{"a":"\\u00zz"}',
  ])
    assert.throws(() => api.parseNativeIdentityJson(text))
  assert.throws(() => api.parseNativeIdentityJson(" ".repeat(65537)))
  assert.deepEqual(
    { ...api.parseNativeIdentityJson('{"a":[true,false,null,1.5]}') },
    { a: [true, false, null, 1.5] },
  )
})
test("native birth fields remain exact decimal strings and reject legacy CIM ticks", () => {
  const value = { pid: 123, birth: { kind: "windows-filetime-100ns", value: "133999999999999999" } }
  assert.deepEqual(api.parseNativeIdentity(value), value)
  for (const invalid of [
    { ...value, birth: { kind: "cim-ticks", value: "133999999999999999" } },
    { ...value, birth: { kind: "windows-filetime-100ns", value: 133999999999999999 } },
    { ...value, pid: 1 },
    { ...value, unexpected: true },
  ])
    assert.throws(() => api.parseNativeIdentity(invalid))
})
test("missing native bundle refuses; no implicit compiler or PID action fallback", async () => {
  await assert.rejects(
    api
      .createNativeIdentityAdapter({ bundleRoot: path.join(stage, "missing") })
      .openInspectorParent({ remainingBudgetMs: 200000 }),
    error => error.code === "NATIVE_PRIMITIVE_UNAVAILABLE",
  )
})
for (const mode of [
  "incomplete",
  "refused",
  "postprobe-loss",
  "unknown-field",
  "wrong-nonce",
  "stale-serial",
  "unknown-record-field",
  "malformed-refusal",
]) {
  test(
    `root adapter ${mode}: only old synchronous commits may authorize cleanup`,
    { skip: !mockAvailable, concurrency: false, timeout: 12000 },
    async () => {
      const oldMode = process.env.GUARD_NATIVE_IDENTITY_TEST_MODE,
        oldCaller = process.env.GUARD_NATIVE_IDENTITY_TEST_CALLER
      process.env.GUARD_NATIVE_IDENTITY_TEST_MODE = mode
      process.env.GUARD_NATIVE_IDENTITY_TEST_CALLER = String(process.pid)
      const child = spawn(process.execPath, ["-e", "setInterval(()=>{},1000)"], {
        windowsHide: true,
        stdio: "ignore",
      })
      const childExit = new Promise(resolve =>
        child.once("exit", (code, signal) => resolve({ code, signal })),
      )
      let serial = 0,
        retired = false,
        probesAfterRetire = 0
      const probe = {
        pid: child.pid,
        retire() {
          retired = true
        },
        probeOriginalNow() {
          if (retired) {
            probesAfterRetire++
            return { live: false, reason: "retired" }
          }
          const current = ++serial
          return mode === "postprobe-loss" && current === 6
            ? { live: false, reason: "original-exited" }
            : { live: true, probeSerial: current }
        },
      }
      let session
      try {
        session = await api
          .createNativeIdentityAdapter({ bundleRoot: bundle })
          .openRoot(probe, 200000)
        const commits = [],
          ledger = {
            commitVerifiedSnapshot(rootIdentity, records) {
              commits.push({ rootIdentity, records })
            },
          }
        const first = await session.captureInto(ledger)
        assert.equal(first.committed, true)
        assert.equal(commits.length, 1)
        const recordIds = first.records.map(record => record.recordId)
        let second
        try {
          second = await session.captureInto(ledger)
        } catch (error) {
          second = { committed: false, error: error.code }
        }
        assert.equal(second.committed, false)
        assert.equal(commits.length, 1)
        if (["incomplete", "refused", "postprobe-loss"].includes(mode)) {
          const ended = await session.terminateCaptured(recordIds)
          assert.equal(ended.results[0].result, "terminated-and-exited")
          await assert.rejects(session.terminateCaptured(["c".repeat(32)]))
          const closed = session.close()
          assert.equal(session.close(), closed, "Concurrent close must await the same release")
          await closed
        } else await assert.rejects(session.terminateCaptured(recordIds))
        assert.equal(probesAfterRetire, 0)
      } finally {
        await session?.close().catch(() => {})
        child.kill()
        await childExit
        if (oldMode === undefined) delete process.env.GUARD_NATIVE_IDENTITY_TEST_MODE
        else process.env.GUARD_NATIVE_IDENTITY_TEST_MODE = oldMode
        if (oldCaller === undefined) delete process.env.GUARD_NATIVE_IDENTITY_TEST_CALLER
        else process.env.GUARD_NATIVE_IDENTITY_TEST_CALLER = oldCaller
      }
    },
  )
}
