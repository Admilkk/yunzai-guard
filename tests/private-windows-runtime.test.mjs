import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"
import test from "node:test"

const repository = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
const dist = process.env.GUARD_TEST_PRIVATE_DIST ?? path.join(repository, "dist")
const {
  configuredPrivateWindowsRuntime,
  prependWindowsRuntimePath,
  privateWindowsRuntimeCandidate,
  privateWindowsCanonicalRuntimeCandidate,
  verifyPrivateWindowsRuntime,
} = await import(pathToFileURL(path.join(dist, "sandbox/windows-runtime.js")))

test("private runtime selection is explicit and never silently changes host version or ABI", () => {
  const previous = process.env.YUNZAI_GUARD_PRIVATE_NODE
  try {
    delete process.env.YUNZAI_GUARD_PRIVATE_NODE
    assert.equal(configuredPrivateWindowsRuntime(repository), undefined)
    process.env.YUNZAI_GUARD_PRIVATE_NODE = "0"
    assert.equal(configuredPrivateWindowsRuntime(repository), undefined)
    process.env.YUNZAI_GUARD_PRIVATE_NODE = "untrusted-path"
    assert.throws(
      () => configuredPrivateWindowsRuntime(repository),
      /选择私有测试运行时需设置 YUNZAI_GUARD_PRIVATE_NODE=1/,
    )
  } finally {
    if (previous === undefined) delete process.env.YUNZAI_GUARD_PRIVATE_NODE
    else process.env.YUNZAI_GUARD_PRIVATE_NODE = previous
  }
  const selection = { directory: repository, sha256: privateWindowsRuntimeCandidate.sha256 }
  for (const host of [
    { platform: "linux", arch: "x64", versions: { node: "24.22.1", modules: "137" } },
    { platform: "win32", arch: "arm64", versions: { node: "24.22.1", modules: "137" } },
    { platform: "win32", arch: "x64", versions: { node: "26.0.0", modules: "146" } },
    { platform: "win32", arch: "x64", versions: { node: "24.22.0", modules: "137" } },
  ])
    assert.throws(
      () => verifyPrivateWindowsRuntime(selection, host),
      /私有 Windows 运行时需要匹配的 Windows x64 Node 24\.22\.1（ABI 137）/,
    )
})

test("private runtime rejects a different artifact or a replaced build manifest", () => {
  const host = { platform: "win32", arch: "x64", versions: { node: "24.22.1", modules: "137" } }
  assert.throws(
    () => verifyPrivateWindowsRuntime({ directory: repository, sha256: "0".repeat(64) }, host),
    /私有 Windows 运行时不是已验收的测试版本/,
  )
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "guard-runtime-validation-"))
  try {
    fs.writeFileSync(path.join(directory, "build-manifest.json"), '{"status":"passed"}')
    assert.throws(
      () =>
        verifyPrivateWindowsRuntime(
          { directory, sha256: privateWindowsRuntimeCandidate.sha256 },
          host,
        ),
      /私有 Windows 运行时构建清单与系统验收不符/,
    )
  } finally {
    fs.rmSync(directory, { recursive: true, force: true })
  }
})

test("session PATH has one case-insensitive key, preserves original order and leaves host input intact", () => {
  const env = { Path: "discarded-duplicate", PATH: "first;second", pAtH: "other", TOKEN: "kept" }
  const baseline = { ...env }
  assert.deepEqual(prependWindowsRuntimePath(env, "C:\\session\\runtime"), {
    TOKEN: "kept",
    PATH: "C:\\session\\runtime;first;second",
  })
  assert.deepEqual(env, baseline)
  assert.deepEqual(prependWindowsRuntimePath({ Path: "legacy" }, "runtime"), {
    PATH: "runtime;legacy",
  })
})

test("legacy accepted artifact cannot implicitly enable the new canonical protocol", () => {
  assert.equal(Object.hasOwn(privateWindowsRuntimeCandidate, "canonicalMetadataProtocol"), false)
  const directory = path.join(repository, privateWindowsRuntimeCandidate.directory)
  if (!fs.existsSync(path.join(directory, "os-verification.json"))) return
  const verified = verifyPrivateWindowsRuntime(
    { directory, sha256: privateWindowsRuntimeCandidate.sha256 },
    { platform: "win32", arch: "x64", versions: { node: "24.22.1", modules: "137" } },
  )
  assert.equal(Object.hasOwn(verified, "canonicalMetadataProtocol"), false)
})

test("canonical capability requires the exact accepted executable, manifest and OS record", () => {
  const candidate = privateWindowsCanonicalRuntimeCandidate
  const directory = path.join(repository, candidate.directory)
  if (!fs.existsSync(path.join(directory, "os-verification.json"))) return
  const verified = verifyPrivateWindowsRuntime(
    { directory, sha256: candidate.sha256 },
    { platform: "win32", arch: "x64", versions: { node: "24.22.1", modules: "137" } },
  )
  assert.equal(verified.sha256, candidate.sha256)
  assert.equal(verified.canonicalMetadataProtocol, 1)
  if (process.platform === "win32" && process.version === "v24.22.1") {
    const previous = process.env.YUNZAI_GUARD_PRIVATE_NODE
    try {
      process.env.YUNZAI_GUARD_PRIVATE_NODE = "1"
      assert.equal(configuredPrivateWindowsRuntime(repository).sha256, candidate.sha256)
    } finally {
      if (previous === undefined) delete process.env.YUNZAI_GUARD_PRIVATE_NODE
      else process.env.YUNZAI_GUARD_PRIVATE_NODE = previous
    }
  }
  const changed = fs.mkdtempSync(path.join(os.tmpdir(), "guard-canonical-record-"))
  try {
    fs.copyFileSync(
      path.join(directory, "build-manifest.json"),
      path.join(changed, "build-manifest.json"),
    )
    fs.writeFileSync(path.join(changed, "os-verification.json"), '{"status":"passed"}')
    assert.throws(
      () =>
        verifyPrivateWindowsRuntime(
          { directory: changed, sha256: candidate.sha256 },
          { platform: "win32", arch: "x64", versions: { node: "24.22.1", modules: "137" } },
        ),
      /私有 Windows 运行时系统记录与验收不符/,
    )
  } finally {
    fs.rmSync(changed, { recursive: true, force: true })
  }
})
