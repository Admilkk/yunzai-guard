import assert from "node:assert/strict"
import test from "node:test"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { LoaderHooks } from "../dist/monitor/loader-hooks.js"
import { PluginMonitor } from "../dist/monitor/plugin.js"
import { attachGuardPlugin } from "../dist/runtime/guard-plugin.js"
import { parseSettings } from "../dist/config/index.js"

test("钩子按登记顺序由外到内执行，保持同步返回值与 this，可改写参数", () => {
  const calls = []
  const loader = {
    tag: "loader",
    sum(a, b) {
      calls.push(`original:${this.tag}`)
      return a + b
    },
  }
  const hooks = LoaderHooks.of(loader)
  assert.equal(LoaderHooks.of(loader), hooks)
  const original = loader.sum
  hooks.around("sum", function (next, a, b) {
    calls.push(`outer:${this.tag}`)
    return next(a * 10, b) + 1
  })
  hooks.around("sum", (next, a, b) => {
    calls.push("inner")
    return next(a, b)
  })
  assert.equal(loader.sum(1, 2), 13)
  assert.deepEqual(calls, ["outer:loader", "inner", "original:loader"])
  assert.equal(hooks.original("sum"), original)
  assert.equal(
    hooks.around("missing", next => next()),
    false,
  )
  assert.equal(hooks.original("missing"), undefined)
})

/** 仿 TRSS 加载器：deal 先算出 e.msg 与 e.isMaster，再按优先级执行 accept 与规则。 */
function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "guard-plugin-"))
  const loaderDirectory = path.join(root, "lib", "plugins")
  fs.mkdirSync(loaderDirectory, { recursive: true })
  for (const name of ["yunzai-guard", "impostor"]) {
    fs.mkdirSync(path.join(root, "plugins", name), { recursive: true })
    fs.writeFileSync(path.join(root, "plugins", name, "index.js"), "")
  }
  const commands = [],
    dispatched = [],
    events = []
  class Shell {
    constructor() {
      this.name = "Yunzai Guard"
      this.priority = -1000000
      this.rule = [{ reg: /^#guard更新$/i, fnc: "unavailable" }]
    }
    unavailable() {
      this.e.reply("unavailable")
    }
  }
  class Other {
    constructor() {
      this.priority = -2000000
    }
    accept() {
      return false
    }
  }
  const loader = {
    priority: [],
    importPlugin(file) {
      return this.loadPlugin(file, file.constructor)
    },
    loadPlugin(file, Constructor) {
      const plugin = new Constructor()
      this.priority.push({ plugin, class: Constructor, key: file.name, priority: plugin.priority })
      this.priority.sort((a, b) => a.priority - b.priority)
    },
    registerHandlers() {},
    collectTask() {},
    async deal(e) {
      e.msg = e.text
      Object.defineProperty(e, "isMaster", { value: e.user_id === 1 })
      for (const i of this.priority)
        if (i.plugin.accept) {
          const result = await Object.assign(new i.class(e), { e }).accept(e)
          if (result === "return") return
        }
      for (const i of this.priority)
        for (const rule of i.plugin.rule ?? [])
          if (rule.reg.test(e.msg)) return Object.assign(new i.class(e), { e })[rule.fnc](e)
    },
  }
  const hooks = LoaderHooks.of(loader)
  attachGuardPlugin(hooks, {
    entry: path.join(root, "plugins", "yunzai-guard", "index.js"),
    loaderDirectory,
    command: command => commands.push(command),
    dispatch: async event => {
      dispatched.push(event.msg)
      return event.msg === "#strict"
    },
  })
  const monitor = new PluginMonitor(
    { settings: parseSettings({}), run: (_, callback) => callback() },
    event => events.push(event),
    () => {},
  )
  monitor.attach(loader)
  loader.importPlugin({
    name: "other",
    path: "../../plugins/impostor/index.js",
    constructor: Other,
  })
  loader.importPlugin({
    name: "yunzai-guard",
    path: "../../plugins/yunzai-guard/index.js",
    constructor: Shell,
  })
  const message = (text, user_id = 1) => {
    const replies = []
    return { text, user_id, replies, reply: value => replies.push(value) }
  }
  return { loader, hooks, monitor, commands, dispatched, events, message }
}

test("Guard 入口被换成运行时子类：最先处理主人命令，不进入插件监控", async () => {
  const f = fixture()
  const guard = f.loader.priority.find(item => item.key === "yunzai-guard")
  assert.equal(f.loader.priority[0], guard)
  assert.equal(guard.priority, -Infinity)
  assert.deepEqual(guard.plugin.rule, [])
  assert.ok(f.hooks.trusted("yunzai-guard"))

  const command = f.message("#GUARD强制更新")
  await f.loader.deal(command)
  assert.deepEqual(f.commands, ["force-update"])
  assert.equal(command.replies.length, 1)

  await f.loader.deal(f.message("#strict"))
  await f.loader.deal(f.message("hello"))
  assert.deepEqual(f.dispatched, ["#strict", "hello"])
  assert.deepEqual(
    f.monitor.snapshot().entries.map(row => row.name),
    ["other"],
  )
  assert.ok(f.events.every(event => event.plugin !== "yunzai-guard"))
})

test("非主人、伪造事件与重复调用都不会触发命令", async () => {
  const f = fixture()
  await f.loader.deal(f.message("#guard更新", 2))
  const { class: Guard } = f.loader.priority.find(item => item.key === "yunzai-guard")
  const forged = { msg: "#guard登录", isMaster: true, reply() {} }
  assert.equal(await new Guard(forged).accept(forged), false)

  const live = f.message("#guard还原")
  await f.loader.deal(live)
  assert.equal(await new Guard(live).accept(live), false)
  assert.deepEqual(f.commands, ["rollback"])
})

test("同名但不是 Guard 入口文件的插件不会被接管", () => {
  const loader = {
    priority: [],
    importPlugin(file) {
      return this.loadPlugin(file, file.constructor)
    },
    loadPlugin(file, Constructor) {
      this.priority.push({ class: Constructor, key: file.name })
    },
    deal() {},
  }
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "guard-plugin-"))
  fs.mkdirSync(path.join(root, "lib", "plugins"), { recursive: true })
  fs.writeFileSync(path.join(root, "index.js"), "")
  const hooks = LoaderHooks.of(loader)
  attachGuardPlugin(hooks, {
    entry: path.join(root, "index.js"),
    loaderDirectory: path.join(root, "lib", "plugins"),
    command: () => assert.fail("不应触发"),
    dispatch: async () => false,
  })
  class Fake {}
  loader.importPlugin({ name: "yunzai-guard", path: "../../elsewhere/index.js", constructor: Fake })
  assert.equal(loader.priority[0].class, Fake)
  assert.equal(hooks.trusted("yunzai-guard"), false)
})
