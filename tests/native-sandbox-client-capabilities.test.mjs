import assert from "node:assert/strict"
import fs from "node:fs"
import path from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"
import { execFile } from "node:child_process"
import { promisify } from "node:util"
import test from "node:test"
import { NativePluginClient } from "../dist/native-sandbox/client.js"
import { parseSettings, snapshotSettings } from "../dist/config/index.js"

const repository = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
function fixture(t, redis = () => ({}), redisPermissions, rules = [], allowCoreRestart = false) {
  const runs = path.join(repository, "tests/runs")
  fs.mkdirSync(runs, { recursive: true })
  const root = fs.mkdtempSync(path.join(runs, "native-capability-"))
  fs.mkdirSync(path.join(root, "plugins/sandboxed"), { recursive: true })
  const settings = parseSettings({
    rules,
    pluginSandbox: {
      native: {
        plugins: [{ id: "sandboxed", timeoutMs: 1000, redis: redisPermissions, allowCoreRestart }],
      },
    },
  })
  const audits = [],
    outgoing = [],
    replies = [],
    rejections = []
  let restarts = 0
  const client = new NativePluginClient(
    root,
    settings.pluginSandbox.native.plugins[0],
    settings,
    event => audits.push(event),
    redis,
    undefined,
    () => {
      restarts++
    },
  )
  client.readyPromise = Promise.resolve()
  client.session = {
    platform: process.platform,
    child: {
      connected: true,
      send(frame, callback) {
        outgoing.push(frame)
        callback?.(null)
        return true
      },
    },
    async close() {},
  }
  let sequence = 0
  const service = (method, requestId, args) =>
    client.service({
      type: "native-service",
      id: String(++sequence),
      service: "event",
      method,
      requestId,
      args,
    })
  const request = async (capability = false, event = {}) => {
    const promise = client.request(
      "native-call",
      { classId: "fixture", method: "run" },
      {
        msg: "hello",
        ...event,
        reply: (...args) => {
          replies.push(args)
          return true
        },
      },
      capability
        ? {
            handlerReject: value => {
              rejections.push(value)
              return false
            },
          }
        : undefined,
    )
    void promise.catch(() => {})
    await new Promise(resolve => setImmediate(resolve))
    return { promise, id: outgoing.findLast(frame => frame.type === "native-call").requestId }
  }
  const finish = (request, ok = true) =>
    client.receive({
      type: "native-result",
      requestId: request.id,
      ok,
      value: {},
      error: { code: "FIXTURE_FAILED", message: "fixture rejection" },
    })
  t.after(async () => {
    await client.close()
    const resolved = fs.realpathSync.native(root)
    if (
      path.dirname(resolved) !== fs.realpathSync.native(runs) ||
      !path.basename(resolved).startsWith("native-capability-")
    )
      throw new Error("Unsafe capability fixture cleanup")
    fs.rmSync(resolved, { recursive: true, force: true })
  })
  return {
    client,
    outgoing,
    replies,
    rejections,
    request,
    service,
    finish,
    audits,
    settings,
    restarts: () => restarts,
  }
}

test("native session grants cannot be replaced through public configuration properties", async t => {
  const f = fixture(t)
  assert.throws(() => {
    f.client.config = { ...f.client.config, allowCoreRestart: true }
  }, TypeError)
  assert.throws(
    () => Object.defineProperty(f.client, "config", { value: { allowCoreRestart: true } }),
    TypeError,
  )
  assert.throws(() => {
    f.client.config.redis.read.push("*")
  }, TypeError)
  // 旧版可写的 settings 字段不再参与实际授权。
  f.client.settings = parseSettings({})
  const master = await f.request(false, { isMaster: true })
  await f.client.service({
    type: "native-service",
    id: "1",
    service: "core",
    method: "restart",
    args: [],
    requestId: master.id,
    plugin: "system",
    action: "audit",
    allowCoreRestart: true,
  })
  assert.equal(f.outgoing.findLast(frame => frame.type === "native-service-result").ok, false)
  assert.equal(f.restarts(), 0)
  f.finish(master)
  await master.promise
})

