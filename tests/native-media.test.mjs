import assert from "node:assert/strict"
import test from "node:test"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import http from "node:http"
import { createHash, randomUUID } from "node:crypto"
import { pathToFileURL } from "node:url"
import { NativeMediaHost } from "../dist/native-sandbox/media/host.js"
import { NativeMediaGuest } from "../dist/native-sandbox/media/guest.js"
import {
  imageMime,
  nativeMediaLimits as limits,
  parseMediaReply,
} from "../dist/native-sandbox/media/protocol.js"
import { installInstrumentation } from "../dist/instrumentation/index.js"
import { parseSettings } from "../dist/config/index.js"

const png = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a3ioAAAAASUVORK5CYII=",
  "base64",
)
const sha256 = bytes => createHash("sha256").update(bytes).digest("hex")
const tag = () => ({ $type: "NativeImage", handle: `image-${randomUUID()}` })

function fixture(t, ids = ["request-a", "request-b"]) {
  const active = new Set(ids)
  let now = 0
  const host = new NativeMediaHost({ isActiveRequest: id => active.has(id), now: () => now })
  t.after(() => host.close())
  const calls = []
  const guest = new NativeMediaGuest(
    async (service, method, args, requestId) => {
      assert.equal(service, "media")
      calls.push({ method, args: structuredClone(args), requestId, time: now })
      assert.ok(
        Buffer.byteLength(
          JSON.stringify({ type: "native-service", service, method, args, requestId }),
        ) <= limits.frameBytes,
      )
      return host.receive(requestId, method, args)
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
    calls,
    active,
    setTime: value => {
      now = value
    },
    get time() {
      return now
    },
  }
}

function open(host, requestId, bytes = png, changes = {}) {
  return host.receive(requestId, "open", [
    { size: bytes.length, mime: imageMime(bytes), sha256: sha256(bytes), ...changes },
  ]).handle
}
function upload(host, requestId, bytes = png, changes = {}) {
  const handle = open(host, requestId, bytes, changes)
  for (let offset = 0; offset < bytes.length; offset += limits.chunkBytes)
    host.receive(requestId, "chunk", [
      {
        handle,
        offset,
        data: bytes.subarray(offset, offset + limits.chunkBytes).toString("base64"),
      },
    ])
  return host.receive(requestId, "finish", [{ handle }])
}

test("original text/image arrays accept Buffer, base64 and guest-local file sources without forwarding paths", async t => {
  const probe = fixture(t)
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "guard-media-"))
  t.after(() => {
    assert.equal(path.dirname(fs.realpathSync(directory)), fs.realpathSync(os.tmpdir()))
    fs.rmSync(directory, { recursive: true, force: true })
  })
  const filename = path.join(directory, "private-image.png")
  fs.writeFileSync(filename, png)
  const sources = [
    Buffer.from(png),
    `base64://${png.toString("base64")}`,
    filename,
    pathToFileURL(filename),
  ]
  const original = [
    "before",
    ...sources.map(file => ({ type: "image", file, name: undefined })),
    { type: "text", text: "after" },
  ]
  const prepared = await probe.guest.prepareReply("request-a", [original, true, {}])
  assert.equal(probe.host.stats.images, 4)
  assert.equal(JSON.stringify(probe.calls).includes("private-image.png"), false)
  assert.equal(JSON.stringify(probe.calls).includes("file:///"), false)
  sources[0].fill(0)
  const outgoing = probe.host.consumeReply("request-a", prepared)
  const [message, quote, options] = outgoing
  assert.equal(quote, true)
  assert.deepEqual(options, {})
  assert.equal(message[0], "before")
  assert.deepEqual(message[5], { type: "text", text: "after" })
  for (const value of message.slice(1, 5)) {
    assert.deepEqual(Object.keys(value), ["type", "file"])
    assert.equal(value.type, "image")
    assert.ok(Buffer.isBuffer(value.file))
    assert.deepEqual(value.file, png)
  }
  assert.equal(probe.host.stats.bytes, png.length * 4)
  probe.host.releaseReply(outgoing)
  assert.equal(probe.host.stats.bytes, 0)
  assert.throws(() => probe.host.consumeReply("request-a", prepared), {
    code: "MEDIA_UNKNOWN_HANDLE",
  })
})

