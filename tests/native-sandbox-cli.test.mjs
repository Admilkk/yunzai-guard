import assert from "node:assert/strict"
import fs from "node:fs"
import path from "node:path"
import test from "node:test"
import { nativeCommand } from "../dist/cli/native.js"
import { parseSettings } from "../dist/config/index.js"

const runs = path.resolve("tests/runs")
function fixture(t, settings) {
  fs.mkdirSync(runs, { recursive: true })
  const root = fs.mkdtempSync(path.join(runs, "native-cli-")),
    state = path.join(root, "data/yunzai-guard"),
    config = path.join(state, "settings.json")
  const plugin = path.join(root, "plugins/Business")
  fs.mkdirSync(plugin, { recursive: true })
  fs.writeFileSync(
    path.join(plugin, "index.js"),
    'throw new Error("CLI must not execute business source")',
  )
  fs.mkdirSync(path.join(root, "data/Business"), { recursive: true })
  fs.writeFileSync(path.join(root, "data/Business/original.json"), '{"seed":"original"}')
  if (settings) {
    fs.mkdirSync(state)
    fs.writeFileSync(config, JSON.stringify(settings))
  }
  t.after(() => {
    assert.equal(fs.realpathSync.native(path.dirname(root)), fs.realpathSync.native(runs))
    assert.ok(path.basename(root).startsWith("native-cli-"))
    fs.rmSync(root, { recursive: true, force: true })
  })
  return { root, state, config, plugin }
}

test("native CLI selects original plugins without executing or moving their source and data", async t => {
  const f = fixture(t),
    source = fs.readFileSync(path.join(f.plugin, "index.js"))
  assert.deepEqual(await nativeCommand([], f.root), {
    command: "list",
    plugins: [],
    source: "configuration-only",
    executed: false,
  })
  assert.equal(fs.existsSync(f.state), false)
  const enabled = await nativeCommand(["enable", "Business"], f.root)
  assert.equal(enabled.restartRequired, true)
  const settings = parseSettings(JSON.parse(fs.readFileSync(f.config)))
  assert.deepEqual(settings.pluginSandbox.native.plugins[0], {
    id: "Business",
    enabled: true,
    timeoutMs: 10000,
    network: "none",
    hookAction: "deny",
    adapters: false,
    allowCoreRestart: false,
    redis: { read: [], write: [] },
    writablePaths: [],
    writableFiles: [],
  })
  assert.equal((await nativeCommand(["check"], f.root)).executed, false)
  assert.equal(fs.readFileSync(f.config)[0] === 0xef, false)
  assert.deepEqual(fs.readFileSync(path.join(f.plugin, "index.js")), source)
  assert.equal(
    fs.readFileSync(path.join(f.root, "data/Business/original.json"), "utf8"),
    '{"seed":"original"}',
  )
})

test("disable and reenable retain every explicit permission and exact original backups", async t => {
  const input = {
    rules: [{ id: "retained", plugin: "Business", action: "deny" }],
    pluginSandbox: {
      native: {
        plugins: [
          {
            id: "Business",
            redis: { read: ["Business:*"] },
            writablePaths: ["data/Business"],
            adapters: true,
          },
        ],
      },
    },
  }
  const f = fixture(t, input),
    before = fs.readFileSync(f.config)
  const result = await nativeCommand(["disable", "Business"], f.root)
  assert.deepEqual(fs.readFileSync(result.backup), before)
  const disabled = JSON.parse(fs.readFileSync(f.config))
  assert.deepEqual(disabled.rules, input.rules)
  assert.deepEqual(disabled.pluginSandbox.native.plugins[0], {
    ...input.pluginSandbox.native.plugins[0],
    enabled: false,
  })
  await nativeCommand(["enable", "Business"], f.root)
  const reenabled = JSON.parse(fs.readFileSync(f.config)).pluginSandbox.native.plugins[0]
  assert.deepEqual(reenabled, { ...input.pluginSandbox.native.plugins[0], enabled: true })
  const bytes = fs.readFileSync(f.config),
    files = fs.readdirSync(f.state)
  assert.equal((await nativeCommand(["enable", "Business"], f.root)).changed, false)
  assert.deepEqual(fs.readFileSync(f.config), bytes)
  assert.deepEqual(fs.readdirSync(f.state), files)
})

test("unsafe IDs, absent plugins and linked plugin directories never create settings", async t => {
  const f = fixture(t)
  for (const id of ["../outside", "adapter", "yunzai-guard", "CON", "missing"])
    await assert.rejects(nativeCommand(["enable", id], f.root))
  fs.symlinkSync(
    f.plugin,
    path.join(f.root, "plugins/Alias"),
    process.platform === "win32" ? "junction" : "dir",
  )
  await assert.rejects(nativeCommand(["enable", "Alias"], f.root), /链接/)
  assert.equal(fs.existsSync(f.state), false)
})

test("CLI contention and invalid settings cannot clobber prior configuration", async t => {
  const f = fixture(t, { pluginSandbox: { native: { plugins: [] } } }),
    before = fs.readFileSync(f.config)
  fs.writeFileSync(path.join(f.state, "sandbox-cli.lock"), "existing")
  await assert.rejects(nativeCommand(["enable", "Business"], f.root), { code: "EEXIST" })
  assert.deepEqual(fs.readFileSync(f.config), before)
  assert.equal(fs.readFileSync(path.join(f.state, "sandbox-cli.lock"), "utf8"), "existing")
  fs.unlinkSync(path.join(f.state, "sandbox-cli.lock"))
  fs.writeFileSync(f.config, '{"badConfig":true}')
  await assert.rejects(
    nativeCommand(["enable", "Business"], f.root),
    /未知配置项：settings\.badConfig/,
  )
  assert.equal(fs.readFileSync(f.config, "utf8"), '{"badConfig":true}')
  assert.equal(fs.existsSync(path.join(f.state, "sandbox-cli.lock")), false)
})
