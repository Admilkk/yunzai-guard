import assert from "node:assert/strict"
import test from "node:test"
import { randomUUID } from "node:crypto"
import { NativeMediaHost } from "../dist/native-sandbox/media-host.js"
import { NativeMediaGuest } from "../dist/native-sandbox/media-guest.js"
import { NativeMediaSourceHost } from "../dist/native-sandbox/media-source-host.js"
import { NativeMediaSourceGuest } from "../dist/native-sandbox/media-source-guest.js"
import { nativeMediaLimits as limits } from "../dist/native-sandbox/media-protocol.js"

const png = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a3ioAAAAASUVORK5CYII=",
  "base64",
)
const imageArgs = (bytes = png) => [
  ["before", { type: "image", file: bytes }, { type: "text", text: "after" }],
]
const firstTag = dto => dto[0][1].file

function fixture(t, ids = ["adapter-a", "adapter-b"]) {
  const active = new Set(ids)
  let now = 0
  const host = new NativeMediaSourceHost({ isActiveRequest: id => active.has(id), now: () => now })
  t.after(() => host.close())
  const reads = []
  const guest = new NativeMediaSourceGuest(
    async (service, method, args, requestId) => {
      assert.equal(service, "media-source")
      reads.push({ args, requestId, time: now })
      const result = host.receive(requestId, method, args)
      assert.ok(
        Buffer.byteLength(
          JSON.stringify({ type: "native-service-result", id: "100", ok: true, value: result }),
        ) < limits.frameBytes,
      )
      return result
    },
    {
      now: () => now,
      sleep: async ms => {
        now += ms
      },
    },
  )
  return {
    host,
    guest,
    reads,
    active,
    setTime: value => {
      now = value
    },
    get time() {
      return now
    },
  }
}

test("existing host Buffers become request-bound source tags and restore before an original SDK call", async t => {
  const probe = fixture(t)
  const dto = probe.host.serializeArgs(imageArgs())
  assert.equal(firstTag(dto).$type, "NativeImageSource")
  assert.equal(JSON.stringify(dto).includes('"type":"Buffer"'), false)
  probe.host.bindRequest("adapter-a", dto)
  const args = await probe.guest.restoreArgs("adapter-a", dto)
  let sdkCalled = false
  const original = async message => {
    sdkCalled = true
    assert.equal(message[0], "before")
    assert.deepEqual(message[1].file, png)
    assert.ok(Buffer.isBuffer(message[1].file))
    assert.equal(message[2].text, "after")
    return "sdk-result"
  }
  try {
    assert.equal(await original(...args), "sdk-result")
  } finally {
    probe.host.releaseRequest("adapter-a")
  }
  assert.equal(sdkCalled, true)
  assert.deepEqual(probe.host.stats, { sources: 0, bytes: 0, requests: 0 })
})

test("both media directions preserve original image/text arguments and independent send accounting", async t => {
  const forward = new NativeMediaHost({ isActiveRequest: id => id === "business" })
  t.after(() => forward.close())
  const business = new NativeMediaGuest(async (_service, method, args, id) =>
    forward.receive(id, method, args),
  )
  const probe = fixture(t)
  const message = ["text", { type: "image", file: png }]
  const incoming = await business.prepareReply("business", [message])
  const outgoing = forward.consumeReply("business", incoming)
  const dto = probe.host.serializeArgs([outgoing[0]])
  probe.host.bindRequest("adapter-a", dto)
  const restored = await probe.guest.restoreArgs("adapter-a", dto)
  assert.equal(restored[0][0], "text")
  assert.deepEqual(restored[0][1].file, png)
  assert.equal(forward.stats.bytes, png.length)
  assert.equal(probe.host.stats.bytes, png.length)
  forward.releaseRequest("business")
  assert.equal(forward.stats.bytes, png.length, "ongoing SDK send lease remains retained")
  probe.host.releaseRequest("adapter-a")
  forward.releaseReply(outgoing)
  assert.equal(probe.host.stats.bytes, 0)
  assert.equal(forward.stats.bytes, 0)
})