test("host refuses direct paths, URLs, Buffer JSON, media options and unsupported segments", t => {
  const { host } = fixture(t)
  for (const file of [
    "C:/private/secret.png",
    "file:///etc/passwd",
    "https://example.invalid/image.png",
    png,
    { type: "Buffer", data: [...png] },
    `base64://${png.toString("base64")}`,
  ])
    assert.throws(() => host.consumeReply("request-a", [{ type: "image", file }]))
  for (const type of ["file", "video", "record", "forward", "raw", "node"])
    assert.throws(() => host.consumeReply("request-a", [{ type, file: "forbidden" }]))
  assert.throws(() => host.consumeReply("request-a", ["text", true, { file: "forbidden" }]))
  assert.deepEqual(host.consumeReply("request-a", ["ordinary https://text.invalid is text"]), [
    "ordinary https://text.invalid is text",
    false,
    {},
  ])
})

test("media capabilities cannot cross requests, sessions or survive capability revocation", t => {
  const one = fixture(t),
    two = fixture(t)
  const handle = open(one.host, "request-a")
  const chunk = [{ handle, offset: 0, data: png.toString("base64") }]
  assert.throws(() => one.host.receive("request-b", "chunk", chunk), {
    code: "MEDIA_UNKNOWN_HANDLE",
  })
  assert.throws(() => two.host.receive("request-a", "chunk", chunk), {
    code: "MEDIA_UNKNOWN_HANDLE",
  })
  assert.throws(() => one.host.receive("request-b", "abort", [{ handle }]), {
    code: "MEDIA_UNKNOWN_HANDLE",
  })
  one.host.receive("request-a", "chunk", chunk)
  const image = one.host.receive("request-a", "finish", [{ handle }])
  assert.throws(() => one.host.receive("request-a", "finish", [{ handle }]), {
    code: "MEDIA_UNKNOWN_HANDLE",
  })
  assert.throws(() => one.host.consumeReply("request-b", [image]), { code: "MEDIA_UNKNOWN_HANDLE" })
  assert.throws(() => two.host.consumeReply("request-a", [image]), { code: "MEDIA_UNKNOWN_HANDLE" })
  one.active.delete("request-a")
  assert.throws(() => one.host.consumeReply("request-a", [image]), {
    code: "MEDIA_EXPIRED_REQUEST",
  })
  assert.deepEqual(one.host.stats, { bytes: 0, images: 0, requests: 0 })
})

test("whole-reply validation and single-use consumption are atomic", t => {
  const { host } = fixture(t)
  const image = upload(host, "request-a")
  assert.throws(() => host.consumeReply("request-a", [[image, image]]), { code: "MEDIA_REPLAY" })
  assert.throws(() => host.consumeReply("request-a", [[image, tag()]]), {
    code: "MEDIA_UNKNOWN_HANDLE",
  })
  assert.equal(host.stats.images, 1)
  assert.deepEqual(host.consumeReply("request-a", [image])[0].file, png)
  assert.equal(host.stats.images, 0)
  assert.throws(() => host.consumeReply("request-a", [image]), { code: "MEDIA_UNKNOWN_HANDLE" })
})

test("chunks are ordered, bounded, canonical and checked against exact digest and signature", t => {
  const { host } = fixture(
    t,
    Array.from({ length: 8 }, (_, index) => `request-${index}`),
  )
  const invalid = [
    { offset: 1, data: png.toString("base64") },
    { offset: 0, data: Buffer.alloc(limits.chunkBytes + 1).toString("base64") },
    { offset: 0, data: "AA==garbage" },
    { offset: 0, data: "AB==" },
  ]
  for (let index = 0; index < invalid.length; index++) {
    const id = `request-${index}`,
      handle = open(host, id)
    assert.throws(() => host.receive(id, "chunk", [{ handle, ...invalid[index] }]))
    assert.equal(host.stats.bytes, 0)
  }
  const incomplete = open(host, "request-4")
  assert.throws(() => host.receive("request-4", "finish", [{ handle: incomplete }]), {
    code: "MEDIA_INCOMPLETE",
  })
  assert.throws(() => upload(host, "request-5", png, { sha256: "0".repeat(64) }), {
    code: "MEDIA_DIGEST_MISMATCH",
  })
  assert.throws(() => upload(host, "request-6", png, { mime: "image/jpeg" }), {
    code: "MEDIA_TYPE_MISMATCH",
  })
  const html = Buffer.from("<svg onload='not-an-image'></svg>")
  const bad = host.receive("request-7", "open", [
    { size: html.length, mime: "image/png", sha256: sha256(html) },
  ]).handle
  host.receive("request-7", "chunk", [{ handle: bad, offset: 0, data: html.toString("base64") }])
  assert.throws(() => host.receive("request-7", "finish", [{ handle: bad }]), {
    code: "MEDIA_UNSUPPORTED_TYPE",
  })
  assert.equal(host.stats.bytes, 0)
})

