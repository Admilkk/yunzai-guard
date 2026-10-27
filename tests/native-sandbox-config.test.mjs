import assert from "node:assert/strict"
import test from "node:test"
import {
  parseNativeSandbox,
  validateNativeWritablePaths,
  validateNativeWritableFiles,
  validateNativeWriteGrants,
  parseNativeRedisPermissions,
  nativeSharedWritablePaths,
} from "../dist/native-sandbox/config.js"

test("native plugin sandbox is opt-in and applies least-privilege defaults to each directory", () => {
  assert.deepEqual(parseNativeSandbox(), { plugins: [] })
  assert.deepEqual(parseNativeSandbox({}), { plugins: [] })
  assert.deepEqual(parseNativeSandbox({ plugins: [{ id: "Telegram-Plugin" }] }), {
    plugins: [
      {
        id: "Telegram-Plugin",
        enabled: true,
        timeoutMs: 10000,
        network: "none",
        hookAction: "deny",
        adapters: false,
        allowCoreRestart: false,
        writablePaths: [],
        writableFiles: [],
        redis: { read: [], write: [] },
      },
    ],
  })
})

test("per-plugin settings remain independent and survive serialized IPC without changing case", () => {
  const normalized = parseNativeSandbox({
    plugins: [
      {
        id: "Guoba-Plugin",
        enabled: false,
        timeoutMs: 60000,
        network: "host",
        hookAction: "audit",
      },
      { id: "kh-plugin", timeoutMs: 100, hookAction: "restart" },
    ],
  })
  assert.deepEqual(normalized.plugins[0], {
    id: "Guoba-Plugin",
    enabled: false,
    timeoutMs: 60000,
    network: "host",
    hookAction: "audit",
    adapters: false,
    allowCoreRestart: false,
    writablePaths: [],
    writableFiles: [],
    redis: { read: [], write: [] },
  })
  assert.deepEqual(normalized.plugins[1], {
    id: "kh-plugin",
    enabled: true,
    timeoutMs: 100,
    network: "none",
    hookAction: "restart",
    adapters: false,
    allowCoreRestart: false,
    writablePaths: [],
    writableFiles: [],
    redis: { read: [], write: [] },
  })
  assert.deepEqual(parseNativeSandbox(JSON.parse(JSON.stringify(normalized))), normalized)
})

test("directory identities refuse traversal, device names, core directories and Guard itself", () => {
  for (const id of [
    "",
    ".",
    "..",
    "../plugin",
    "a/b",
    "a\\b",
    "a.js",
    "C:evil",
    "plugin:stream",
    "C:\\plugin",
    " plugin",
    "plugin ",
    "CON",
    "nul",
    "Lpt9",
    "com1",
    "CON.txt",
    "adapter",
    "SYSTEM",
    "Other",
    "example",
    "YUNZAI-GUARD",
    "x".repeat(129),
  ])
    assert.throws(() => parseNativeSandbox({ plugins: [{ id }] }), TypeError, id)
  assert.throws(
    () => parseNativeSandbox({ plugins: [{ id: "Guoba-Plugin" }, { id: "guoba-plugin" }] }),
    /settings\.pluginSandbox\.native\.plugins 有重复目录 id（不区分大小写）/,
  )
})

test("invalid settings never silently relax authority or evaluate getters", () => {
  for (const input of [
    null,
    { plugins: null },
    { extra: true },
    { plugins: Array.from({ length: 129 }, (_, index) => ({ id: `plugin-${index}` })) },
    ...[
      { enabled: "false" },
      { timeoutMs: 99 },
      { timeoutMs: 60001 },
      { timeoutMs: 1.5 },
      { network: "allow" },
      { network: null },
      { hookAction: "allow" },
      { hookAction: null },
      { adapters: "true" },
      { adapters: 1 },
      { adapters: null },
      { allowCoreRestart: "true" },
      { allowCoreRestart: 1 },
      { allowCoreRestart: null },
      { capabilities: ["exec"] },
      { source: "../outside.js" },
    ].map(overrides => ({ plugins: [{ id: "business-plugin", ...overrides }] })),
  ])
    assert.throws(() => parseNativeSandbox(input), TypeError)
  let invoked = false
  const entry = { id: "business-plugin" }
  Object.defineProperty(entry, "network", {
    enumerable: true,
    get() {
      invoked = true
      return "host"
    },
  })
  assert.throws(
    () => parseNativeSandbox({ plugins: [entry] }),
    /settings\.pluginSandbox\.native\.plugins\[0\] 只能包含普通 JSON 属性/,
  )
  assert.equal(invoked, false)
})