test("maximum two-leg media transfer stays bounded and keeps both SDK send budgets charged", async t => {
  let now = 0
  const clock = {
    now: () => now,
    sleep: async ms => {
      now += ms
    },
  }
  const forward = new NativeMediaHost({ isActiveRequest: id => id === "business", now: clock.now })
  const reverse = new NativeMediaSourceHost({
    isActiveRequest: id => id === "adapter",
    now: clock.now,
  })
  t.after(() => {
    forward.close()
    reverse.close()
  })
  const business = new NativeMediaGuest(
    async (_service, method, args, id) => forward.receive(id, method, args),
    clock,
  )
  const adapter = new NativeMediaSourceGuest(
    async (_service, method, args, id) => reverse.receive(id, method, args),
    clock,
  )
  const bytes = Buffer.alloc(limits.imageBytes)
  png.copy(bytes)
  const incoming = await business.prepareReply("business", [
    [
      { type: "image", file: bytes },
      { type: "image", file: bytes },
    ],
  ])
  const outgoing = forward.consumeReply("business", incoming)
  const dto = reverse.serializeArgs([outgoing[0]])
  reverse.bindRequest("adapter", dto)
  const restored = await adapter.restoreArgs("adapter", dto)
  assert.ok(
    now > 60000 && now < 90000,
    "a fixed 60-second business deadline cannot cover both maximum legs",
  )
  assert.deepEqual(
    restored[0].map(segment => segment.file),
    [bytes, bytes],
  )
  assert.equal(forward.stats.bytes, limits.sessionBytes)
  assert.equal(reverse.stats.bytes, limits.sessionBytes)
  forward.releaseRequest("business")
  assert.equal(forward.stats.bytes, limits.sessionBytes)
  now += limits.lifetimeMs
  reverse.sweep()
  assert.equal(
    reverse.stats.bytes,
    limits.sessionBytes,
    "completed SDK inputs remain charged despite their read deadline",
  )
  reverse.releaseRequest("adapter")
  forward.releaseReply(outgoing)
  assert.equal(forward.stats.bytes, 0)
  assert.equal(reverse.stats.bytes, 0)
})

test("serialize preparation is atomic and rejects Buffer or functions outside image.file", t => {
  const probe = fixture(t)
  let invoked = false
  const cycle = {}
  cycle.self = cycle
  const getter = {
    get unsafe() {
      invoked = true
      return "bad"
    },
  }
  for (const extra of [
    png,
    { value: png },
    () => {},
    getter,
    cycle,
    new Date(),
    "x".repeat(65536),
  ]) {
    assert.throws(() => probe.host.serializeArgs([...imageArgs(), extra]))
    assert.deepEqual(probe.host.stats, { sources: 0, bytes: 0, requests: 0 })
  }
  assert.equal(invoked, false)
  assert.throws(() => probe.host.serializeArgs([{ type: "record", file: png }]), {
    code: "MEDIA_SOURCE_DTO",
  })
})

test("source DTO traversal bounds cumulative text and keys before JSON allocation or buffer retention", t => {
  const probe = fixture(t)
  for (const value of [
    "x".repeat(limits.frameBytes + 1),
    ["x".repeat(40000), "y".repeat(40000)],
    { ["k".repeat(limits.frameBytes)]: true },
    "图".repeat(Math.ceil(limits.frameBytes / 3)),
  ]) {
    assert.throws(() => probe.host.serializeArgs([...imageArgs(), value]), {
      code: "MEDIA_SOURCE_DTO",
    })
    assert.deepEqual(probe.host.stats, { sources: 0, bytes: 0, requests: 0 })
  }
  const boundary = "x".repeat(limits.frameBytes - 4)
  assert.equal(probe.host.serializeArgs([boundary])[0], boundary)
  // 控制字符仍须通过最终 JSON 转义和帧边界检查。
  assert.throws(() => probe.host.serializeArgs(["\u0000".repeat(limits.frameBytes / 2)]), {
    code: "ADAPTER_FRAME_LIMIT",
  })
})

