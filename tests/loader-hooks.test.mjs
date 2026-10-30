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

test("关闭注册后，已取得的入口也不能新增钩子、信任条件或取得原方法", () => {
  const loader = {
    value: 1,
    read() {
      return this.value
    },
    importPlugin() {},
  }
  const hooks = LoaderHooks.of(loader)
  const register = hooks.around.bind(hooks)
  const trust = hooks.trustWhen.bind(hooks)
  const original = hooks.original.bind(hooks)
  hooks.around("read", next => next() + 1)
  const read = loader.read
  hooks.lock()
  hooks.lock()

  const denied = { code: "ERR_GUARD_SELF_PROTECTION" }
  assert.throws(() => register("read", () => 99), denied)
  assert.throws(() => trust(() => true), denied)
  assert.throws(() => original("read"), denied)
  assert.throws(() => new LoaderHooks(loader), denied)
  assert.throws(() => Object.defineProperty(hooks, "trusted", { value: () => true }), TypeError)
  assert.equal(LoaderHooks.of(loader), hooks)
  assert.equal(Object.isFrozen(hooks), true)
  assert.equal(loader.read, read)
  assert.equal(loader.read(), 2)
  assert.equal(hooks.trusted("impostor"), false)
})

/** 仿 TRSS 加载器：dealEvent 算出 e.msg 与 e.isMaster，之后依次是上下文、仅响应 @、accept 与规则。 */
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
    dealEvent(e) {
      e.msg = e.text
      Object.defineProperty(e, "isMaster", { value: e.user_id === 1 })
    },
    async deal(e) {
      this.dealEvent(e)
      // 别的插件在等上下文，或群里要求 @ 时，核心在 accept 之前就返回。
      if (e.context) return e.reply("context")
      if (e.atOnly) return
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
  // 与受管运行时一致：先关闭注册，再导入全部业务插件和 Guard 入口。
  hooks.lock()
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
  const message = (text, user_id = 1, extra = {}) => {
    const replies = []
    return { text, user_id, replies, reply: value => replies.push(value), ...extra }
  }
  return { loader, hooks, monitor, commands, dispatched, events, message }
}

test("Guard 入口被换成运行时子类：分派受限脚本，不进入插件监控", async () => {
  const f = fixture()
  const guard = f.loader.priority.find(item => item.key === "yunzai-guard")
  assert.equal(f.loader.priority[0], guard)
  assert.equal(guard.priority, -Infinity)
  assert.deepEqual(guard.plugin.rule, [])
  assert.ok(f.hooks.trusted("yunzai-guard"))

  await f.loader.deal(f.message("#strict"))
  await f.loader.deal(f.message("hello"))
  assert.deepEqual(f.dispatched, ["#strict", "hello"])
  assert.deepEqual(
    f.monitor.snapshot().entries.map(row => row.name),
    ["other"],
  )
  assert.ok(f.events.every(event => event.plugin !== "yunzai-guard"))
})

test("主人命令在 dealEvent 之后立即处理，先于上下文、仅响应 @ 与全部插件", async () => {
  const f = fixture()
  const command = f.message("#GUARD强制更新", 1, { context: true })
  await f.loader.deal(command)
  await f.loader.deal(f.message("#guard登录", 1, { atOnly: true }))
  assert.deepEqual(f.commands, ["force-update", "login"])
  assert.equal(command.replies.length, 1)
  assert.notEqual(command.replies[0], "context")
  assert.deepEqual(f.dispatched, [])
})

test("非主人与伪造事件都不会触发命令", async () => {
  const f = fixture()
  const stranger = f.message("#guard更新", 2)
  await f.loader.deal(stranger)
  assert.deepEqual(stranger.replies, [])
  const { class: Guard } = f.loader.priority.find(item => item.key === "yunzai-guard")
  const forged = { msg: "#guard登录", isMaster: true, reply() {} }
  await new Guard(forged).accept(forged)
  assert.throws(() => f.loader.dealEvent({ text: "#guard还原", user_id: 1 }))
  assert.deepEqual(f.commands, [])
})

test("插件不能追加 dealEvent 钩子伪造主人命令，正常主人命令仍可执行", async () => {
  const f = fixture()
  const wrapped = f.loader.dealEvent
  const hooks = LoaderHooks.of(f.loader)
  assert.throws(
    () =>
      hooks.around("dealEvent", (_next, event) => {
        event.msg = "#guard强制更新"
        event.isMaster = true
      }),
    { code: "ERR_GUARD_SELF_PROTECTION" },
  )
  assert.throws(() => hooks.trustWhen(() => true), { code: "ERR_GUARD_SELF_PROTECTION" })
  assert.equal(hooks.trusted("other"), false)
  await f.loader.deal(f.message("#guard强制更新", 2))
  assert.deepEqual(f.commands, [])
  assert.equal(f.loader.dealEvent, wrapped)
  await f.loader.deal(f.message("#guard强制更新"))
  assert.deepEqual(f.commands, ["force-update"])
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