test("session and cumulative request budgets cannot be reset by consume or abort", t => {
  const { host } = fixture(t, ["a", "b", "c", "count"])
  const descriptor = { size: limits.imageBytes, mime: "image/png", sha256: "0".repeat(64) }
  const first = host.receive("a", "open", [descriptor]).handle
  const second = host.receive("b", "open", [descriptor]).handle
  assert.equal(host.stats.bytes, limits.sessionBytes)
  assert.throws(() => host.receive("c", "open", [{ ...descriptor, size: 1 }]), {
    code: "MEDIA_SESSION_LIMIT",
  })
  host.receive("a", "abort", [{ handle: first }])
  host.receive("b", "abort", [{ handle: second }])
  const another = host.receive("a", "open", [descriptor]).handle
  host.receive("a", "abort", [{ handle: another }])
  assert.throws(() => host.receive("a", "open", [{ ...descriptor, size: 1 }]), {
    code: "MEDIA_REQUEST_LIMIT",
  })
  for (let index = 0; index < 4; index++) {
    const reply = host.consumeReply("count", [upload(host, "count")])
    host.releaseReply(reply)
  }
  assert.throws(() => open(host, "count"), { code: "MEDIA_REQUEST_LIMIT" })
  assert.throws(() => host.receive("c", "open", [{ ...descriptor, size: limits.imageBytes + 1 }]), {
    code: "MEDIA_SIZE_LIMIT",
  })
  assert.equal(host.stats.bytes, 0)
})

test("45-second request deadline does not renew and expiry releases all retained bytes", t => {
  const probe = fixture(t)
  const first = upload(probe.host, "request-a")
  probe.setTime(40000)
  const second = upload(probe.host, "request-a")
  probe.setTime(limits.lifetimeMs)
  probe.host.sweep()
  assert.equal(probe.host.stats.bytes, 0)
  for (const image of [first, second])
    assert.throws(() => probe.host.consumeReply("request-a", [image]), {
      code: "MEDIA_UNKNOWN_HANDLE",
    })
  assert.throws(() => open(probe.host, "request-a"), { code: "MEDIA_EXPIRED" })
  probe.active.delete("request-a")
  probe.host.releaseRequest("request-a")
  assert.deepEqual(probe.host.stats, { images: 0, bytes: 0, requests: 0 })
})

test("concurrent guest replies share the 512 KiB/s upload queue and each frame stays bounded", async t => {
  const probe = fixture(t)
  // 头部校验不解码图片；填充内容只用于传输夹具。
  const large = Buffer.alloc(limits.chunkBytes * 3)
  png.copy(large)
  const replies = await Promise.all(
    ["request-a", "request-b"].map(id =>
      probe.guest.prepareReply(id, [{ type: "image", file: large }]),
    ),
  )
  const chunks = probe.calls.filter(call => call.method === "chunk")
  assert.equal(chunks.length, 6)
  for (let index = 1; index < chunks.length; index++) {
    const size = Buffer.from(chunks[index - 1].args[0].data, "base64").length
    assert.ok(chunks[index].time - chunks[index - 1].time >= (size * 1000) / limits.bytesPerSecond)
  }
  for (let index = 0; index < replies.length; index++)
    assert.deepEqual(
      probe.host.consumeReply(index ? "request-b" : "request-a", replies[index])[0].file,
      large,
    )
})

test("guest preparation failure aborts already-uploaded images and never forwards unsupported media", async t => {
  const probe = fixture(t)
  await assert.rejects(
    probe.guest.prepareReply("request-a", [
      [
        { type: "image", file: png },
        { type: "image", file: Buffer.from("not an image") },
      ],
    ]),
    { code: "MEDIA_UNSUPPORTED_TYPE" },
  )
  assert.equal(probe.host.stats.images, 0)
  assert.ok(probe.calls.some(call => call.method === "abort"))
  const before = probe.calls.length
  await assert.rejects(
    probe.guest.prepareReply("request-b", [
      [
        { type: "image", file: png },
        { type: "forward", data: [] },
      ],
    ]),
  )
  assert.equal(probe.calls.length, before)
  let getterCalls = 0
  const value = {
    type: "image",
    get file() {
      getterCalls++
      return png
    },
  }
  await assert.rejects(probe.guest.prepareReply("request-b", [value]), {
    code: "MEDIA_INVALID_DTO",
  })
  assert.equal(getterCalls, 0)
})

