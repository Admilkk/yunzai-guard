import assert from "node:assert/strict"
import test from "node:test"
import path from "node:path"
import fs from "node:fs"
import os from "node:os"
import { spawnSync } from "node:child_process"
import { fileURLToPath } from "node:url"
import {
  monitoredExecArgv,
  prepareNodeLaunch,
  stripGuardExecArgv,
  stripGuardNodeOptions,
  snapshotLaunch,
  prepareSpawnOptions,
} from "../dist/runtime/launch.js"

const bootstrap = fileURLToPath(new URL("../dist/runtime-bootstrap.cjs", import.meta.url))
const native = new URL("../dist/native-sandbox/preload.js", import.meta.url).href
const runtime = new URL("../dist/child-preload.js", import.meta.url).href
const worker = new URL("../dist/worker-preload.js", import.meta.url).href
const user = path.join(path.dirname(bootstrap), "user file.cjs")
const context = { runtimeId: "native-fixture", originPlugin: () => "fixture-plugin" }

test("node -e 父进程的 fork 不继承父进程内联正文", t => {
  const temporaryRoot = fs.realpathSync(os.tmpdir())
  const directory = fs.mkdtempSync(path.join(temporaryRoot, "guard-fork-eval-"))
  t.after(() => {
    const absolute = fs.realpathSync(directory)
    assert.equal(path.dirname(absolute), temporaryRoot)
    assert.ok(path.basename(absolute).startsWith("guard-fork-eval-"))
    fs.rmSync(absolute, { recursive: true, force: true })
  })
  const child = path.join(directory, "child.cjs")
  fs.writeFileSync(child, "process.send('child-ok');process.disconnect()\n")
  const launch = new URL("../dist/runtime/launch.js", import.meta.url).href
  const source = `
    (async()=>{
      const assert=require('node:assert/strict'),cp=require('node:child_process');
      const {prepareNodeLaunch}=await import(${JSON.stringify(launch)});
      const options={silent:true};
      const args=prepareNodeLaunch('fork',[${JSON.stringify(child)},[],options],{runtimeId:'fork-eval',originPlugin:()=>undefined});
      assert.equal(options.execArgv,undefined);
      const fork=cp.fork(...args);
      let message;fork.on('message',value=>message=value);
      fork.on('close',code=>{assert.equal(code,0);assert.equal(message,'child-ok')});
    })().catch(error=>{console.error(error);process.exitCode=1});
  `
  const result = spawnSync(process.execPath, ["-e", source], {
    cwd: directory,
    encoding: "utf8",
    windowsHide: true,
    timeout: 10000,
  })
  assert.equal(result.status, 0, `${result.error ?? ""}${result.stderr}`)
})

test("cwd 快照保留链接与 .. 的顺序，低层 falsey 目录继承而非法高层类型拒绝", () => {
  const relative = `link${path.sep}..${path.sep}work`
  const expected = process.cwd() + path.sep + relative
  assert.equal(snapshotLaunch("spawn", ["tool", [], { cwd: relative }])[2].cwd, expected)
  for (const cwd of [undefined, null, "", false, 0, NaN])
    assert.equal(prepareSpawnOptions({ file: "tool", args: ["tool"], cwd }).cwd, process.cwd())
  for (const cwd of [false, true, 0, 123, Symbol("cwd")])
    assert.throws(() => snapshotLaunch("spawn", ["tool", [], { cwd }]), {
      code: "ERR_INVALID_ARG_TYPE",
    })
})

test("当前 Node 的硬链接别名继承必需的预加载", t => {
  const temporaryRoot = fs.realpathSync(os.tmpdir())
  const directory = fs.mkdtempSync(path.join(temporaryRoot, "guard-node-alias-"))
  t.after(() => {
    const absolute = fs.realpathSync(directory)
    assert.equal(path.dirname(absolute), temporaryRoot)
    assert.ok(path.basename(absolute).startsWith("guard-node-alias-"))
    fs.rmSync(absolute, { recursive: true, force: true })
  })
  const alias = path.join(directory, process.platform === "win32" ? "ordinary.exe" : "ordinary")
  try {
    fs.linkSync(process.execPath, alias)
  } catch (error) {
    if (["EPERM", "EACCES", "EXDEV", "ENOTSUP"].includes(error.code)) {
      t.skip(`hard link unsupported: ${error.code}`)
      return
    }
    throw error
  }
  const result = prepareNodeLaunch(
    "spawn",
    [alias, ["-e", "process.exit(0)"], { cwd: directory }],
    {
      ...context,
      manifestPath: path.join(directory, "managed.json"),
    },
  )
  assert.ok(result[1].includes(bootstrap))
  assert.ok(result[1].includes(runtime))
})

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
        if (operation === "spawn")
          assert.match(
            result[optionsAt].env.nOdE_oPtIoNs,
            /--require .* --preserve-symlinks --preserve-symlinks-main --trace-warnings$/,
          )
        else
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

test("managed PATH Node aliases inherit monitoring while ordinary programs keep their argv", () => {
  const env = { PATH: path.dirname(process.execPath), BUSINESS: "kept" }
  const argv = ["-e", "process.exit(0)"]
  const managed = { ...context, manifestPath: "managed.json" }
  const prepared = prepareNodeLaunch(
    "spawn",
    [path.basename(process.execPath), argv, { env }],
    managed,
  )
  assert.ok(prepared[1].includes(bootstrap))
  assert.ok(prepared[1].includes(runtime))
  assert.equal(prepared[2].env.YUNZAI_GUARD_RUNTIME_MANIFEST, path.resolve("managed.json"))
  assert.equal(prepared[2].env.BUSINESS, "kept")
  assert.deepEqual(argv, ["-e", "process.exit(0)"])
  assert.deepEqual(env, { PATH: path.dirname(process.execPath), BUSINESS: "kept" })
  const ordinary = prepareNodeLaunch("spawn", ["ordinary-program", argv, { env }], managed)
  assert.deepEqual(ordinary[1], argv)
  assert.equal(ordinary[2].env.YUNZAI_GUARD_RUNTIME_MANIFEST, undefined)
})

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