test("ordinary JSON and URL/path strings stay data; source components never read or fetch them", async t => {
  const probe = fixture(t)
  const args = [
    [
      { type: "image", file: "file:///host/private.png" },
      { type: "image", file: "https://private.invalid/photo" },
    ],
    false,
    { business: "value" },
  ]
  const dto = probe.host.serializeArgs(args)
  probe.host.bindRequest("adapter-a", dto)
  const restored = await probe.guest.restoreArgs("adapter-a", dto)
  assert.deepEqual(JSON.parse(JSON.stringify(restored)), args)
  assert.equal(probe.reads.length, 0)
  assert.equal(probe.host.stats.bytes, 0)
})

test("foreign tags and misplaced tags are rejected before binding or reading", async t => {
  const probe = fixture(t)
  const dto = probe.host.serializeArgs(imageArgs())
  const tag = firstTag(dto)
  assert.throws(() => probe.host.serializeArgs([{ type: "image", file: tag }]), {
    code: "MEDIA_SOURCE_LOCATION",
  })
  assert.throws(() => probe.host.bindRequest("adapter-a", [tag]), { code: "MEDIA_SOURCE_LOCATION" })
  await assert.rejects(probe.guest.restoreArgs("adapter-a", [tag]), {
    code: "MEDIA_SOURCE_LOCATION",
  })
  assert.equal(probe.reads.length, 0)
})

test("source tokens cannot cross sessions or requests, bind twice, or be read before binding", t => {
  const one = fixture(t),
    two = fixture(t)
  const dto = one.host.serializeArgs(imageArgs()),
    tag = firstTag(dto)
  const read = [{ handle: tag.handle, offset: 0 }]
  assert.throws(() => one.host.receive("adapter-a", "read", read), { code: "MEDIA_SOURCE_HANDLE" })
  assert.throws(() => two.host.bindRequest("adapter-a", dto), { code: "MEDIA_SOURCE_HANDLE" })
  one.host.bindRequest("adapter-a", dto)
  assert.throws(() => one.host.bindRequest("adapter-a", dto), { code: "MEDIA_SOURCE_REPLAY" })
  assert.throws(() => one.host.bindRequest("adapter-b", dto), { code: "MEDIA_SOURCE_HANDLE" })
  assert.throws(() => one.host.receive("adapter-b", "read", read), { code: "MEDIA_SOURCE_HANDLE" })
  assert.throws(() => two.host.receive("adapter-a", "read", read), { code: "MEDIA_SOURCE_HANDLE" })
  one.host.discardArgs(dto)
  assert.equal(one.host.stats.bytes, png.length, "discard cannot revoke a bound request")
  assert.equal(one.host.receive("adapter-a", "read", read).done, true)
  assert.throws(() => one.host.receive("adapter-a", "read", read), { code: "MEDIA_SOURCE_REPLAY" })
})

test("binding validates all tags atomically and guest rejects duplicate sources before RPC", async t => {
  const probe = fixture(t)
  const dto = probe.host.serializeArgs(imageArgs())
  const tag = firstTag(dto)
  const forged = { ...tag, handle: `source-${randomUUID()}` }
  assert.throws(
    () =>
      probe.host.bindRequest("adapter-a", [
        [
          { type: "image", file: tag },
          { type: "image", file: forged },
        ],
      ]),
    { code: "MEDIA_SOURCE_HANDLE" },
  )
  assert.equal(probe.host.stats.requests, 0)
  const duplicate = [
    [
      { type: "image", file: tag },
      { type: "image", file: tag },
    ],
  ]
  assert.throws(() => probe.host.bindRequest("adapter-a", duplicate), {
    code: "MEDIA_SOURCE_REPLAY",
  })
  await assert.rejects(probe.guest.restoreArgs("adapter-a", duplicate), {
    code: "MEDIA_SOURCE_REPLAY",
  })
  assert.equal(probe.reads.length, 0)
  probe.host.bindRequest("adapter-a", dto)
  assert.deepEqual((await probe.guest.restoreArgs("adapter-a", dto))[0][1].file, png)
  await assert.rejects(probe.guest.restoreArgs("adapter-a", dto), { code: "MEDIA_SOURCE_REPLAY" })
})

