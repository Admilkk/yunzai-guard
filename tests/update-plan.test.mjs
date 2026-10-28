import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import test from "node:test"
import { planUpdate, readManifest, syncFiles } from "../dist/update/plan.js"
import { inWindow, parseWindow } from "../dist/shared/update-window.js"

const hash = character => character.repeat(64)

function manifest(files) {
  return {
    schema: 1,
    version: "1.0.0",
    files: Object.fromEntries(
      Object.entries(files).map(([file, [sha, roles]]) => [file, { sha256: hash(sha), roles }]),
    ),
  }
}

const base = {
  "dist/host/supervisor.js": ["a", ["shell"]],
  "dist/worker-preload.js": ["a", ["worker"]],
  "dist/web/server.js": ["a", ["core"]],
  "dist/web/core-protocol.js": ["a", ["shell", "core"]],
  "dist/shared/messages.js": ["a", ["shell", "worker", "core"]],
  "dist/panel/index.html": ["a", ["static"]],
  "package.json": ["a", ["meta"]],
}

function changed(overrides) {
  return manifest({ ...base, ...overrides })
}

test("按改动文件所属组件得出最低更新级别", () => {
  const current = manifest(base)
  assert.deepEqual(planUpdate(current, manifest(base)), { level: "static", changed: [] })
  assert.equal(planUpdate(current, changed({ "package.json": ["b", ["meta"]] })).level, "static")
  assert.equal(
    planUpdate(current, changed({ "dist/panel/index.html": ["b", ["static"]] })).level,
    "static",
  )
  assert.equal(
    planUpdate(current, changed({ "dist/web/server.js": ["b", ["core"]] })).level,
    "core",
  )
  assert.equal(
    planUpdate(current, changed({ "dist/worker-preload.js": ["b", ["worker"]] })).level,
    "worker",
  )
  assert.equal(
    planUpdate(current, changed({ "dist/web/core-protocol.js": ["b", ["shell", "core"]] })).level,
    "host",
  )
  // 新增与删除同样计入，并按两侧角色的并集判断。
  assert.equal(planUpdate(current, changed({ "dist/web/new.js": ["c", ["core"]] })).level, "core")
  const removed = manifest(base)
  delete removed.files["dist/worker-preload.js"]
  assert.deepEqual(planUpdate(current, removed), {
    level: "worker",
    changed: ["dist/worker-preload.js"],
  })
})

test("只改提示文案不要求重启，控制台随热替换使用新文案", () => {
  const plan = planUpdate(
    manifest(base),
    changed({ "dist/shared/messages.js": ["b", ["shell", "worker", "core"]] }),
  )
  assert.equal(plan.level, "core")
  assert.deepEqual(plan.changed, ["dist/shared/messages.js"])
})

test("缺少组件清单时按宿主级别处理", () => {
  assert.equal(planUpdate(undefined, manifest(base)).level, "host")
  assert.equal(planUpdate(manifest(base), undefined).reason, "manifest-missing")
})

function fixture(t) {
  const root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "guard-plan-"))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  const plugin = path.join(root, "plugin")
  const staged = path.join(root, "staged")
  const write = (directory, file, text) => {
    fs.mkdirSync(path.dirname(path.join(directory, file)), { recursive: true })
    fs.writeFileSync(path.join(directory, file), text)
  }
  return { root, plugin, staged, write }
}

test("组件清单校验路径与摘要格式", t => {
  const { plugin, write } = fixture(t)
  write(plugin, "dist/components.json", JSON.stringify(manifest(base)))
  assert.equal(readManifest(plugin)?.version, "1.0.0")
  for (const bad of [
    { ...manifest(base), schema: 2 },
    manifest({ "../escape.js": ["a", ["core"]] }),
    manifest({ "dist/a.js": ["a", ["unknown"]] }),
    { schema: 1, version: "1", files: { "dist/a.js": { sha256: "short", roles: ["core"] } } },
  ]) {
    write(plugin, "dist/components.json", JSON.stringify(bad))
    assert.equal(readManifest(plugin), undefined)
  }
  fs.rmSync(path.join(plugin, "dist/components.json"))
  assert.equal(readManifest(plugin), undefined)
})

test("热替换只改动变化的文件，失败或回退时完整还原", t => {
  const { root, plugin, staged, write } = fixture(t)
  write(plugin, "dist/web/server.js", "old server")
  write(plugin, "dist/web/gone.js", "old gone")
  write(plugin, "dist/host/supervisor.js", "running host")
  write(plugin, "dist/components.json", "old manifest")
  write(plugin, "package.json", "old package")
  write(staged, "dist/web/server.js", "new server")
  write(staged, "dist/web/added.js", "new added")
  write(staged, "dist/host/supervisor.js", "should not be touched")
  write(staged, "dist/components.json", "new manifest")
  write(staged, "package.json", "new package")
  const backup = path.join(root, "backup")
  const read = file => fs.readFileSync(path.join(plugin, file), "utf8")
  const sync = syncFiles(
    staged,
    plugin,
    ["dist/web/server.js", "dist/web/added.js", "dist/web/gone.js"],
    backup,
  )
  assert.equal(read("dist/web/server.js"), "new server")
  assert.equal(read("dist/web/added.js"), "new added")
  assert.equal(fs.existsSync(path.join(plugin, "dist/web/gone.js")), false)
  assert.equal(read("dist/host/supervisor.js"), "running host")
  assert.equal(read("dist/components.json"), "new manifest")
  assert.equal(read("package.json"), "new package")
  sync.rollback()
  assert.equal(read("dist/web/server.js"), "old server")
  assert.equal(read("dist/web/gone.js"), "old gone")
  assert.equal(fs.existsSync(path.join(plugin, "dist/web/added.js")), false)
  assert.equal(read("dist/components.json"), "old manifest")
  assert.equal(read("package.json"), "old package")
  assert.throws(
    () => syncFiles(staged, plugin, ["../outside.js"], backup),
    /发布包内容不符|替换文件失败/,
  )
  assert.equal(read("package.json"), "old package")
})

test("维护时段支持跨午夜，起止相同视为全天", () => {
  assert.deepEqual(parseWindow("03:00-06:30"), { start: 180, end: 390 })
  for (const bad of ["3:00-06:00", "24:00-01:00", "03:00", "03:60-04:00"])
    assert.equal(parseWindow(bad), undefined)
  const at = (hours, minutes = 0) => new Date(2026, 0, 1, hours, minutes)
  assert.equal(inWindow("03:00-06:00", at(3)), true)
  assert.equal(inWindow("03:00-06:00", at(6)), false)
  assert.equal(inWindow("03:00-06:00", at(2, 59)), false)
  assert.equal(inWindow("23:00-02:00", at(23, 30)), true)
  assert.equal(inWindow("23:00-02:00", at(1, 59)), true)
  assert.equal(inWindow("23:00-02:00", at(12)), false)
  assert.equal(inWindow("00:00-00:00", at(15)), true)
  assert.equal(inWindow("bad", at(4)), false)
})
