import assert from "node:assert/strict"
import test from "node:test"
import path from "node:path"
import { fileURLToPath } from "node:url"
import {
  monitoredExecArgv,
  prepareNodeLaunch,
  stripGuardExecArgv,
  stripGuardNodeOptions,
} from "../dist/runtime/launch.js"

const bootstrap = fileURLToPath(new URL("../dist/runtime-bootstrap.cjs", import.meta.url))
const native = new URL("../dist/native-sandbox/preload.js", import.meta.url).href
const runtime = new URL("../dist/child-preload.js", import.meta.url).href
const worker = new URL("../dist/worker-preload.js", import.meta.url).href
const user = path.join(path.dirname(bootstrap), "user file.cjs")
const context = { runtimeId: "native-fixture", originPlugin: () => "fixture-plugin" }

test("known Guard preloads strip precisely and managed runtime injection remains mandatory", () => {
  const flags = [
    "--import",
    native,
    `--import=${runtime}`,
    "--require",
    bootstrap,
    `--require=${bootstrap}`,
    "-r",
    bootstrap,
    `-r${bootstrap}`,
    "--import",
    worker,
    "--require",
    user,
    "--trace-warnings",
  ]
  assert.deepEqual(stripGuardExecArgv(flags), ["--require", user, "--trace-warnings"])
  assert.deepEqual(stripGuardExecArgv(["--import", fileURLToPath(native)]), [])
  const managed = monitoredExecArgv(flags)
  assert.ok(managed.includes(bootstrap) && managed.includes(runtime))
  assert.ok(managed.includes(user) && !managed.includes(native) && !managed.includes(worker))
  assert.equal(managed.filter(value => value === bootstrap).length, 1)
})

test("NODE_OPTIONS strips only Guard arguments, preserving quoted application preloads", () => {
  const quotedUser = `--require ${JSON.stringify(user)}`
  assert.equal(
    stripGuardNodeOptions(
      `--require ${JSON.stringify(bootstrap)} --import=${native} ${quotedUser} --trace-warnings`,
    ),
    `${quotedUser} --trace-warnings`,
  )
  assert.equal(
    stripGuardNodeOptions(`--import "${native}" --require ${JSON.stringify(user)}`),
    quotedUser,
  )
  const invalid = '--require "unterminated'
  assert.equal(stripGuardNodeOptions(invalid), invalid)
})

test("native forks sanitize control environment and preserve application options without mutation", () => {
  const env = {
    NODE_OPTIONS: `--require ${JSON.stringify(bootstrap)} --require ${JSON.stringify(user)}`,
    YUNZAI_GUARD_RUNTIME_MANIFEST: "native-alias-only.json",
    YUNZAI_GUARD_PIPE: "private-pipe",
    YUNZAI_GUARD_PARENT_RUNTIME: "parent",
    YUNZAI_GUARD_ORIGIN_PLUGIN: "other",
    BUSINESS: "kept",
  }
  const options = { execArgv: ["--import", native, "--require", user], env, silent: true }
  const result = prepareNodeLaunch("fork", ["business.mjs", ["argument"], options], context)
  assert.deepEqual(result[1], ["argument"])
  assert.deepEqual(result[2].execArgv, ["--require", user])
  assert.equal(result[2].silent, true)
  assert.deepEqual(
    { ...result[2].env },
    {
      NODE_OPTIONS: `--require ${JSON.stringify(user)}`,
      BUSINESS: "kept",
    },
  )
  assert.equal(options.env, env)
  assert.ok(env.YUNZAI_GUARD_PIPE)
  assert.deepEqual(options.execArgv, ["--import", native, "--require", user])
})

test("managed launch snapshots getters and ignores replaced collection helpers", () => {
  let environmentReads = 0
  let optionReads = 0
  let argumentReads = 0
  const argv = ["-e", "process.exit(0)"]
  Object.defineProperty(argv, 0, {
    get() {
      argumentReads++
      return argumentReads === 1 ? "-e" : "--version"
    },
  })
  const options = {
    get shell() {
      optionReads++
      return optionReads > 1
    },
    get env() {
      environmentReads++
      return { NODE_OPTIONS: "--trace-warnings" }
    },
  }
  const original = {
    includes: Array.prototype.includes,
    every: Array.prototype.every,
    slice: Array.prototype.slice,
    iterator: Array.prototype[Symbol.iterator],
    isArray: Array.isArray,
  }
  let prepared
  try {
    Array.prototype.includes = () => false
    Array.prototype.every = () => false
    Array.prototype.slice = () => []
    Array.prototype[Symbol.iterator] = function* () {}
    Array.isArray = () => false
    prepared = prepareNodeLaunch("spawn", [process.execPath, argv, options], {
      ...context,
      manifestPath: "managed.json",
    })
  } finally {
    Array.prototype.includes = original.includes
    Array.prototype.every = original.every
    Array.prototype.slice = original.slice
    Array.prototype[Symbol.iterator] = original.iterator
    Array.isArray = original.isArray
  }
  assert.equal(environmentReads, 1)
  assert.equal(optionReads, 1)
  assert.equal(argumentReads, 1)
  assert.ok(prepared[1].includes(bootstrap))
  assert.ok(prepared[1].includes(runtime))
  assert.ok(prepared[1].includes("-e"))
  assert.match(prepared[2].env.NODE_OPTIONS, /--trace-warnings$/)
  assert.equal(prepared[2].shell, false)
})

