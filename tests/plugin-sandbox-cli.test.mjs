import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import test from "node:test"
import { parse } from "yaml"
import { sandboxCommand } from "../dist/cli/sandbox.js"

/** settings 默认写成旧版 settings.json（尚未转换），format 为 yaml 时写 settings.yaml。 */
function fixture(t, settings, format = "json") {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "guard-sandbox-cli-"))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  const state = path.join(root, "data/yunzai-guard")
  const config = path.join(state, "settings.yaml")
  const legacy = path.join(state, "settings.json")
  if (settings) {
    fs.mkdirSync(state, { recursive: true })
    fs.writeFileSync(format === "yaml" ? config : legacy, `${JSON.stringify(settings, null, 2)}\n`)
  }
  return { root, state, config, legacy, source: id => path.join(state, "scripts", `${id}.js`) }
}

const readYaml = file => parse(fs.readFileSync(file, "utf8"))

test("sandbox CLI defaults to an empty offline list without creating runtime files", async t => {
  const f = fixture(t)
  assert.deepEqual(await sandboxCommand([], f.root), { command: "list", plugins: [] })
  assert.deepEqual(fs.readdirSync(f.root), [])
  await assert.rejects(sandboxCommand(["run"], f.root), /用法/)
  await assert.rejects(sandboxCommand(["init"], f.root), /用法/)
  await assert.rejects(sandboxCommand(["list", "unexpected"], f.root), /用法/)
})

