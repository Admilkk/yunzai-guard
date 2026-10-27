import assert from "node:assert/strict"
import test from "node:test"
import {
  executeNativeRedis,
  prepareNativeRedisCommand,
  validateNativeRedisResult,
} from "../dist/native-sandbox/redis.js"
import { parseNativeRedisPermissions } from "../dist/native-sandbox/config.js"

function fixture() {
  const store = new Map(),
    calls = []
  const client = {
    get(key) {
      calls.push({ method: "get", args: [key] })
      return store.get(key) ?? null
    },
    set(key, value, options) {
      calls.push({ method: "set", args: [key, value, options] })
      const old = store.get(key) ?? null
      store.set(key, value)
      return options?.GET ? old : "OK"
    },
    del(keys) {
      calls.push({ method: "del", args: [keys] })
      return keys.reduce((count, key) => count + Number(store.delete(key)), 0)
    },
    exists(keys) {
      calls.push({ method: "exists", args: [keys] })
      return keys.filter(key => store.has(key)).length
    },
  }
  return { store, calls, client }
}
const grants = (read = [], write = []) => parseNativeRedisPermissions({ read, write })
const denied = error => error.code === "NATIVE_REDIS_DENIED"

test("native Redis writes keep original keys so removing Guard does not hide business data", async () => {
  const f = fixture(),
    policy = grants(["Business:*"], ["Business:*"])
  f.store.set("Business:state", "before-guard")
  assert.equal(
    await executeNativeRedis(f.client, policy, "get", ["Business:state"]),
    "before-guard",
  )
  assert.equal(
    await executeNativeRedis(f.client, policy, "set", ["Business:state", "sandbox-updated"]),
    "OK",
  )
  assert.equal(
    f.store.get("Business:state"),
    "sandbox-updated",
    "An unwrapped client continues to see the same original key",
  )
  assert.deepEqual([...f.store.keys()], ["Business:state"])
  assert.equal(
    [...f.store.keys()].some(key => key.startsWith("yunzai-guard:")),
    false,
  )
})

test("no native Redis permission is implied by enabling the plugin or by an audit rule", async () => {
  const f = fixture()
  for (const permissions of [undefined, grants()])
    await assert.rejects(executeNativeRedis(f.client, permissions, "get", ["business:key"]), denied)
  await assert.rejects(
    executeNativeRedis(f.client, grants(["business:key"]), "set", ["business:key", "denied"]),
    denied,
  )
  await assert.rejects(
    executeNativeRedis(f.client, grants([], ["business:key"]), "get", ["business:key"]),
    denied,
  )
  assert.equal(f.calls.length, 0)
})

test("key grants are case-sensitive literal prefixes and exact names without regex interpretation", () => {
  const policy = grants(["business:key", "literal.(name)+:*", "Case:*"])
  for (const key of ["business:key", "literal.(name)+:123", "Case:Item"])
    assert.equal(prepareNativeRedisCommand(policy, "get", [key]).args[0], key)
  for (const key of ["business:key:extra", "literal.Xname+:123", "case:Item", "unrelated:key"])
    assert.throws(() => prepareNativeRedisCommand(policy, "get", [key]), denied)
  assert.throws(
    () => prepareNativeRedisCommand({ read: ["*"], write: [] }, "get", ["unrelated:key"]),
    /native\.redis\.read\[0\] 须为确切键或“非空前缀\*”/,
  )
  assert.throws(
    () => prepareNativeRedisCommand(grants(["business:*"]), "get", ["yunzai-guard:plugin:old:key"]),
    denied,
  )
})

test("multi-key operations validate all original names before one host operation", async () => {
  const f = fixture(),
    policy = grants(["business:*"], ["business:*"])
  f.store.set("business:first", "one")
  f.store.set("business:second", "two")
  f.store.set("peer:state", "keep")
  await assert.rejects(
    executeNativeRedis(f.client, policy, "del", [["business:first", "peer:state"]]),
    denied,
  )
  assert.equal(f.calls.length, 0)
  assert.equal(f.store.get("business:first"), "one")
  assert.equal(
    await executeNativeRedis(f.client, policy, "exists", ["business:first", "business:second"]),
    2,
  )
  const keys = ["business:first", "business:second"]
  assert.equal(await executeNativeRedis(f.client, policy, "del", [keys]), 2)
  assert.deepEqual(keys, ["business:first", "business:second"])
  assert.deepEqual(f.calls.at(-1), { method: "del", args: [["business:first", "business:second"]] })
  assert.equal(f.store.get("peer:state"), "keep")
  assert.throws(() => prepareNativeRedisCommand(policy, "del", [[]]), denied)
})