test("protocol adapter authority requires an explicit per-plugin boolean grant", () => {
  const config = parseNativeSandbox({
    plugins: [{ id: "protocol", adapters: true }, { id: "business" }],
  })
  assert.equal(config.plugins[0].adapters, true)
  assert.equal(config.plugins[1].adapters, false)
})

test("validated native settings are deeply frozen without freezing caller input", () => {
  const input = { plugins: [{ id: "business-plugin" }] }
  const config = parseNativeSandbox(input)
  assert.equal(Object.isFrozen(config), true)
  assert.equal(Object.isFrozen(config.plugins), true)
  assert.equal(Object.isFrozen(config.plugins[0]), true)
  input.plugins[0].id = "another-plugin"
  assert.equal(config.plugins[0].id, "business-plugin")
  assert.throws(() => (config.plugins[0].network = "host"), TypeError)
})

test("native Redis permissions preserve explicit original key names and default to no grants", () => {
  assert.deepEqual(parseNativeRedisPermissions(), { read: [], write: [] })
  const input = {
    plugins: [
      {
        id: "business",
        redis: { read: ["Business:cache:*", "shared:version"], write: ["Business:cache:*"] },
      },
    ],
  }
  const config = parseNativeSandbox(input)
  assert.deepEqual(config.plugins[0].redis, input.plugins[0].redis)
  assert.equal(Object.isFrozen(config.plugins[0].redis), true)
  assert.equal(Object.isFrozen(config.plugins[0].redis.read), true)
  assert.equal(Object.isFrozen(config.plugins[0].redis.write), true)
  input.plugins[0].redis.read.push("unrelated:key")
  assert.equal(config.plugins[0].redis.read.length, 2)
  assert.deepEqual(parseNativeSandbox(JSON.parse(JSON.stringify(config))), config)
  assert.deepEqual(parseNativeRedisPermissions({ read: ["literal.(name)+:*"] }).read, [
    "literal.(name)+:*",
  ])
})

test("Redis grants reject whole databases, general globs, Guard state and accessor configuration", () => {
  for (const value of [
    null,
    { unknown: [] },
    { read: null },
    { write: "*" },
    { read: Array(33).fill("business:key") },
    ...[
      "",
      "*",
      "business*middle",
      "business**",
      "business:?",
      "business:[a]",
      "business:\\key",
      "business:\u0001key",
      "yunzai-guard:control",
      "YUNZAI-GUARD:*",
      "yunzaiguard:*",
      "y*",
      " key ",
      "x".repeat(257),
    ].map(pattern => ({ read: [pattern] })),
  ])
    assert.throws(() => parseNativeRedisPermissions(value), TypeError)
  assert.throws(
    () => parseNativeRedisPermissions({ write: ["business:*", "business:*"] }),
    /native\.redis\.write 有重复授权/,
  )
  let invoked = false
  const read = []
  Object.defineProperty(read, "0", {
    enumerable: true,
    get() {
      invoked = true
      return "*"
    },
  })
  assert.throws(
    () => parseNativeRedisPermissions({ read }),
    /native\.redis\.read 只能包含普通 JSON 数组元素/,
  )
  assert.equal(invoked, false)
})

test("explicit native data grants preserve original paths and grant nothing by default", () => {
  const input = {
    plugins: [
      {
        id: "KOOK-Plugin",
        writablePaths: ["data/KOOK", "temp/kook-cache", "config/kook-config"],
        writableFiles: ["config/KOOK.yaml", "config/config/kook-plugin.yaml"],
      },
    ],
  }
  const config = parseNativeSandbox(input)
  assert.deepEqual(config.plugins[0].writablePaths, input.plugins[0].writablePaths)
  assert.deepEqual(config.plugins[0].writableFiles, input.plugins[0].writableFiles)
  assert.equal(Object.isFrozen(config.plugins[0].writablePaths), true)
  assert.equal(Object.isFrozen(config.plugins[0].writableFiles), true)
  input.plugins[0].writablePaths.push("data/unrelated")
  assert.equal(config.plugins[0].writablePaths.length, 3)
  assert.deepEqual(parseNativeSandbox(JSON.parse(JSON.stringify(config))), config)
})

