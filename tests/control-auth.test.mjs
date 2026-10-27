import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"
import { test } from "node:test"
import { createControlSigner, createControlVerifier } from "../dist/runtime/control.js"

const key = "b2".repeat(32)

test("control authentication rejects tampering, forged identity and replay", () => {
  const sign = createControlSigner(key, 3, 123)
  const verify = createControlVerifier(key, 3, 123)
  const frame = sign("restart-request")
  for (const patch of [
    { type: "stop-request" },
    { generation: 4 },
    { pid: 124 },
    { sequence: 999999 },
    { signature: "00".repeat(32) },
    { signature: undefined },
  ])
    assert.equal(verify({ ...frame, ...patch }), false)
  assert.equal(createControlVerifier("c3".repeat(32), 3, 123)(frame), false)
  assert.equal(verify(frame), true)
  assert.equal(verify(frame), false)
  const skipped = sign("preload-ready")
  const later = sign("worker-online")
  assert.equal(verify(later), true)
  assert.equal(verify(skipped), false)
  assert.equal(verify(sign("stop-request")), true)
})

test("control authentication requires own primitive fields without reading getters", () => {
  const sign = createControlSigner(key, 3, 123)
  const verify = createControlVerifier(key, 3, 123)
  const frame = sign("preload-ready")
  let reads = 0
  const getter = { ...frame }
  Object.defineProperty(getter, "signature", {
    get() {
      reads++
      return frame.signature
    },
  })
  assert.equal(verify(getter), false)
  assert.equal(reads, 0)
  assert.equal(verify(Object.create(frame)), false)
  for (const sequence of [0, -1, NaN, Infinity, 1.5, "1", Number.MAX_SAFE_INTEGER + 1])
    assert.equal(verify({ ...frame, sequence }), false)
  assert.equal(verify(frame), true)
  assert.throws(() => createControlSigner("audit-nonce", 3, 123))
  assert.throws(() => createControlVerifier(key, 0, 123))
  assert.throws(() => createControlSigner(key, 3, 0))
})

test("control signing and bus state survive business changes to shared builtins", () => {
  const controlUrl = new URL("../dist/runtime/control.js", import.meta.url).href
  const busUrl = new URL("../dist/runtime/bus.js", import.meta.url).href
  const source = `
    import crypto, { Hmac } from "node:crypto"
    import { syncBuiltinESMExports } from "node:module"
    import { createControlVerifier } from ${JSON.stringify(controlUrl)}
    import { RuntimeBus } from ${JSON.stringify(busUrl)}
    const key = ${JSON.stringify(key)}
    const verify = createControlVerifier(key, 3, 123)
    const define = Object.defineProperty
    const descriptor = Object.getOwnPropertyDescriptor
    const probe = crypto.createHmac("sha256", "business")
    const handleKey = Object.getOwnPropertySymbols(probe).find(key => {
      const value = probe[key]
      return value && typeof value.init === "function" && typeof value.digest === "function"
    })
    const native = Object.getPrototypeOf(probe[handleKey])
    let blocked = 0
    for (const name of ["init", "update", "digest"]) {
      try { native[name] = function () { throw new Error("native handle leaked") } }
      catch (error) { if (error.code === "ERR_GUARD_SELF_PROTECTION") blocked++ }
    }
    try { Object.setPrototypeOf(native, {}) } catch { blocked++ }
    try { native.constructor.prototype = {} } catch { blocked++ }
    if (blocked !== 5) throw new Error("native HMAC dependencies are not protected")
    let leaked = false
    define(Hmac.prototype, handleKey, { configurable: true,
      set() { leaked = true; throw new Error("HMAC handle intercepted") } })
    const changes = [
      [crypto, "createHmac"], [crypto, "timingSafeEqual"],
      [Hmac.prototype, "update"], [Hmac.prototype, "digest"],
      [Buffer, "from"], [Buffer.prototype, "toString"], [Buffer.prototype, "hexWrite"],
      [Object.prototype, Symbol.toPrimitive],
      [JSON, "stringify"], [Object, "freeze"], [Object, "getOwnPropertyDescriptor"],
      [Number, "isInteger"], [String.prototype, "charCodeAt"],
      [Set.prototype, "add"], [Set.prototype, "has"], [Set.prototype, "delete"],
      [Object.prototype, "toJSON"],
    ]
    for (let i = 0; i < changes.length; i++) {
      const row = changes[i]
      row[2] = descriptor(row[0], row[1])
      define(row[0], row[1], { configurable: true, writable: true,
        value() { throw new Error("business hook reached Guard") } })
    }
    let passed = false
    let failure
    try {
      syncBuiltinESMExports()
      let writes = 0
      let callback
      const bus = new RuntimeBus({ generation: 3, pid: 123, controlKey: key,
        connected: () => true, offer() {}, fail() { throw new Error("transport failed") },
        write(frame, done) {
          if (!verify(frame)) throw new Error("authentication failed")
          writes++
          callback = done
        },
      })
      bus.command({ type: "restart-request" })
      bus.command({ type: "restart-request" })
      callback(null)
      bus.notify({ type: "worker-online" })
      passed = writes === 2
    } catch (error) { failure = error }
    finally {
      for (let i = 0; i < changes.length; i++) {
        const row = changes[i]
        if (row[2]) define(row[0], row[1], row[2])
        else delete row[0][row[1]]
      }
      delete Hmac.prototype[handleKey]
      syncBuiltinESMExports()
    }
    if (!passed) throw failure || new Error("control delivery failed")
    if (leaked) throw new Error("HMAC handle crossed the protected boundary")
    if (crypto.createHmac("sha256", "key").update("data").digest("hex") !==
      "5031fe3d989c6d1537a013fa6e739da23463fdaec3b70137d828e36ace221bd0")
      throw new Error("ordinary business HMAC changed")
  `
  const result = spawnSync(process.execPath, ["--input-type=module", "-e", source], {
    encoding: "utf8",
    timeout: 10000,
  })
  assert.equal(result.status, 0, result.stderr || result.error?.message)
})
