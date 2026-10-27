import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import test from "node:test"
import { collectWindowsAliases } from "../dist/sandbox/resolution.js"

const directoryLink = (target, alias) =>
  fs.symlinkSync(target, alias, process.platform === "win32" ? "junction" : "dir")

function fixture(t) {
  const base = fs.mkdtempSync(path.join(fs.realpathSync.native(os.tmpdir()), "guard own alias "))
  const root = path.join(base, "project")
  const outside = path.join(base, "outside")
  for (const relative of [
    "plugins/demo/node_modules",
    "node_modules/.pnpm/node_modules",
    "vendor/dep",
    "vendor/nested",
    "config/business",
    "data/yunzai-guard",
  ])
    fs.mkdirSync(path.join(root, relative), { recursive: true })
  fs.mkdirSync(outside)
  fs.writeFileSync(path.join(root, "config/business/settings.json"), "{}")
  t.after(() => {
    assert.equal(path.dirname(fs.realpathSync.native(base)), fs.realpathSync.native(os.tmpdir()))
    assert.ok(path.basename(base).startsWith("guard own alias "))
    fs.rmSync(base, { recursive: true, force: true })
  })
  const link = (from, to) => {
    const filename = path.join(root, from)
    fs.mkdirSync(path.dirname(filename), { recursive: true })
    directoryLink(to === "OUTSIDE" ? outside : path.join(root, to), filename)
    return filename
  }
  return { root, outside, link }
}

test("selected plugin node_modules aliases are complete without scanning the rest of its writable tree", t => {
  const { root, link } = fixture(t)
  link("node_modules/global-dep", "vendor/dep")
  link("plugins/demo/node_modules/@fixture/dep", "vendor/dep")
  link("vendor/dep/node_modules/nested", "vendor/nested")
  link("plugins/demo/runtime-data", "OUTSIDE")
  const result = collectWindowsAliases(root, ["plugins/demo"])
  assert.deepEqual(result.links.map(item => item.from).sort(), [
    "node_modules/global-dep",
    "plugins/demo/node_modules/@fixture/dep",
    "vendor/dep/node_modules/nested",
  ])
  assert.equal(result.skippedWritableBacklinks, undefined)
})

test("readonly workspace backlinks into writable paths are recorded but not trusted rewrites", t => {
  const { root, link } = fixture(t)
  link("node_modules/.pnpm/node_modules/demo", "plugins/demo")
  link("node_modules/plugins-parent", "plugins")
  link("plugins/demo/node_modules/dep", "vendor/dep")
  const result = collectWindowsAliases(root, ["plugins/demo"])
  assert.deepEqual(result.links, [{ from: "plugins/demo/node_modules/dep", to: "vendor/dep" }])
  assert.deepEqual(result.skippedWritableBacklinks.map(item => item.to).sort(), [
    "plugins",
    "plugins/demo",
  ])
  link("plugins/demo/node_modules/unsafe-self", "plugins/demo")
  assert.throws(() => collectWindowsAliases(root, ["plugins/demo"]), /插件依赖别名指向可写路径：/)
})

test("玖璃自身根包的只读 workspace backlink 不授予路径别名或写权限", t => {
  const { root, link } = fixture(t)
  fs.writeFileSync(path.join(root, "package.json"), JSON.stringify({ name: "jiuli" }))
  link("plugins/example/node_modules/jiuli", ".")
  link("node_modules/.pnpm/node_modules/jiuli", ".")
  link("plugins/demo/node_modules/jiuli", ".")
  link("plugins/demo/node_modules/dep", "vendor/dep")
  const result = collectWindowsAliases(root, ["plugins/demo"])
  assert.deepEqual(result.links, [{ from: "plugins/demo/node_modules/dep", to: "vendor/dep" }])
  assert.deepEqual(result.skippedCoreBacklinks.map(item => item.from).sort(), [
    "node_modules/.pnpm/node_modules/jiuli",
    "plugins/demo/node_modules/jiuli",
    "plugins/example/node_modules/jiuli",
  ])
  assert.ok(result.skippedCoreBacklinks.every(item => item.to === "."))
  assert.equal(result.skippedWritableBacklinks, undefined)
})

