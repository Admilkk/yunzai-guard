import assert from "node:assert/strict"
import test from "node:test"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { isOrdinaryFile, readJsonFile, writeJsonFile } from "../dist/shared/files.js"

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "guard-json-"))

test("原子写入：自动建目录，不留临时文件，可读回", () => {
  const file = path.join(tmp(), "nested", "state.json")
  writeJsonFile(file, { a: 1 })
  writeJsonFile(file, { a: 2 }, { pretty: true })
  assert.deepEqual(readJsonFile(file), { a: 2 })
  assert.equal(fs.readFileSync(file, "utf8"), '{\n  "a": 2\n}\n')
  assert.deepEqual(fs.readdirSync(path.dirname(file)), ["state.json"])
})

test("写入失败时保留原文件并清理临时文件", () => {
  const file = path.join(tmp(), "state.json")
  writeJsonFile(file, { ok: true })
  const cyclic = {}
  cyclic.self = cyclic
  assert.throws(() => writeJsonFile(file, cyclic))
  assert.deepEqual(readJsonFile(file), { ok: true })
  assert.deepEqual(fs.readdirSync(path.dirname(file)), ["state.json"])
})

test("读取：不存在返回 undefined，损坏或超限时抛出", () => {
  const directory = tmp()
  assert.equal(readJsonFile(path.join(directory, "missing.json")), undefined)
  const broken = path.join(directory, "broken.json")
  fs.writeFileSync(broken, '{"half":')
  assert.throws(() => readJsonFile(broken), SyntaxError)
  const large = path.join(directory, "large.json")
  fs.writeFileSync(large, JSON.stringify({ text: "x".repeat(100) }))
  assert.throws(() => readJsonFile(large, 50), /JSON 文件超过大小上限/)
})

test("普通文件判断拒绝目录、符号链接、硬链接与超限文件", t => {
  const directory = tmp()
  const file = path.join(directory, "a.txt")
  fs.writeFileSync(file, "12345")
  assert.equal(isOrdinaryFile(fs.lstatSync(file)), true)
  assert.equal(isOrdinaryFile(fs.lstatSync(file), 4), false)
  assert.equal(isOrdinaryFile(fs.lstatSync(directory)), false)
  fs.linkSync(file, path.join(directory, "b.txt"))
  assert.equal(isOrdinaryFile(fs.lstatSync(file)), false)
  try {
    fs.symlinkSync(file, path.join(directory, "c.txt"))
  } catch {
    return t.skip("当前环境无法创建符号链接")
  }
  assert.equal(isOrdinaryFile(fs.lstatSync(path.join(directory, "c.txt"))), false)
})