test("sandbox init creates a reply-only script and configuration; repeated init never overwrites", async t => {
  const f = fixture(t)
  const result = await sandboxCommand(["init", "hello"], f.root)
  assert.equal(result.restartRequired, true)
  assert.equal(result.backup, undefined)
  const before = fs.readFileSync(f.config, "utf8")
  const script = fs.readFileSync(f.source("hello"), "utf8")
  const settings = parse(before)
  assert.match(before, /^# Yunzai Guard 配置/)
  assert.deepEqual(JSON.parse(fs.readFileSync(f.legacy, "utf8")), settings)
  assert.deepEqual(settings.pluginSandbox.plugins, [
    { id: "hello", enabled: true, match: "#hello*", capabilities: ["reply"] },
  ])
  assert.match(script, /globalThis\.onMessage/)
  assert.match(script, /guard\.reply/)
  assert.equal(script.charCodeAt(0) === 0xfeff, false)
  await assert.rejects(sandboxCommand(["init", "hello"], f.root), /已存在/)
  assert.equal(fs.readFileSync(f.config, "utf8"), before)
  assert.equal(fs.readFileSync(f.source("hello"), "utf8"), script)
  assert.equal(fs.existsSync(path.join(f.state, "sandbox-cli.lock")), false)
  const listing = await sandboxCommand(["list"], f.root)
  assert.equal(listing.plugins[0].storage, "data/yunzai-guard-strict/hello/")
  assert.equal(listing.plugins[0].source, "data/yunzai-guard/scripts/hello.js")
})

test("sandbox init preserves unrelated settings and records exact original bytes in a backup", async t => {
  const original = {
    protect: { targets: ["Bot.em"], action: "audit" },
    rules: [{ id: "existing", plugin: "trusted", action: "deny" }],
    pluginSandbox: { defaults: { timeoutMs: 250 }, plugins: [] },
  }
  const f = fixture(t, original)
  const bytes = fs.readFileSync(f.legacy)
  const result = await sandboxCommand(["init", "second"], f.root)
  // 尚未转换时读取的是 settings.json，它会被改写为镜像，原始字节须留有备份。
  assert.deepEqual(fs.readFileSync(result.backup), bytes)
  const updated = readYaml(f.config)
  assert.deepEqual(JSON.parse(fs.readFileSync(f.legacy, "utf8")), updated)
  assert.deepEqual(updated.protect, original.protect)
  assert.deepEqual(updated.rules, original.rules)
  assert.equal(updated.pluginSandbox.defaults.timeoutMs, 250)
  assert.equal(
    fs.readdirSync(f.state).some(name => name.endsWith(".tmp")),
    false,
  )
})

test("sandbox check validates sources without evaluating Node side effects", async t => {
  const f = fixture(t)
  await sandboxCommand(["init", "checkme"], f.root)
  const marker = path.join(f.root, "must-not-exist.txt")
  fs.writeFileSync(
    f.source("checkme"),
    `process.getBuiltinModule("fs").writeFileSync(${JSON.stringify(marker)}, "escaped")\nonMessage=()=>{}`,
  )
  const checked = await sandboxCommand(["check"], f.root)
  assert.equal(checked.valid, true)
  assert.equal(checked.executed, false)
  assert.equal(checked.scope, "configuration-and-source-files-only")
  assert.match(checked.plugins[0].sha256, /^[a-f0-9]{64}$/)
  assert.equal(fs.existsSync(marker), false)
  fs.unlinkSync(f.source("checkme"))
  await assert.rejects(sandboxCommand(["check"], f.root))
})

test("sandbox init rejects legacy settings, occupied sources, invalid ids and concurrent CLI locks", async t => {
  const old = fixture(t, { strictJs: { plugins: [] } })
  const bytes = fs.readFileSync(old.legacy)
  await assert.rejects(sandboxCommand(["init", "migrate"], old.root), /strictJs.*pluginSandbox/)
  assert.deepEqual(fs.readFileSync(old.legacy), bytes)
  assert.equal(fs.existsSync(old.config), false)
  assert.equal(fs.existsSync(old.source("migrate")), false)
  const occupied = fixture(t)
  fs.mkdirSync(path.dirname(occupied.source("hello")), { recursive: true })
  fs.writeFileSync(occupied.source("hello"), "user source")
  await assert.rejects(sandboxCommand(["init", "hello"], occupied.root), { code: "EEXIST" })
  assert.equal(fs.readFileSync(occupied.source("hello"), "utf8"), "user source")
  assert.equal(fs.existsSync(occupied.config), false)
  for (const id of ["../bad", "CON", "con", "nul", "a/b", "a:stream", "A", "x".repeat(49)])
    await assert.rejects(sandboxCommand(["init", id], occupied.root), /插件ID/)
  const lock = path.join(occupied.state, "sandbox-cli.lock")
  fs.writeFileSync(lock, "another manager")
  await assert.rejects(sandboxCommand(["init", "another"], occupied.root), /管理操作|遗留锁/)
  assert.equal(fs.readFileSync(lock, "utf8"), "another manager")
})

test("sandbox CLI rejects linked settings and source directories without touching their targets", async t => {
  const f = fixture(t, {})
  const outside = path.join(f.root, "outside.json")
  fs.writeFileSync(outside, "{}\n")
  fs.unlinkSync(f.legacy)
  fs.linkSync(outside, f.legacy)
  for (const args of [["list"], ["check"], ["init", "hello"]])
    await assert.rejects(sandboxCommand(args, f.root), /配置文件须为单链接普通文件且不超过 1 MiB/)
  assert.equal(fs.readFileSync(outside, "utf8"), "{}\n")
  fs.unlinkSync(f.legacy)
  fs.mkdirSync(path.join(f.root, "outside-scripts"))
  fs.symlinkSync(
    path.join(f.root, "outside-scripts"),
    path.join(f.state, "scripts"),
    process.platform === "win32" ? "junction" : "dir",
  )
  await assert.rejects(sandboxCommand(["init", "hello"], f.root), /拒绝链接/)
  assert.deepEqual(fs.readdirSync(path.join(f.root, "outside-scripts")), [])
  assert.equal(fs.existsSync(f.config), false)
})

test("sandbox init rolls back only its own files after configuration commit failure", async t => {
  const f = fixture(t, { protect: { action: "audit" } }, "yaml")
  const before = fs.readFileSync(f.config)
  const rename = fs.renameSync
  fs.renameSync = (from, to) => {
    if (to === f.config) throw Object.assign(new Error("test commit failure"), { code: "EACCES" })
    return rename(from, to)
  }
  try {
    await assert.rejects(sandboxCommand(["init", "rollback"], f.root), /test commit failure/)
  } finally {
    fs.renameSync = rename
  }
  assert.deepEqual(fs.readFileSync(f.config), before)
  assert.equal(fs.existsSync(f.source("rollback")), false)
  assert.deepEqual(fs.readdirSync(f.state).sort(), ["scripts", "settings.yaml"])
})

for (const format of ["yaml", "json"])
  test(`sandbox init detects a concurrent edit of settings.${format} and preserves the editor's content`, async t => {
    // json：尚未转换时读的是 settings.json，它同样要做并发检测，否则写镜像时会覆盖他人的修改。
    const f = fixture(t, {}, format)
    const target = format === "yaml" ? f.config : f.legacy
    const concurrent = '{"protect":{"action":"deny"}}\n'
    const open = fs.openSync
    let edited = false
    fs.openSync = (filename, ...args) => {
      if (String(filename).includes(".settings-") && String(filename).endsWith(".tmp") && !edited) {
        edited = true
        fs.writeFileSync(target, concurrent)
      }
      return open(filename, ...args)
    }
    try {
      await assert.rejects(sandboxCommand(["init", "concurrent"], f.root), /其他操作修改/)
    } finally {
      fs.openSync = open
    }
    assert.equal(edited, true)
    assert.equal(fs.readFileSync(target, "utf8"), concurrent)
    assert.equal(fs.existsSync(f.source("concurrent")), false)
    assert.deepEqual(fs.readdirSync(f.state).sort(), ["scripts", `settings.${format}`])
  })