test("URL fetch runs in the guest under network rules and sends no URL or authorization to the host", async t => {
  const probe = fixture(t)
  let requests = 0
  const server = http.createServer((_request, response) => {
    requests++
    response.end(png)
  })
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve))
  t.after(() => new Promise(resolve => server.close(resolve)))
  const url = `http://127.0.0.1:${server.address().port}/image?token=private-source-value`
  const reply = await probe.guest.prepareReply("request-a", [{ type: "image", file: url }])
  assert.deepEqual(probe.host.consumeReply("request-a", reply)[0].file, png)
  assert.equal(requests, 1)
  assert.equal(JSON.stringify(probe.calls).includes("private-source-value"), false)
  const dispose = installInstrumentation(
    parseSettings({ rules: [{ id: "deny-image-network", kind: "network", action: "deny" }] }),
    () => {},
  )
  try {
    await assert.rejects(probe.guest.prepareReply("request-b", [{ type: "image", file: url }]), {
      code: "GUARD_DENIED",
    })
    assert.equal(requests, 1)
  } finally {
    dispose()
  }
})

test("oversized and streamed URL bodies abort before any host upload", async t => {
  const probe = fixture(t)
  const original = globalThis.fetch
  t.after(() => {
    globalThis.fetch = original
  })
  let signal
  globalThis.fetch = async (_url, options) => {
    signal = options.signal
    return new Response(png, { headers: { "content-length": String(limits.imageBytes + 1) } })
  }
  await assert.rejects(
    probe.guest.prepareReply("request-a", [
      { type: "image", file: "https://fixture.invalid/image" },
    ]),
    { code: "MEDIA_SIZE_LIMIT" },
  )
  assert.equal(signal.aborted, true)
  let cancelled = false
  globalThis.fetch = async (_url, options) => {
    signal = options.signal
    return new Response(
      new ReadableStream({
        pull(controller) {
          controller.enqueue(Buffer.alloc(limits.chunkBytes))
        },
        cancel() {
          cancelled = true
        },
      }),
    )
  }
  await assert.rejects(
    probe.guest.prepareReply("request-b", [
      { type: "image", file: "https://fixture.invalid/image" },
    ]),
    { code: "MEDIA_SIZE_LIMIT" },
  )
  assert.equal(signal.aborted, true)
  assert.equal(cancelled, true)
  assert.equal(probe.calls.length, 0)
})

test("request termination and close release all open and finished capabilities", t => {
  const probe = fixture(t)
  open(probe.host, "request-a")
  upload(probe.host, "request-a")
  upload(probe.host, "request-b")
  probe.host.releaseRequest("request-a")
  assert.deepEqual(probe.host.stats, { bytes: png.length, images: 1, requests: 1 })
  probe.host.close()
  assert.deepEqual(probe.host.stats, { bytes: 0, images: 0, requests: 0 })
  assert.throws(() => open(probe.host, "request-b"), { code: "MEDIA_CLOSED" })
  assert.throws(() => probe.host.consumeReply("request-b", ["even plain reply"]), {
    code: "MEDIA_CLOSED",
  })
  assert.throws(() => parseMediaReply([[{ type: "text", text: "x".repeat(32001) }]]), {
    code: "MEDIA_REPLY_LIMIT",
  })
})