test("write grants reject broad roots, protected state, unsafe syntax and Windows device aliases", () => {
  for (const target of [
    "data",
    "config",
    "temp",
    "data/",
    "config/config",
    "config/config/anything",
    "config/default_config",
    "config/default_config/foo",
    "Data/Yunzai-Guard",
    "data/yunzai-guard/state",
    "plugins/other",
    "lib/plugins",
    "node_modules/lib",
    "data/../config",
    "data/./name",
    "data//name",
    "data\\name",
    "C:/data/name",
    "/data/name",
    "data/name:stream",
    "data/*",
    "data/[name]",
    "data/{name}",
    "data/COM1",
    "temp/NUL.txt",
    "data/COM¹",
    "data/name.",
    "data/name ",
  ])
    assert.throws(() => validateNativeWritablePaths([target]), TypeError, target)
  for (const target of [
    "config/config",
    "config/default_config/custom.yaml",
    "config/BOT.YAML",
    "config/config/redis.yaml",
    "config/config/qq.yaml",
    "data/yunzai-guard/control.json",
  ])
    assert.throws(() => validateNativeWritableFiles([target]), TypeError, target)
  assert.throws(() =>
    validateNativeWritableFiles(["config/config/future.yaml"], "test", ["future.yaml"]),
  )
  assert.throws(() => validateNativeWritableFiles([], "test", ["config/future.yaml"]))
})

test("write scopes refuse ancestor, file and case aliases while enabled plugins can explicitly share an exact directory", () => {
  for (const paths of [
    ["data/shared", "DATA/SHARED"],
    ["data/shared", "data/shared/nested"],
    ["data/shared/nested", "data/shared"],
  ])
    assert.throws(
      () => validateNativeWritablePaths(paths),
      /native\.writablePaths 有相同或重叠路径（不区分大小写）/,
    )
  assert.throws(
    () => validateNativeWriteGrants(["data/shared"], ["data/shared/state.json"]),
    /native 目录与文件授权重叠/,
  )
  assert.throws(
    () =>
      validateNativeWriteGrants(
        Array.from({ length: 16 }, (_, i) => `data/p${i}`),
        ["temp/file.txt"],
      ),
    /16/,
  )
  for (const second of [
    { writablePaths: ["DATA/SHARED"] },
    { writablePaths: ["data/shared/child"] },
    { writableFiles: ["data/shared/state.json"] },
  ])
    assert.throws(
      () =>
        parseNativeSandbox({
          plugins: [
            { id: "first", writablePaths: ["data/shared"] },
            { id: "second", ...second },
          ],
        }),
      / 重叠（不区分大小写）/,
    )
  assert.doesNotThrow(() =>
    parseNativeSandbox({
      plugins: [
        { id: "first", writablePaths: ["data/shared-a"] },
        { id: "second", writableFiles: ["data/shared-b/state.json"] },
      ],
    }),
  )
  const settings = parseNativeSandbox({
    plugins: [
      { id: "first", writablePaths: ["data/shared", "data/first"] },
      { id: "second", writablePaths: ["data/shared"] },
      { id: "disabled", enabled: false, writablePaths: ["data/first/nested", "data/shared"] },
    ],
  })
  assert.deepEqual(nativeSharedWritablePaths(settings, "first"), ["data/shared"])
  assert.deepEqual(nativeSharedWritablePaths(settings, "second"), ["data/shared"])
  assert.deepEqual(nativeSharedWritablePaths(settings, "disabled"), [])
  assert.deepEqual(nativeSharedWritablePaths(settings, "unknown"), [])
  assert.deepEqual(
    nativeSharedWritablePaths(
      parseNativeSandbox({
        plugins: [
          { id: "first", writablePaths: ["data/shared"] },
          { id: "disabled", enabled: false, writablePaths: ["data/shared"] },
        ],
      }),
      "first",
    ),
    [],
  )
  assert.throws(
    () =>
      parseNativeSandbox({
        plugins: [
          { id: "first", writableFiles: ["data/shared/state.json"] },
          { id: "second", writableFiles: ["data/shared/state.json"] },
        ],
      }),
    / 重叠（不区分大小写）/,
  )
})

test("launch-time validators refuse accessors and do not execute path expressions", () => {
  let invoked = false
  const paths = []
  Object.defineProperty(paths, "0", {
    enumerable: true,
    get() {
      invoked = true
      return "data/anything"
    },
  })
  assert.throws(
    () => validateNativeWritablePaths(paths),
    /native\.writablePaths 只能包含普通 JSON 数组元素/,
  )
  assert.equal(invoked, false)
  assert.throws(() => validateNativeWritablePaths(["data/$(command)"]), TypeError)
})