test("违规插件回收消息实例时等待自身退出，不请求无关插件重启", async t => {
  const f = fixture(t)
  let finish
  f.client.session.close = () =>
    new Promise(resolve => {
      finish = resolve
    })
  f.client.retiring = true
  let completed = false
  const release = f.client.releaseInstances([]).then(() => {
    completed = true
  })
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(completed, false)
  assert.equal(f.outgoing.length, 0)
  finish()
  await release
  assert.equal(completed, true)
  assert.equal(f.restarts(), 0)
  assert.equal(
    f.audits.some(event => event.operation === "native.cleanup-unconfirmed"),
    false,
  )
  assert.ok(f.audits.some(event => event.operation === "native.process-closed"))
})

test("session snapshots keep verified permissions despite hooked array lookup and cloning globals", async t => {
  const f = fixture(t)
  assert.throws(() => snapshotSettings({ ...f.settings }), /须先解析配置再创建会话/)
  const find = Array.prototype.find,
    map = Array.prototype.map,
    clone = globalThis.structuredClone
  const forged = { ...f.client.config, allowCoreRestart: true, network: "host" }
  let calls = 0,
    snapshot
  const poison = () => {
    calls++
    return forged
  }
  try {
    Array.prototype.find = poison
    Array.prototype.map = poison
    globalThis.structuredClone = poison
    snapshot = snapshotSettings(f.settings)
  } finally {
    Array.prototype.find = find
    Array.prototype.map = map
    globalThis.structuredClone = clone
  }
  assert.equal(calls, 0)
  assert.notEqual(snapshot, f.settings)
  assert.notEqual(snapshot.pluginSandbox.native.plugins[0], f.client.config)
  assert.equal(snapshot.pluginSandbox.native.plugins[0].allowCoreRestart, false)
  assert.equal(snapshot.pluginSandbox.native.plugins[0].network, "none")
  assert.equal(Object.isFrozen(snapshot.pluginSandbox.native.plugins[0].redis.read), true)
  const client = new NativePluginClient(
    f.client.root,
    forged,
    snapshot,
    () => {},
    () => ({}),
  )
  assert.equal(client.config.allowCoreRestart, false)
  assert.equal(client.config.network, "none")
  await client.close()
})

test("core restart requires a live host master callback, cannot be forged or replayed, and still obeys policy", async t => {
  const f = fixture(t, () => ({}), undefined, [], true)
  const ordinary = await f.request(),
    master = await f.request(false, { isMaster: true })
  let sequence = 0
  const restart = async (requestId, args = []) => {
    await f.client.service({
      type: "native-service",
      id: String(++sequence),
      service: "core",
      method: "restart",
      requestId,
      args,
    })
    return f.outgoing.findLast(frame => frame.type === "native-service-result")
  }
  assert.equal((await restart("forged-request")).ok, false)
  assert.equal((await restart(ordinary.id, [{ isMaster: true }])).ok, false)
  assert.equal((await restart(ordinary.id)).ok, false)
  f.client.pending.get(master.id).type = "native-load"
  assert.equal((await restart(master.id)).ok, false)
  f.client.pending.get(master.id).type = "native-call"
  assert.equal(
    f.audits.some(event => event.action === "restart"),
    false,
  )
  assert.equal((await restart(master.id)).ok, true)
  assert.equal((await restart(master.id)).ok, false)
  assert.equal(f.restarts(), 1)
  f.finish(master)
  await master.promise
  assert.equal((await restart(master.id)).ok, false)
  assert.equal(f.restarts(), 1)
  const denied = fixture(
    t,
    () => ({}),
    undefined,
    [
      {
        id: "block-core-restart",
        kind: "plugin-sandbox",
        operation: "native.core.restart",
        target: "controlled-core",
        action: "deny",
      },
    ],
    true,
  )
  const blocked = await denied.request(false, { isMaster: true })
  await denied.client.service({
    type: "native-service",
    id: "1",
    service: "core",
    method: "restart",
    requestId: blocked.id,
    args: [],
  })
  assert.equal(denied.outgoing.at(-1).ok, false)
  assert.equal(
    denied.audits.some(event => event.action === "restart"),
    false,
  )
  assert.equal(f.restarts(), 1)
  denied.finish(blocked)
  await blocked.promise
  f.finish(ordinary)
  await ordinary.promise
  const ungranted = fixture(t)
  const owner = await ungranted.request(false, { isMaster: true })
  await ungranted.client.service({
    type: "native-service",
    id: "1",
    service: "core",
    method: "restart",
    requestId: owner.id,
    args: [],
  })
  assert.equal(ungranted.outgoing.at(-1).ok, false)
  assert.equal(
    ungranted.audits.some(event => event.action === "restart"),
    false,
  )
  ungranted.finish(owner)
  await owner.promise
})