test("maximum-size uploads stay within fixed deadline and 64 KiB frames under the shared rate", async t => {
  let now = 0,
    chunkCount = 0
  const host = new NativeMediaHost({ isActiveRequest: id => id === "large", now: () => now })
  t.after(() => host.close())
  const guest = new NativeMediaGuest(
    async (service, method, args, requestId) => {
      assert.ok(
        Buffer.byteLength(
          JSON.stringify({ type: "native-service", service, method, args, requestId }),
        ) < limits.frameBytes,
      )
      if (method === "chunk") chunkCount++
      return host.receive(requestId, method, args)
    },
    {
      now: () => now,
      sleep: async ms => {
        now += ms
      },
    },
  )
  const bytes = Buffer.alloc(limits.imageBytes)
  png.copy(bytes)
  const prepared = await guest.prepareReply("large", [
    [
      { type: "image", file: bytes },
      { type: "image", file: `base64://${bytes.toString("base64")}` },
    ],
  ])
  assert.equal(chunkCount, limits.requestBytes / limits.chunkBytes)
  assert.ok(now >= 31000 && now < limits.lifetimeMs)
  assert.equal(host.stats.bytes, limits.sessionBytes)
  const sent = host.consumeReply("large", prepared)
  assert.deepEqual(sent[0][0].file, bytes)
  assert.deepEqual(sent[0][1].file, bytes)
  assert.equal(host.stats.bytes, limits.sessionBytes)
  host.releaseReply(sent)
  assert.equal(host.stats.bytes, 0)
})

test("slow SDK sends remain charged across request completion and session close until finally", async t => {
  const probe = fixture(t, ["sending", "incoming"])
  const bytes = Buffer.alloc(limits.imageBytes)
  png.copy(bytes)
  const images = [upload(probe.host, "sending", bytes), upload(probe.host, "sending", bytes)]
  const outgoing = probe.host.consumeReply("sending", [images])
  assert.equal(probe.host.stats.images, 0)
  assert.equal(probe.host.stats.bytes, limits.sessionBytes)
  assert.throws(() => open(probe.host, "incoming"), { code: "MEDIA_SESSION_LIMIT" })
  let complete
  const sdk = new Promise(resolve => {
    complete = resolve
  })
  const send = (async () => {
    try {
      await sdk
    } finally {
      probe.host.releaseReply(outgoing)
    }
  })()
  probe.active.delete("sending")
  probe.host.releaseRequest("sending")
  assert.equal(probe.host.stats.bytes, limits.sessionBytes)
  assert.throws(() => open(probe.host, "incoming"), { code: "MEDIA_SESSION_LIMIT" })
  probe.host.releaseReply([...outgoing])
  assert.equal(
    probe.host.stats.bytes,
    limits.sessionBytes,
    "a copied array cannot forge a host send lease",
  )
  probe.host.close()
  assert.equal(probe.host.stats.bytes, limits.sessionBytes)
  assert.throws(() => open(probe.host, "incoming"), { code: "MEDIA_CLOSED" })
  complete()
  await send
  assert.equal(probe.host.stats.bytes, 0)
  probe.host.releaseReply(outgoing)
  assert.equal(probe.host.stats.bytes, 0, "send lease release is idempotent")
})

test("active request revocation during upload aborts without returning a usable reply", async t => {
  let active = true
  const host = new NativeMediaHost({ isActiveRequest: () => active })
  t.after(() => host.close())
  const guest = new NativeMediaGuest(async (_service, method, args, requestId) => {
    if (method === "chunk") active = false
    return host.receive(requestId, method, args)
  })
  await assert.rejects(guest.prepareReply("revoked", [{ type: "image", file: png }]), {
    code: "MEDIA_EXPIRED_REQUEST",
  })
  assert.deepEqual(host.stats, { images: 0, bytes: 0, requests: 0 })
})

test("host limits tracked requests and rejects accessor-based metadata without invocation", t => {
  const host = new NativeMediaHost({ isActiveRequest: () => true })
  t.after(() => host.close())
  const descriptor = { size: 1, mime: "image/png", sha256: "0".repeat(64) }
  let invoked = false
  assert.throws(
    () =>
      host.receive("a", "open", [
        {
          ...descriptor,
          get mime() {
            invoked = true
            return "image/png"
          },
        },
      ]),
    { code: "MEDIA_INVALID_DTO" },
  )
  assert.throws(
    () =>
      host.receive("a", "open", [
        {
          ...descriptor,
          mime: {
            toString() {
              invoked = true
              return "image/png"
            },
          },
        },
      ]),
    { code: "MEDIA_UNSUPPORTED_TYPE" },
  )
  assert.equal(invoked, false)
  for (let index = 0; index < limits.requests; index++)
    host.receive(`id-${index}`, "open", [descriptor])
  assert.throws(() => host.receive("too-many", "open", [descriptor]), {
    code: "MEDIA_REQUEST_LIMIT",
  })
  assert.equal(host.stats.requests, limits.requests)
})