test("SET GET and content-returning mutations require both read and write rights", async () => {
  const f = fixture(),
    write = grants([], ["business:*"]),
    both = grants(["business:*"], ["business:*"])
  f.store.set("business:key", "previous")
  await assert.rejects(
    executeNativeRedis(f.client, write, "set", ["business:key", "new", { GET: true }]),
    denied,
  )
  assert.equal(f.store.get("business:key"), "previous")
  assert.equal(
    await executeNativeRedis(f.client, both, "set", ["business:key", "new", { GET: true }]),
    "previous",
  )
  for (const [method, args] of [
    ["incr", ["business:n"]],
    ["decrBy", ["business:n", 2]],
    ["lPop", ["business:list"]],
    ["rPop", ["business:list"]],
  ]) {
    assert.throws(() => prepareNativeRedisCommand(write, method, args), denied)
    assert.equal(prepareNativeRedisCommand(both, method, args).method, method)
  }
})

test("Redis command surface rejects raw scans, arbitrary commands and unbounded list reads", async () => {
  const f = fixture(),
    policy = grants(["business:*"], ["business:*"])
  for (const method of [
    "scan",
    "scanIterator",
    "eval",
    "sendCommand",
    "multi",
    "flushAll",
    "rename",
    "toString",
  ])
    await assert.rejects(executeNativeRedis(f.client, policy, method, ["business:*"]), denied)
  for (const range of [
    [0, -1],
    [0, 256],
    [-257, -1],
    [0, 1.5],
    [0, Infinity],
  ])
    assert.throws(
      () => prepareNativeRedisCommand(policy, "lRange", ["business:list", ...range]),
      denied,
    )
  for (const range of [
    [0, 255],
    [-256, -1],
    [100, 1],
  ])
    assert.deepEqual(
      prepareNativeRedisCommand(policy, "lRange", ["business:list", ...range]).args,
      ["business:list", ...range],
    )
  assert.equal(f.calls.length, 0)
})

test("keys uses only authorized original names and bounded SCAN, never host KEYS", async () => {
  const calls = [],
    policy = grants(["business:*"])
  const client = {
    keys() {
      throw new Error("Host KEYS must never be called")
    },
    exists: async names => (names[0] === "business:known" ? 1 : 0),
    async scan(cursor, options) {
      calls.push({ cursor, options })
      return cursor === 0
        ? { cursor: 7, keys: ["business:a", "business:b"] }
        : { cursor: 0, keys: ["business:b", "business:c"] }
    },
  }
  assert.deepEqual(await executeNativeRedis(client, policy, "keys", ["business:*"]), [
    "business:a",
    "business:b",
    "business:c",
  ])
  assert.deepEqual(
    calls.map(row => row.options),
    [
      { MATCH: "business:*", COUNT: 100 },
      { MATCH: "business:*", COUNT: 100 },
    ],
  )
  assert.deepEqual(await executeNativeRedis(client, policy, "keys", ["business:known"]), [
    "business:known",
  ])
  assert.deepEqual(await executeNativeRedis(client, policy, "keys", ["business:missing"]), [])
  for (const query of ["*", "bus*", "business:?", "business:[abc]", "peer:*"])
    await assert.rejects(executeNativeRedis(client, policy, "keys", [query]), denied)
  assert.equal(calls.length, 2)
})

test("key scans reject leaked names, oversized results and step exhaustion instead of returning partial data", async () => {
  const policy = grants(["business:*"])
  for (const keys of [
    ["peer:secret"],
    Array.from({ length: 257 }, (_, index) => `business:${index}`),
    Array.from({ length: 40 }, (_, index) => `business:${index}:${"x".repeat(2000)}`),
  ])
    await assert.rejects(
      executeNativeRedis({ scan: async () => ({ cursor: 0, keys }) }, policy, "keys", [
        "business:*",
      ]),
      denied,
    )
  let calls = 0
  await assert.rejects(
    executeNativeRedis({ scan: async () => ({ cursor: ++calls, keys: [] }) }, policy, "keys", [
      "business:*",
    ]),
    /step limit/,
  )
  assert.equal(calls, 64)
})

test(
  "timed-out SCAN requests keep their concurrency leases until their underlying calls settle",
  { timeout: 5000 },
  async () => {
    const pending = [Promise.withResolvers(), Promise.withResolvers()]
    let calls = 0
    const client = {
        scan() {
          return pending[calls++].promise
        },
      },
      policy = grants(["business:*"])
    const first = executeNativeRedis(client, policy, "keys", ["business:*"]),
      second = executeNativeRedis(client, policy, "keys", ["business:*"])
    const done = Promise.allSettled([first, second])
    await assert.rejects(executeNativeRedis(client, policy, "keys", ["business:*"]), /concurrency/)
    for (const outcome of await done) {
      assert.equal(outcome.status, "rejected")
      assert.match(outcome.reason.message, /Redis 键扫描超时/)
    }
    await assert.rejects(executeNativeRedis(client, policy, "keys", ["business:*"]), /concurrency/)
    for (const request of pending) request.resolve({ cursor: 0, keys: [] })
    await new Promise(resolve => setImmediate(resolve))
    client.scan = async () => ({ cursor: 0, keys: ["business:recovered"] })
    assert.deepEqual(await executeNativeRedis(client, policy, "keys", ["business:*"]), [
      "business:recovered",
    ])
  },
)

