import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { registerHooks } from "node:module"
import { pathToFileURL } from "node:url"
import test from "node:test"
import vm from "node:vm"
import { decodeModuleSource } from "../dist/monitor/source.js"

const source = 'export const value = 42; export const text = "原始字节";\n'
const originalBytes = Buffer.from(source)
const bytes = Buffer.concat([
  originalBytes,
  Buffer.alloc((8 - (originalBytes.length % 8)) % 8, 0x20),
])
const backing = new ArrayBuffer(bytes.length + 16)
new Uint8Array(backing, 8, bytes.length).set(bytes)
const cases = [
  ["string", source],
  ["Buffer offset", Buffer.from(backing, 8, bytes.length)],
  ["Uint8Array offset", new Uint8Array(backing, 8, bytes.length)],
  ["Uint16Array offset", new Uint16Array(backing, 8, bytes.length / 2)],
  ["Uint32Array offset", new Uint32Array(backing, 8, bytes.length / 4)],
  ["DataView offset", new DataView(backing, 8, bytes.length)],
  ["ArrayBuffer", backing.slice(8, 8 + bytes.length)],
  ["other realm ArrayBuffer", vm.runInNewContext("new ArrayBuffer(8)")],
]

test("module source decoding preserves exact bytes for Node source views and never coerces unknown values", () => {
  for (const [name, input] of cases.slice(0, -1))
    assert.equal(
      decodeModuleSource(input),
      name === "string" ? source : bytes.toString("utf8"),
      name,
    )
  assert.equal(decodeModuleSource(cases.at(-1)[1]), "\0".repeat(8))
  let coercions = 0
  for (const input of [
    undefined,
    null,
    1,
    {
      toString() {
        coercions++
        return source
      },
    },
  ])
    assert.equal(decodeModuleSource(input), undefined)
  assert.equal(coercions, 0)
})

test("Node imports legal typed load-hook sources with their values unchanged after Guard decoding", async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "guard-module-source-"))
  const file = path.join(directory, "module.mjs")
  fs.writeFileSync(file, "must be supplied by the load hook")
  const url = pathToFileURL(file).href
  for (const [index, [name, input]] of cases.slice(0, -1).entries()) {
    const target = `${url}?case=${index}`
    const original = registerHooks({
      load(actual, context, next) {
        return actual === target
          ? { format: "module", source: input, shortCircuit: true }
          : next(actual, context)
      },
    })
    const guard = registerHooks({
      load(actual, context, next) {
        const result = next(actual, context)
        return actual === target ? { ...result, source: decodeModuleSource(result.source) } : result
      },
    })
    try {
      const loaded = await import(target)
      assert.equal(loaded.value, 42, name)
      assert.equal(loaded.text, "原始字节", name)
    } finally {
      guard.deregister()
      original.deregister()
    }
  }
})