test("native Redis broker preserves original names and refuses unauthorized keys before dispatch", async t => {
  const data = new Map([["Business:state", "before"]]),
    calls = [],
    target = {
      get(key) {
        calls.push(["get", key])
        return data.get(key) ?? null
      },
      set(key, value) {
        calls.push(["set", key, value])
        data.set(key, value)
        return "OK"
      },
    },
    f = fixture(t, () => target, { read: ["Business:*"], write: ["Business:*"] })
  let id = 0
  const request = async (method, args) => {
    await f.client.service({
      type: "native-service",
      id: String(++id),
      service: "redis",
      method,
      args,
    })
    return f.outgoing.at(-1)
  }
  assert.equal((await request("get", ["Business:state"])).value, "before")
  assert.equal((await request("set", ["Business:state", "after"])).ok, true)
  assert.equal((await request("get", ["Other:secret"])).ok, false)
  const rejection = f.audits.find(event => event.operation === "native.service-error")
  assert.equal(rejection.target, "redis.get")
  assert.deepEqual(rejection.details, {
    phase: "result",
    result: "error",
    code: "NATIVE_REDIS_DENIED",
  })
  assert.equal(JSON.stringify(f.audits).includes("Other:secret"), false)
  assert.equal((await request("get", ["yunzai-guard:state"])).ok, false)
  assert.deepEqual(calls, [
    ["get", "Business:state"],
    ["set", "Business:state", "after"],
  ])
  assert.deepEqual([...data], [["Business:state", "after"]])
})

test("ordinary business sessions cannot forge adapter registration or core account events", t => {
  const f = fixture(t)
  for (const type of ["register", "account", "event", "remove"])
    assert.throws(
      () => f.client.receive({ type: "native-adapter", frame: { type } }),
      /未授予适配器能力/,
    )
  assert.equal(f.client.adapterHost, undefined)
})

test("handlerReject requires a live request-specific host capability and revokes it on result", async t => {
  const f = fixture(t)
  const granted = await f.request(true),
    ordinary = await f.request()
  await f.service("handlerReject", "forged-request", ["forged"])
  await f.service("handlerReject", ordinary.id, ["not granted"])
  await f.service("handlerReject", granted.id, [{ message: "not text" }])
  await f.service("handlerReject", granted.id, ["too", "many"])
  assert.deepEqual(f.rejections, [])
  await f.service("handlerReject", granted.id, ["allowed"])
  assert.deepEqual(f.rejections, ["allowed"])
  f.finish(granted)
  await granted.promise
  await f.service("handlerReject", granted.id, ["too late"])
  assert.deepEqual(f.rejections, ["allowed"])
  f.finish(ordinary)
  await ordinary.promise
})

test("failed request results immediately revoke reply and Handler reject capabilities", async t => {
  const f = fixture(t),
    active = await f.request(true)
  f.finish(active, false)
  await assert.rejects(active.promise, /fixture rejection/)
  await f.service("reply", active.id, ["late"])
  await f.service("handlerReject", active.id, ["late"])
  await f.service("reply", "other-session-request", ["forged"])
  assert.deepEqual(f.replies, [])
  assert.deepEqual(f.rejections, [])
})

for (const [name, error] of [
  ["non-object error", []],
  ["non-coercible error message", { message: { toString: 1 } }],
]) {
  test(`malformed native result settles its pending host request: ${name}`, async t => {
    const f = fixture(t),
      active = await f.request(true)
    let outcome = "pending"
    active.promise.then(
      () => {
        outcome = "resolved"
      },
      () => {
        outcome = "rejected"
      },
    )
    try {
      f.client.receive({ type: "native-result", requestId: active.id, ok: false, error })
    } catch (failure) {
      f.client.stop(failure)
    } // 复用已认证传输监听器的错误路径。
    await new Promise(resolve => setImmediate(resolve))
    assert.equal(
      outcome,
      "rejected",
      "Clearing the timer before validating a result must not strand the host await",
    )
    assert.equal(f.client.events.has(active.id), false)
    assert.equal(f.client.capabilities.has(active.id), false)
  })
}