test("sorted-set operations preserve original keys while bounding rank, score and lex retrieval", () => {
  const policy = grants(["business:*"], ["business:*"])
  for (const method of ["zRange", "zRangeWithScores"]) {
    for (const range of [
      [0, 255],
      [-10, -1],
    ])
      assert.deepEqual(
        prepareNativeRedisCommand(policy, method, ["business:z", ...range, { REV: true }]).args,
        ["business:z", ...range, Object.assign(Object.create(null), { REV: true })],
      )
    assert.equal(
      prepareNativeRedisCommand(policy, method, [
        "business:z",
        "-inf",
        "+inf",
        { BY: "SCORE", LIMIT: { offset: 0, count: 20 } },
      ]).method,
      method,
    )
    assert.equal(
      prepareNativeRedisCommand(policy, method, [
        "business:z",
        "[a",
        "[z",
        { BY: "LEX", LIMIT: { offset: 10, count: 20 } },
      ]).method,
      method,
    )
    for (const args of [
      [0, -1],
      [0, 256],
      ["-inf", "+inf", { BY: "SCORE" }],
      ["-inf", "+inf", { BY: "SCORE", LIMIT: { offset: 10001, count: 1 } }],
      ["-inf", "+inf", { BY: "SCORE", LIMIT: { offset: 0, count: 257 } }],
    ])
      assert.throws(
        () => prepareNativeRedisCommand(policy, method, ["business:z", ...args]),
        denied,
      )
  }
  assert.equal(
    prepareNativeRedisCommand(policy, "zRevRank", ["business:z", "member"]).method,
    "zRevRank",
  )
  assert.equal(
    prepareNativeRedisCommand(policy, "zRem", ["business:z", ["one", "two"]]).method,
    "zRem",
  )
  assert.equal(
    prepareNativeRedisCommand(grants([], ["business:*"]), "zAdd", [
      "business:z",
      { score: 2, value: "one" },
    ]).method,
    "zAdd",
  )
  assert.throws(
    () =>
      prepareNativeRedisCommand(grants([], ["business:*"]), "zAdd", [
        "business:z",
        { score: 2, value: "one" },
        { INCR: true },
      ]),
    denied,
  )
  assert.equal(
    prepareNativeRedisCommand(policy, "zAdd", [
      "business:z",
      { score: 2, value: "one" },
      { INCR: true },
    ]).method,
    "zAdd",
  )
})

test("Redis result limits reject oversized structures and unsafe accessors before JSON encoding", async () => {
  for (const result of [
    "x".repeat(65537),
    "\0".repeat(12000),
    Array(257).fill("x"),
    Object.fromEntries(Array.from({ length: 257 }, (_, index) => [index, "x"])),
    { value: Infinity },
  ])
    assert.throws(() => validateNativeRedisResult(result), denied)
  let invoked = false
  const result = {}
  Object.defineProperty(result, "secret", {
    enumerable: true,
    get() {
      invoked = true
      return "unsafe"
    },
  })
  assert.throws(() => validateNativeRedisResult(result), denied)
  assert.equal(invoked, false)
  const policy = grants(["business:*"])
  await assert.rejects(
    executeNativeRedis({ get: async () => "x".repeat(65537) }, policy, "get", ["business:key"]),
    denied,
  )
  assert.doesNotThrow(() => validateNativeRedisResult([{ value: "成员", score: 2 }]))
})

test("argument validation rejects accessors and invalid SET flags before dispatch", async () => {
  const f = fixture(),
    policy = grants(["business:*"], ["business:*"])
  let invoked = false
  const options = {}
  Object.defineProperty(options, "GET", {
    enumerable: true,
    get() {
      invoked = true
      return true
    },
  })
  await assert.rejects(
    executeNativeRedis(f.client, policy, "set", ["business:key", "value", options]),
    denied,
  )
  for (const options of [{ GET: "true" }, { EX: 0 }, { unknown: true }, "GET"])
    await assert.rejects(
      executeNativeRedis(f.client, policy, "set", ["business:key", "value", options]),
      denied,
    )
  await assert.rejects(
    executeNativeRedis(f.client, policy, "set", ["business:key", "x".repeat(65536)]),
    denied,
  )
  assert.equal(invoked, false)
  assert.equal(f.calls.length, 0)
})
