import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import https from "node:https"
import { EventEmitter } from "node:events"
import test from "node:test"
import { fileURLToPath } from "node:url"
import { hash, verifyFile } from "../dist/dependencies/files.js"
import { windowsBroker } from "../dist/dependencies/windows-broker.js"
import { prepareNode, windowsNode } from "../dist/dependencies/node.js"

const repository = fileURLToPath(new URL("../", import.meta.url))

function directory(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "guard-dependency-"))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  return root
}

function unqualifiedWindows(t, executable) {
  for (const [key, value] of Object.entries({
    platform: "win32",
    arch: "x64",
    execPath: executable,
  })) {
    const original = Object.getOwnPropertyDescriptor(process, key)
    Object.defineProperty(process, key, { ...original, value })
    t.after(() => Object.defineProperty(process, key, original))
  }
}

test("dependency verification rejects changed bytes and hard links", t => {
  const root = directory(t),
    file = path.join(root, "dependency")
  fs.writeFileSync(file, "original")
  const expected = hash(Buffer.from("original"))
  assert.equal(verifyFile(file, expected), file)
  fs.writeFileSync(file, "changed")
  assert.throws(() => verifyFile(file, expected), /依赖 SHA-256 不符：dependency/)
  fs.writeFileSync(file, "original")
  fs.linkSync(file, path.join(root, "alias"))
  assert.throws(() => verifyFile(file, expected), /依赖须为大小受限的单链接普通文件/)
})

test("bundled Windows broker rejects stale source digest and altered executable", t => {
  const realManifest = JSON.parse(
    fs.readFileSync(path.join(repository, "native/windows/manifest.json"), "utf8"),
  )
  assert.equal(windowsBroker(repository, realManifest.sourceDigest).sha256, realManifest.sha256)
  assert.throws(
    () => windowsBroker(repository, "0".repeat(64)),
    /随包 Windows 沙箱辅助程序与源码不符，请重装 Guard/,
  )
  const root = directory(t)
  const bundle = path.join(root, "native/windows")
  fs.mkdirSync(path.join(bundle, "bin/win32-x64"), { recursive: true })
  fs.writeFileSync(path.join(bundle, "manifest.json"), JSON.stringify(realManifest))
  fs.writeFileSync(path.join(bundle, realManifest.file), "altered")
  assert.throws(
    () => windowsBroker(root, realManifest.sourceDigest),
    /依赖 SHA-256 不符：GuardSandbox\.exe/,
  )
})

test("automatic Node preparation rejects corrupt cache before networking", async t => {
  const root = directory(t),
    current = path.join(root, "existing-node")
  fs.writeFileSync(current, "unqualified")
  unqualifiedWindows(t, current)
  const cache = path.join(
    root,
    ".cache/dependencies",
    `node-${windowsNode.version}-win-x64/node.exe`,
  )
  fs.mkdirSync(path.dirname(cache), { recursive: true })
  fs.writeFileSync(cache, "corrupt")
  const network = t.mock.method(https, "get", () => {
    throw new Error("Unexpected network call")
  })
  await assert.rejects(prepareNode(root), /依赖 SHA-256 不符：node\.exe/)
  assert.equal(network.mock.calls.length, 0)
})

test("automatic Node preparation refuses redirects and cleans partial files", async t => {
  const root = directory(t),
    current = path.join(root, "existing-node")
  fs.writeFileSync(current, "unqualified")
  unqualifiedWindows(t, current)
  const network = t.mock.method(https, "get", (url, _options, callback) => {
    assert.equal(url, windowsNode.url)
    queueMicrotask(() => callback({ statusCode: 302, resume() {} }))
    return new EventEmitter()
  })
  await assert.rejects(prepareNode(root), /HTTP 302/)
  assert.equal(network.mock.calls.length, 1)
  assert.deepEqual(
    fs.readdirSync(path.join(root, ".cache/dependencies", `node-${windowsNode.version}-win-x64`)),
    [],
  )
})
