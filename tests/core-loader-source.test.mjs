import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import test from "node:test"
import { parseSettings } from "../dist/config/index.js"
import {
  coreProfiles,
  detectCoreProfile,
  instrumentCoreLoaderSource,
  requiresCoreLoaderBridge,
} from "../dist/monitor/loader.js"

test("unknown core loaders can continue in default observation but not silently bypass selected enforcement", () => {
  const unknown = "export default new FutureCoreLoader()"
  assert.equal(instrumentCoreLoaderSource(unknown, false), undefined)
  assert.equal(requiresCoreLoaderBridge(parseSettings({})), false)
  assert.equal(
    requiresCoreLoaderBridge(parseSettings({ rules: [{ id: "record", action: "audit" }] })),
    false,
  )
  for (const action of ["deny", "restart"]) {
    assert.equal(
      requiresCoreLoaderBridge(
        parseSettings({ rules: [{ id: "enforce", plugin: "one-plugin", action }] }),
      ),
      true,
    )
    assert.equal(requiresCoreLoaderBridge(parseSettings({ protect: { action } })), true)
  }
  assert.equal(
    requiresCoreLoaderBridge(
      parseSettings({ pluginSandbox: { native: { plugins: [{ id: "selected" }] } } }),
    ),
    true,
  )
  assert.equal(requiresCoreLoaderBridge(parseSettings({ isolationMode: "os-sandbox" })), true)
  assert.equal(
    requiresCoreLoaderBridge(
      parseSettings({
        pluginSandbox: { native: { plugins: [{ id: "disabled", enabled: false }] } },
      }),
    ),
    false,
  )
})

const bridge = 'globalThis[Symbol.for("yunzai.guard.loader.bridge.v1")]'

test("JiuLi 加载器按其构造点桥接，TRSS 标记不会误配", () => {
  // 摘自 JiuLi 4.x 编译后 lib/core/loader.js 的相关片段。
  const jiuli = [
    "const createInstance = (entry) => Object.assign(new entry.class(e), { e, __key: String(entry.key).split('/')[0] });",
    "export default new PluginsLoader();",
  ].join("\n")
  const result = instrumentCoreLoaderSource(jiuli, false, coreProfiles.jiuli)
  assert.ok(result?.includes(`${bridge}.construct(entry.class, [e], entry.key)`))
  assert.ok(result.includes(`export default ${bridge}.loader(new PluginsLoader());`))
  assert.equal(result.includes("new entry.class(e)"), false)
  assert.equal(instrumentCoreLoaderSource(jiuli, false), undefined)
  // 缺少强制桥接点时不能只改写构造器就放行。
  assert.equal(instrumentCoreLoaderSource(jiuli, true, coreProfiles.jiuli), undefined)

  const trss = "const plugin = new i.class(e)\nexport default new PluginsLoader()"
  assert.ok(
    instrumentCoreLoaderSource(trss, false)?.includes(`${bridge}.construct(i.class, [e], i.key)`),
  )
  assert.equal(instrumentCoreLoaderSource(trss, false, coreProfiles.jiuli), undefined)
})