test("audit rules cannot turn a text reply capability into a media or host-file capability", async t => {
  const f = fixture(t),
    active = await f.request()
  await f.service("reply", active.id, [{ type: "image", file: "file:///host/private" }])
  await f.service("reply", active.id, ["text", false, { file: "host/private" }])
  assert.deepEqual(f.replies, [])
  await f.service("reply", active.id, ["allowed", true])
  assert.deepEqual(f.replies, [["allowed", true, {}]])
  f.finish(active)
  await active.promise
})

test(
  "concurrent native callbacks keep this.e.reply bound to their own request",
  { timeout: 15000 },
  async t => {
    const runs = path.join(repository, "tests/runs")
    fs.mkdirSync(runs, { recursive: true })
    const root = fs.mkdtempSync(path.join(runs, "native-callback-capability-"))
    const write = (name, source) => {
      const file = path.join(root, name)
      fs.mkdirSync(path.dirname(file), { recursive: true })
      fs.writeFileSync(file, source)
    }
    write("package.json", '{"type":"module"}')
    write(
      "lib/plugins/plugin.js",
      "export default class plugin {constructor(options){Object.assign(this,options)} reply(...args){return this.e.reply(...args)}}",
    )
    for (const name of ["lodash", "oicq"]) {
      write(
        `node_modules/${name}/package.json`,
        JSON.stringify({ name, type: "module", main: "index.js" }),
      )
      write(
        `node_modules/${name}/index.js`,
        name === "lodash"
          ? "export default {}"
          : 'export const segment={text:text=>({type:"text",text})}',
      )
    }
    const source = `export class Fixture extends plugin { constructor(){super({name:'fixture',priority:1,rule:[],task:[]});this.task=[0,1].map(index=>({name:'callback-'+index,cron:'* * * * * *',fnc:async()=>{globalThis.started[index].resolve();await globalThis.gates[index].promise;await redis.get('request-'+index);return this.reply('reply-'+index)}}))} }`
    write("plugins/fixture/index.js", source)
    write(
      "runner.mjs",
      `
    import {NativeGuest} from ${JSON.stringify(pathToFileURL(path.join(repository, "dist/native-sandbox/guest.js")).href)};
    globalThis.gates=[Promise.withResolvers(),Promise.withResolvers()];
    globalThis.started=[Promise.withResolvers(),Promise.withResolvers()];
    const services=[];
    const guest=new NativeGuest({send(){},async service(service,method,args,requestId){services.push({service,method,args,requestId});return true}});
    const loaded=await guest.load('load',process.cwd(),process.cwd()+'/plugins/fixture',process.cwd()+'/plugins/fixture/index.js');
    const descriptor=loaded.classes[0],handles=descriptor.metadata.task.map(task=>task.fnc.id);
    const first=guest.callback('request-A',descriptor.id,handles[0],{user_id:'A'});
    await started[0].promise;
    const second=guest.callback('request-B',descriptor.id,handles[1],{user_id:'B'});
    await started[1].promise;
    gates[0].resolve();gates[1].resolve();await Promise.all([first,second]);
    console.log(JSON.stringify(services));
  `,
    )
    t.after(() => {
      assert.equal(fs.readFileSync(path.join(root, "plugins/fixture/index.js"), "utf8"), source)
      const resolved = fs.realpathSync.native(root)
      if (
        path.dirname(resolved) !== fs.realpathSync.native(runs) ||
        !path.basename(resolved).startsWith("native-callback-capability-")
      )
        throw new Error("Unsafe callback fixture cleanup")
      fs.rmSync(resolved, { recursive: true, force: true })
    })
    const { stdout } = await promisify(execFile)(
      process.execPath,
      [path.join(root, "runner.mjs")],
      {
        cwd: root,
        env: { ...process.env, NODE_OPTIONS: "" },
        timeout: 10000,
        windowsHide: true,
        maxBuffer: 64 * 1024,
      },
    )
    const services = JSON.parse(stdout)
    for (const [index, requestId] of ["request-A", "request-B"].entries()) {
      assert.ok(
        services.some(
          row =>
            row.service === "event" &&
            row.args[0] === `reply-${index}` &&
            row.requestId === requestId,
        ),
      )
      assert.ok(
        services.some(
          row =>
            row.service === "redis" &&
            row.args[0] === `request-${index}` &&
            row.requestId === requestId,
        ),
      )
    }
    assert.equal(services.length, 4)
  },
)
