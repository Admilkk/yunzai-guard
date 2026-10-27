import assert from "node:assert/strict"
import test from "node:test"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { spawnSync } from "node:child_process"
import { fileURLToPath, pathToFileURL } from "node:url"
import { collectWindowsAliases, installSandboxResolution } from "../dist/sandbox/resolution.js"

const linkDirectory = (target, alias) =>
  fs.symlinkSync(target, alias, process.platform === "win32" ? "junction" : "dir")

function cleanup(directory) {
  assert.equal(path.dirname(fs.realpathSync.native(directory)), fs.realpathSync.native(os.tmpdir()))
  assert.ok(path.basename(directory).startsWith("guard alias "))
  fs.rmSync(directory, { recursive: true, force: true })
}

test("trusted alias map preserves ESM and createRequire relative imports with spaces and Chinese paths", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "guard alias 中文 "))
  const root = path.join(directory, "项目 空格")
  try {
    for (const folder of [
      "node_modules",
      "lib/modules/wrapper-esm",
      "lib/modules/wrapper-cjs",
      "vendor/dependency-esm",
      "vendor/dependency-cjs",
    ])
      fs.mkdirSync(path.join(root, folder), { recursive: true })
    fs.writeFileSync(
      path.join(root, "lib/modules/wrapper-esm/index.mjs"),
      'export { value } from "../../../node_modules/dep-esm/index.mjs"\n',
    )
    fs.writeFileSync(
      path.join(root, "lib/modules/wrapper-cjs/index.cjs"),
      'module.exports=require("../../../node_modules/dep-cjs/index.cjs")\n',
    )
    fs.writeFileSync(
      path.join(root, "vendor/dependency-esm/index.mjs"),
      'export const value="依赖 ESM"\n',
    )
    fs.writeFileSync(
      path.join(root, "vendor/dependency-cjs/index.cjs"),
      'module.exports="依赖 CJS"\n',
    )
    for (const [alias, target] of [
      ["wrapper-esm", "lib/modules/wrapper-esm"],
      ["wrapper-cjs", "lib/modules/wrapper-cjs"],
      ["dep-esm", "vendor/dependency-esm"],
      ["dep-cjs", "vendor/dependency-cjs"],
    ])
      linkDirectory(path.join(root, target), path.join(root, "node_modules", alias))
    const aliases = collectWindowsAliases(root)
    assert.equal(aliases.links.length, 4)
    const manifest = path.join(directory, "manifest.json")
    fs.writeFileSync(manifest, JSON.stringify({ moduleAliases: aliases }))
    const esmAlias = path.join(
      root,
      process.platform === "win32"
        ? "NODE_MODULES/WRAPPER-ESM/index.mjs"
        : "node_modules/wrapper-esm/index.mjs",
    )
    const cjsAlias = path.join(root, "node_modules/wrapper-cjs/index.cjs")
    const app = path.join(root, "entry.mjs")
    fs.writeFileSync(
      app,
      `import{value}from ${JSON.stringify(pathToFileURL(esmAlias).href)};import{createRequire}from"node:module";const require=createRequire(import.meta.url);console.log(JSON.stringify({esm:value,cjs:require(${JSON.stringify(cjsAlias)}),beforeRequire:globalThis.beforeRequire,beforeImport:globalThis.beforeImport}));\n`,
    )
    const flags = ["--preserve-symlinks", "--preserve-symlinks-main"]
    const env = { ...process.env }
    delete env.NODE_OPTIONS
    const broken = spawnSync(process.execPath, [...flags, app], { env, encoding: "utf8" })
    assert.notEqual(
      broken.status,
      0,
      "fixture must expose the original alias-relative resolution failure",
    )
    const hook = path.join(directory, "hook.cjs")
    fs.writeFileSync(
      hook,
      `require(${JSON.stringify(fileURLToPath(new URL("../dist/sandbox/resolution.js", import.meta.url)))}).installSandboxResolution(${JSON.stringify(manifest)})\n`,
    )
    const requirePreload = path.join(directory, "user.cjs")
    fs.writeFileSync(
      requirePreload,
      `globalThis.beforeRequire=require(${JSON.stringify(cjsAlias)})\n`,
    )
    const importPreload = path.join(directory, "user.mjs")
    fs.writeFileSync(
      importPreload,
      `import{value}from ${JSON.stringify(pathToFileURL(esmAlias).href)};globalThis.beforeImport=value\n`,
    )
    const result = spawnSync(
      process.execPath,
      [
        ...flags,
        "--require",
        hook,
        "--require",
        requirePreload,
        "--import",
        pathToFileURL(importPreload).href,
        app,
      ],
      { env, encoding: "utf8" },
    )
    assert.equal(result.status, 0, result.stderr)
    assert.deepEqual(JSON.parse(result.stdout.trim()), {
      esm: "依赖 ESM",
      cjs: "依赖 CJS",
      beforeRequire: "依赖 CJS",
      beforeImport: "依赖 ESM",
    })
  } finally {
    cleanup(directory)
  }
})

test("host alias scan skips writable and metadata trees and rejects readonly links outside the project", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "guard alias exclusions "))
  const root = path.join(directory, "project")
  const outside = path.join(directory, "outside")
  try {
    fs.mkdirSync(outside, { recursive: true })
    for (const relative of [
      "data",
      "temp",
      "logs",
      "config/config",
      ".git",
      ".cache",
      "plugins/demo/.cache",
      "custom-writable",
    ]) {
      const folder = path.join(root, relative)
      fs.mkdirSync(folder, { recursive: true })
      linkDirectory(outside, path.join(folder, "outside"))
    }
    assert.deepEqual(collectWindowsAliases(root, ["custom-writable"]).links, [])
    fs.mkdirSync(path.join(root, "node_modules"), { recursive: true })
    linkDirectory(outside, path.join(root, "node_modules", "outside"))
    assert.throws(() => collectWindowsAliases(root, ["custom-writable"]), /沙箱模块别名越出项目：/)
  } finally {
    cleanup(directory)
  }
})

test("malformed and oversized alias maps fail instead of being truncated", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "guard alias limits "))
  const manifest = path.join(directory, "manifest.json")
  try {
    fs.writeFileSync(
      manifest,
      JSON.stringify({
        moduleAliases: { root: directory, links: [{ from: "node_modules/a", to: "../outside" }] },
      }),
    )
    assert.throws(() => installSandboxResolution(manifest), /受信沙箱模块别名路径无效/)
    fs.writeFileSync(
      manifest,
      JSON.stringify({
        moduleAliases: {
          root: directory,
          links: Array.from({ length: 8193 }, (_, index) => ({
            from: `alias-${index}`,
            to: "target",
          })),
        },
      }),
    )
    assert.throws(() => installSandboxResolution(manifest), /受信沙箱模块别名表无效/)
  } finally {
    cleanup(directory)
  }
})