test("source reads are contiguous 32 KiB chunks and concurrent calls share the pacing queue", async t => {
  const probe = fixture(t)
  const bytes = Buffer.alloc(limits.chunkBytes * 3)
  png.copy(bytes)
  const first = probe.host.serializeArgs(imageArgs(bytes)),
    second = probe.host.serializeArgs(imageArgs(bytes))
  probe.host.bindRequest("adapter-a", first)
  probe.host.bindRequest("adapter-b", second)
  const restored = await Promise.all([
    probe.guest.restoreArgs("adapter-a", first),
    probe.guest.restoreArgs("adapter-b", second),
  ])
  assert.equal(probe.reads.length, 6)
  for (let index = 1; index < probe.reads.length; index++)
    assert.ok(
      probe.reads[index].time - probe.reads[index - 1].time >=
        (limits.chunkBytes * 1000) / limits.bytesPerSecond,
    )
  for (const args of restored) assert.deepEqual(args[0][1].file, bytes)
  assert.equal(
    probe.host.stats.bytes,
    bytes.length * 2,
    "completed reads remain charged until SDK request ends",
  )
})

test("unbound expiry and bound read expiry are fixed, while completed sends retain their buffers", async t => {
  const probe = fixture(t)
  const expired = probe.host.serializeArgs(imageArgs())
  probe.setTime(limits.lifetimeMs)
  assert.throws(() => probe.host.bindRequest("adapter-a", expired), { code: "MEDIA_SOURCE_HANDLE" })
  assert.equal(probe.host.stats.bytes, 0)
  const source = probe.host.serializeArgs(imageArgs())
  probe.host.bindRequest("adapter-a", source)
  probe.setTime(2 * limits.lifetimeMs)
  await assert.rejects(probe.guest.restoreArgs("adapter-a", source), {
    code: "MEDIA_SOURCE_HANDLE",
  })
  probe.host.releaseRequest("adapter-a")
  const complete = probe.host.serializeArgs(imageArgs())
  probe.host.bindRequest("adapter-b", complete)
  await probe.guest.restoreArgs("adapter-b", complete)
  probe.setTime(4 * limits.lifetimeMs)
  probe.host.sweep()
  assert.equal(probe.host.stats.bytes, png.length)
  probe.host.releaseRequest("adapter-b")
  assert.equal(probe.host.stats.bytes, 0)
})

test("retained Buffer is not copied and mutation is detected by the guest digest check", async t => {
  const probe = fixture(t)
  const bytes = Buffer.from(png)
  const dto = probe.host.serializeArgs(imageArgs(bytes))
  bytes[bytes.length - 1] ^= 1
  probe.host.bindRequest("adapter-a", dto)
  await assert.rejects(probe.guest.restoreArgs("adapter-a", dto), { code: "MEDIA_DIGEST_MISMATCH" })
  assert.equal(probe.host.stats.bytes, png.length)
  probe.host.releaseRequest("adapter-a")
  assert.equal(probe.host.stats.bytes, 0)
})