test("native direct Node and callback overloads retain their exact argument placement", () => {
  const callback = () => {}
  const result = prepareNodeLaunch(
    "execFile",
    [process.execPath, ["--import", native, "-p", "1"], callback],
    context,
  )
  assert.deepEqual(result[1], ["-p", "1"])
  assert.equal(typeof result[2], "object")
  assert.equal(result[3], callback)
  assert.equal(prepareNodeLaunch("execFile", [process.execPath, callback], context)[2], callback)
  assert.equal(prepareNodeLaunch("exec", ["business-command", callback], context)[2], callback)
  const invalid = ["business.mjs", [], { execArgv: "invalid" }]
  assert.equal(prepareNodeLaunch("fork", invalid, context), invalid)
})

test("real managed manifests still inject broker identity even with caller overrides", () => {
  const result = prepareNodeLaunch("fork", ["business.mjs", [], { env: {}, execArgv: [] }], {
    ...context,
    manifestPath: "managed.json",
  })
  assert.equal(result[2].env.YUNZAI_GUARD_RUNTIME_MANIFEST, path.resolve("managed.json"))
  assert.equal(result[2].env.YUNZAI_GUARD_PARENT_RUNTIME, context.runtimeId)
  assert.equal(result[2].env.YUNZAI_GUARD_ORIGIN_PLUGIN, "fixture-plugin")
  assert.ok(result[2].env.NODE_OPTIONS.includes("--require"))
  assert.ok(result[2].execArgv.includes(runtime))
})

test(
  "Windows native resolution preserves named and shell Node path flags and mixed-case user options",
  { skip: process.platform !== "win32" },
  () => {
    const original = [...process.execArgv]
    process.execArgv.push("--preserve-symlinks", "--preserve-symlinks-main")
    try {
      const env = { nOdE_oPtIoNs: "--trace-warnings", APPLICATION: "kept" }
      const nativeContext = { ...context, resolutionManifestPath: "alias-only.json" }
      for (const [operation, args, optionsAt] of [
        ["spawn", ["node", ["business.cjs"], { env }], 2],
        ["exec", ['node "business file.mjs"', { env }, () => {}], 1],
      ]) {
        const result = prepareNodeLaunch(operation, args, nativeContext)
        assert.equal(result[0], args[0])
        assert.equal(
          result[optionsAt].env.nOdE_oPtIoNs,
          "--preserve-symlinks --preserve-symlinks-main --trace-warnings",
        )
        assert.equal(result[optionsAt].env.APPLICATION, "kept")
        assert.equal(result[optionsAt].env.YUNZAI_GUARD_RUNTIME_MANIFEST, undefined)
        assert.equal(result[optionsAt].env.YUNZAI_GUARD_PARENT_RUNTIME, undefined)
      }
      const direct = prepareNodeLaunch(
        "spawn",
        [process.execPath, ["business.cjs"], { env }],
        nativeContext,
      )
      assert.match(
        direct[2].env.nOdE_oPtIoNs,
        /--require .* --preserve-symlinks --preserve-symlinks-main --trace-warnings$/,
      )
      assert.equal(direct[2].env.NODE_OPTIONS, undefined)
      assert.deepEqual(env, { nOdE_oPtIoNs: "--trace-warnings", APPLICATION: "kept" })
      assert.equal(
        prepareNodeLaunch("spawn", ["node", ["business.cjs"], { env }], context)[2].env
          .nOdE_oPtIoNs,
        "--trace-warnings",
      )
    } finally {
      process.execArgv.splice(0, process.execArgv.length, ...original)
    }
  },
)

test(
  "Windows managed propagation preserves the effective mixed-case user NODE_OPTIONS",
  { skip: process.platform !== "win32" },
  () => {
    const env = { nOdE_oPtIoNs: "--trace-warnings", APPLICATION: "kept" }
    const result = prepareNodeLaunch("spawn", [process.execPath, ["business.cjs"], { env }], {
      ...context,
      manifestPath: "managed.json",
    })
    assert.equal(
      result[2].env.nOdE_oPtIoNs,
      `--require ${JSON.stringify(bootstrap)} --trace-warnings`,
    )
    assert.equal(result[2].env.NODE_OPTIONS, undefined)
    assert.equal(result[2].env.APPLICATION, "kept")
    assert.deepEqual(env, { nOdE_oPtIoNs: "--trace-warnings", APPLICATION: "kept" })
  },
)