test("核心 backlink 例外不接受陌生包、错误来源或受保护目标", t => {
  const { root, link } = fixture(t)
  fs.writeFileSync(path.join(root, "package.json"), JSON.stringify({ name: "other-core" }))
  const backlink = link("plugins/example/node_modules/jiuli", ".")
  assert.throws(() => collectWindowsAliases(root, ["plugins/demo"]), /沙箱模块别名指向受保护/)
  fs.unlinkSync(backlink)
  fs.writeFileSync(path.join(root, "package.json"), JSON.stringify({ name: "jiuli" }))
  for (const [from, to] of [
    ["plugins/example/node_modules/other", "."],
    ["plugins/demo/node_modules/jiuli", "plugins/demo"],
    ["plugins/yunzai-guard/node_modules/jiuli", "."],
    ["plugins/example/node_modules/jiuli", "data/yunzai-guard"],
  ]) {
    const filename = link(from, to)
    assert.throws(
      () => collectWindowsAliases(root, ["plugins/demo"]),
      to === "plugins/demo" ? /插件依赖别名指向可写路径/ : /沙箱模块别名指向受保护/,
    )
    fs.unlinkSync(filename)
  }
  link("plugins/example/node_modules/jiuli", "OUTSIDE")
  assert.throws(() => collectWindowsAliases(root, ["plugins/demo"]), /沙箱模块别名越出项目/)
})

test("precise writable files also exclude aliases to their containing subtree", t => {
  const { root, link } = fixture(t)
  link("node_modules/business", "config/business")
  assert.equal(collectWindowsAliases(root, ["plugins/demo"]).links.length, 1)
  const result = collectWindowsAliases(root, ["plugins/demo"], ["config/business/settings.json"])
  assert.deepEqual(result.links, [])
  assert.deepEqual(result.skippedWritableBacklinks, [
    { from: "node_modules/business", to: "config/business" },
  ])
  link("plugins/demo/node_modules/business", "config/business")
  assert.throws(
    () => collectWindowsAliases(root, ["plugins/demo"], ["config/business/settings.json"]),
    /插件依赖别名指向可写路径：/,
  )
})

test(
  "exact writable-file symlinks are excluded, while readonly sibling-file aliases remain",
  { skip: process.platform === "win32" },
  t => {
    const { root } = fixture(t)
    fs.writeFileSync(path.join(root, "config/business/readonly.json"), "{}")
    for (const [from, to] of [
      ["mutable", "settings"],
      ["readonly", "readonly"],
    ])
      fs.symlinkSync(
        path.join(root, `config/business/${to}.json`),
        path.join(root, `node_modules/${from}.json`),
      )
    const result = collectWindowsAliases(root, ["plugins/demo"], ["config/business/settings.json"])
    assert.deepEqual(result.links, [
      { from: "node_modules/readonly.json", to: "config/business/readonly.json" },
    ])
    assert.deepEqual(result.skippedWritableBacklinks, [
      { from: "node_modules/mutable.json", to: "config/business/settings.json" },
    ])
  },
)

test("backlink omission never permits external aliases or Guard-state aliases", t => {
  const { root, link } = fixture(t)
  for (const prefix of ["node_modules", "plugins/demo/node_modules"]) {
    const outside = link(`${prefix}/outside`, "OUTSIDE")
    assert.throws(() => collectWindowsAliases(root, ["plugins/demo"]), /沙箱模块别名越出项目：/)
    fs.unlinkSync(outside)
    const state = link(`${prefix}/state`, "data/yunzai-guard")
    assert.throws(
      () =>
        collectWindowsAliases(
          root,
          ["plugins/demo", "data/yunzai-guard"],
          ["data/yunzai-guard/private.json"],
        ),
      /沙箱模块别名指向受保护或排除的目录：/,
    )
    fs.unlinkSync(state)
  }
})

test("a plugin node_modules junction itself is mapped, but a linked writable plugin root is refused", t => {
  const { root, outside } = fixture(t)
  fs.rmdirSync(path.join(root, "plugins/demo/node_modules"))
  directoryLink(path.join(root, "vendor/dep"), path.join(root, "plugins/demo/node_modules"))
  assert.deepEqual(collectWindowsAliases(root, ["plugins/demo"]).links, [
    { from: "plugins/demo/node_modules", to: "vendor/dep" },
  ])
  directoryLink(outside, path.join(root, "plugins/linked"))
  assert.throws(
    () => collectWindowsAliases(root, ["plugins/linked"]),
    /可写插件别名来源须为无链接的真实目录/,
  )
})

test("missing dependency roots are allowed, dangling roots and invalid write scopes fail", t => {
  const { root } = fixture(t)
  fs.rmdirSync(path.join(root, "plugins/demo/node_modules"))
  assert.deepEqual(collectWindowsAliases(root, ["plugins/demo"]).links, [])
  directoryLink(path.join(root, "missing"), path.join(root, "plugins/demo/node_modules"))
  assert.throws(() => collectWindowsAliases(root, ["plugins/demo"]), /ENOENT/)
  assert.throws(() => collectWindowsAliases(root, ["../escape"]), /受信别名收集中的可写路径无效/)
  assert.throws(
    () => collectWindowsAliases(root, [], ["../escape.json"]),
    /受信别名收集中的可写路径无效/,
  )
})