test("source budgets reject oversize and failed calls without partial retention", t => {
  const probe = fixture(t)
  const tooLarge = Buffer.alloc(limits.imageBytes + 1)
  png.copy(tooLarge)
  assert.throws(() => probe.host.serializeArgs(imageArgs(tooLarge)), { code: "MEDIA_SIZE_LIMIT" })
  assert.throws(
    () =>
      probe.host.serializeArgs([Array.from({ length: 5 }, () => ({ type: "image", file: png }))]),
    { code: "MEDIA_REQUEST_LIMIT" },
  )
  assert.equal(probe.host.stats.bytes, 0)
  const max = Buffer.alloc(limits.imageBytes)
  png.copy(max)
  const first = probe.host.serializeArgs(imageArgs(max)),
    second = probe.host.serializeArgs(imageArgs(max))
  assert.equal(probe.host.stats.bytes, limits.sessionBytes)
  assert.throws(() => probe.host.serializeArgs(imageArgs()), { code: "MEDIA_SESSION_LIMIT" })
  probe.host.discardArgs(first)
  assert.equal(probe.host.stats.bytes, limits.imageBytes)
  probe.host.discardArgs(second)
  assert.equal(probe.host.stats.bytes, 0)
})

test("malformed read responses and expired guest deadlines never reach an SDK", async t => {
  const probe = fixture(t)
  const dto = probe.host.serializeArgs(imageArgs()),
    source = firstTag(dto)
  for (const result of [
    { offset: 1, data: png.toString("base64"), done: true },
    { offset: 0, data: png.subarray(0, 3).toString("base64"), done: true },
    { offset: 0, data: png.toString("base64"), done: false },
    { offset: 0, data: Buffer.alloc(limits.chunkBytes + 1).toString("base64"), done: true },
  ]) {
    const guest = new NativeMediaSourceGuest(async () => result)
    await assert.rejects(guest.restoreArgs("adapter-a", dto))
  }
  const mismatch = new NativeMediaSourceGuest(async () => ({
    offset: 0,
    data: png.toString("base64"),
    done: true,
  }))
  await assert.rejects(
    mismatch.restoreArgs("adapter-a", [
      [{ type: "image", file: { ...source, mime: "image/jpeg" } }],
    ]),
    { code: "MEDIA_TYPE_MISMATCH" },
  )
  let now = 0
  const expired = new NativeMediaSourceGuest(
    async () => {
      now = limits.lifetimeMs
      return { offset: 0, data: png.toString("base64"), done: true }
    },
    { now: () => now },
  )
  await assert.rejects(expired.restoreArgs("adapter-a", dto), { code: "MEDIA_SOURCE_CHUNK" })
})

test("missing pending requests, cancellation and session close revoke source reads", t => {
  const probe = fixture(t)
  const dto = probe.host.serializeArgs(imageArgs()),
    handle = firstTag(dto).handle
  probe.active.delete("adapter-a")
  assert.throws(() => probe.host.bindRequest("adapter-a", dto), { code: "MEDIA_SOURCE_REQUEST" })
  probe.host.bindRequest("adapter-b", dto)
  probe.active.delete("adapter-b")
  assert.throws(() => probe.host.receive("adapter-b", "read", [{ handle, offset: 0 }]), {
    code: "MEDIA_SOURCE_REQUEST",
  })
  assert.equal(probe.host.stats.bytes, 0)
  probe.host.serializeArgs(imageArgs())
  probe.host.close()
  assert.deepEqual(probe.host.stats, { sources: 0, bytes: 0, requests: 0 })
  assert.throws(() => probe.host.serializeArgs(imageArgs()), { code: "MEDIA_SOURCE_CLOSED" })
})

test("host rate limit remains authoritative if a guest bypasses its pacing helper", t => {
  const probe = fixture(t)
  const bytes = Buffer.alloc(limits.chunkBytes * 6)
  png.copy(bytes)
  const dto = probe.host.serializeArgs(imageArgs(bytes)),
    handle = firstTag(dto).handle
  probe.host.bindRequest("adapter-a", dto)
  for (let index = 0; index < 4; index++)
    probe.host.receive("adapter-a", "read", [{ handle, offset: index * limits.chunkBytes }])
  const next = [{ handle, offset: 4 * limits.chunkBytes }]
  assert.throws(() => probe.host.receive("adapter-a", "read", next), { code: "MEDIA_SOURCE_RATE" })
  probe.setTime(63)
  assert.equal(probe.host.receive("adapter-a", "read", next).offset, 4 * limits.chunkBytes)
})