test("玖璃隔离桥接等待规则与上下文，保留单实例状态和捕获参数", async () => {
  const source = `
    class PluginsLoader {
      async dealEvent(e) {
        const entry=this.entry, v=this.rule;
        const createInstance=(entry)=>Object.assign(new entry.class(e),{e});
        const instanceCache=new Map();
        const getInstance=entry=>{
          if(!instanceCache.has(entry))instanceCache.set(entry,createInstance(entry));
          return instanceCache.get(entry);
        };
        const probe=Object.create(entry.class.prototype);probe.e=e;
        const context={...probe.getContext(),...probe.getContext(false, true)};
        if(context.resume)return getInstance(entry).resume(context.resume);
        if(!v.reg.test(String(e.msg)))return false;
        if(!v.reg.test(''))this.command=true;
        const instance=getInstance(entry);
        await instance.accept(e);
        const fn=instance.check.bind(instance);
        const args=fn?.length >= 2 ? [e, v.reg.exec(String(e.msg)) || undefined] : [e];
        return fn(...args);
      }
      async runHooks(e) {
        const entry=this.entry, fn=entry.plugin.beforeMessage;
        return fn.call(Object.assign(Object.create(entry.class.prototype), entry.plugin), e);
      }
    }
    export default new PluginsLoader();
  `
  const result = instrumentCoreLoaderSource(source, true, coreProfiles.jiuli)
  assert.ok(result)
  for (const marker of [
    "probe.getContext()",
    "probe.getContext(false, true)",
    "v.reg.test(String(e.msg))",
    "v.reg.test('')",
    "fn?.length >= 2 ? [e, v.reg.exec(String(e.msg)) || undefined] : [e]",
    "Object.assign(Object.create(entry.class.prototype), entry.plugin)",
  ]) {
    assert.equal(
      instrumentCoreLoaderSource(
        source.replace(marker, "changedMarker()"),
        true,
        coreProfiles.jiuli,
      ),
      undefined,
    )
    assert.equal(
      instrumentCoreLoaderSource(source + `\n// ${marker}`, true, coreProfiles.jiuli),
      undefined,
    )
  }
  const calls = []
  const key = Symbol.for("yunzai.guard.loader.bridge.v1")
  const previous = Object.getOwnPropertyDescriptor(globalThis, key)
  class Example {
    constructor() {
      calls.push("construct")
    }
    async getContext(_type, group = false) {
      if (this.e.context) return { resume: group ? "group" : "private" }
      return {}
    }
    accept() {
      this.accepted = true
    }
    check(event, captures) {
      return { message: event.msg, accepted: this.accepted, capture: captures[1] }
    }
    resume(value) {
      return value
    }
  }
  const pattern = /^#command (\w+)$/
  Object.defineProperty(globalThis, key, {
    configurable: true,
    value: {
      loader(loader) {
        loader.entry = {
          class: Example,
          plugin: {
            beforeMessage() {
              return this.e.msg
            },
          },
        }
        loader.rule = {
          reg: {
            test() {
              throw new Error("本体执行了隔离规则")
            },
            exec() {
              throw new Error("本体执行了隔离捕获")
            },
          },
        }
        return loader
      },
      construct(constructor, args) {
        return Reflect.construct(constructor, args)
      },
      async testRule(_regexp, text) {
        calls.push(text)
        return pattern.test(text)
      },
      async ruleArgs(fn, _regexp, event) {
        return fn.length >= 2 ? [event, pattern.exec(event.msg) || undefined] : [event]
      },
    },
  })
  try {
    const { default: loader } = await import(`data:text/javascript,${encodeURIComponent(result)}`)
    assert.equal(await loader.dealEvent({ msg: "unmatched" }), false)
    assert.deepEqual(await loader.dealEvent({ msg: "#command captured" }), {
      message: "#command captured",
      accepted: true,
      capture: "captured",
    })
    assert.equal(loader.command, true)
    assert.equal(calls.filter(value => value === "construct").length, 1)
    assert.ok(calls.includes(""))
    assert.equal(await loader.dealEvent({ msg: "context", context: true }), "group")
    assert.equal(await loader.runHooks({ msg: "hook event" }), "hook event")
  } finally {
    if (previous) Object.defineProperty(globalThis, key, previous)
    else Reflect.deleteProperty(globalThis, key)
  }
})

test("核心按根目录 package.json 名称与加载器文件识别", t => {
  const root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "guard-core-profile-"))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  assert.equal(detectCoreProfile(root).id, "trss")
  fs.writeFileSync(path.join(root, "package.json"), JSON.stringify({ name: "jiuli" }))
  // 只有名称、缺少实现文件时不切换，避免误判。
  assert.equal(detectCoreProfile(root).id, "trss")
  fs.mkdirSync(path.join(root, "lib/core"), { recursive: true })
  fs.writeFileSync(path.join(root, "lib/core/loader.js"), "")
  assert.equal(detectCoreProfile(root).id, "jiuli")
  fs.writeFileSync(path.join(root, "package.json"), JSON.stringify({ name: "trss-yunzai" }))
  assert.equal(detectCoreProfile(root).id, "trss")
  fs.writeFileSync(path.join(root, "package.json"), "not json")
  assert.equal(detectCoreProfile(root).id, "trss")
})
