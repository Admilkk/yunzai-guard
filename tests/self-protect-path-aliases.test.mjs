import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import childProcess from "node:child_process"
import test from "node:test"
import { Paths } from "../dist/protect/paths.js"

function fixture(t) {
  const temporaryRoot = fs.realpathSync(os.tmpdir())
  const root = fs.mkdtempSync(path.join(temporaryRoot, "guard-path-alias-"))
  t.after(() => {
    const resolved = fs.realpathSync(root)
    assert.equal(path.dirname(resolved), temporaryRoot)
    assert.ok(path.basename(resolved).startsWith("guard-path-alias-"))
    fs.rmSync(resolved, { recursive: true, force: true })
  })
  const guard = path.join(root, "guard space")
  const work = path.join(root, "work")
  fs.mkdirSync(path.join(guard, "sub"), { recursive: true })
  fs.mkdirSync(work)
  const file = path.join(guard, "unchanged.txt")
  fs.writeFileSync(file, "original")
  const paths = roots =>
    new Paths(roots, () => {
      throw Object.assign(new Error("blocked fixture write"), { code: "PATH_GUARD_DENIED" })
    })
  return { root, guard, work, file, paths }
}

const denied = call => assert.throws(call, { code: "PATH_GUARD_DENIED" })
const rawParent = (directory, name) => `${directory}${path.sep}..${path.sep}${name}`

test("链接组件先解析再处理父目录，包括不存在的目标与祖先保护", t => {
  const app = fixture(t)
  const link = path.join(app.work, "link")
  fs.symlinkSync(
    path.join(app.guard, "sub"),
    link,
    process.platform === "win32" ? "junction" : "dir",
  )
  const guard = app.paths([app.guard])
  denied(() => guard.check(rawParent(link, "unchanged.txt"), "write"))
  denied(() => guard.check(rawParent(link, "new/nested.txt"), "write"))
  denied(() => guard.check(rawParent(link, ".."), "rm", true))
  assert.doesNotThrow(() => guard.check(rawParent(link, `..${path.sep}ordinary.txt`), "write"))
  assert.equal(fs.readFileSync(app.file, "utf8"), "original")
})

test(
  "Windows 常规路径的尾点、尾空格和 ADS 不能绕过目录或精确文件保护",
  { skip: process.platform !== "win32" },
  t => {
    const app = fixture(t)
    const guard = app.paths([app.guard])
    for (const suffix of [".", "...", " ."])
      denied(() => guard.check(`${app.guard}${suffix}\\unchanged.txt`, "write"))
    const manifest = path.join(app.root, "manifest.json")
    fs.writeFileSync(manifest, "original")
    const exact = app.paths([manifest])
    for (const suffix of [".", " ", "::$DATA", ":stream", ".::$DATA"])
      denied(() => exact.check(manifest + suffix, "write"))
    denied(() => exact.check(`\\\\?\\${manifest}:stream`, "write"))
    denied(() => guard.check(`\\\\?\\${app.file}`, "write"))
    // 命名空间路径保留真正的尾点目录名，不当成普通 Win32 的别名。
    assert.doesNotThrow(() => guard.check(`\\\\?\\${app.guard}.\\ordinary.txt`, "write"))
  },
)

test(
  "实际 cmd 重定向的 Win32 尾点别名在执行前被拒绝，普通文件仍可写",
  { skip: process.platform !== "win32" },
  t => {
    const app = fixture(t)
    const manifest = path.join(app.root, "manifest.json")
    const ordinary = path.join(app.root, "ordinary.txt")
    fs.writeFileSync(manifest, "original")
    const guard = app.paths([manifest, app.guard])
    const write = name => {
      guard.check(name, "redirect")
      childProcess.execSync(`echo changed > "${name}"`, {
        windowsHide: true,
        stdio: "pipe",
        timeout: 5000,
      })
    }
    write(ordinary + ".")
    assert.match(fs.readFileSync(ordinary, "utf8"), /^changed/)
    denied(() => write(manifest + "."))
    denied(() => write(`${app.guard}.\\unchanged.txt`))
    assert.equal(fs.readFileSync(manifest, "utf8"), "original")
    assert.equal(fs.readFileSync(app.file, "utf8"), "original")
  },
)

test("Win32 别名检查不依赖可替换的 RegExp.replace", { skip: process.platform !== "win32" }, t => {
  const app = fixture(t)
  const guard = app.paths([app.guard])
  const original = RegExp.prototype[Symbol.replace]
  let blocked = false
  try {
    RegExp.prototype[Symbol.replace] = value => value
    try {
      guard.check(`${app.guard}.\\unchanged.txt`, "write")
    } catch (error) {
      blocked = error.code === "PATH_GUARD_DENIED"
    }
  } finally {
    RegExp.prototype[Symbol.replace] = original
  }
  assert.equal(blocked, true)
})

const nativeTee =
  process.platform === "win32" ? "C:/Program Files/Git/usr/bin/tee.exe" : "/usr/bin/tee"
test("实际 tee 的链接父目录语义与固定路径保护一致", { skip: !fs.existsSync(nativeTee) }, t => {
  const app = fixture(t)
  const ordinary = path.join(app.root, "ordinary")
  fs.mkdirSync(path.join(ordinary, "sub"), { recursive: true })
  const ordinaryFile = path.join(ordinary, "marker.txt")
  fs.writeFileSync(ordinaryFile, "before")
  const kind = process.platform === "win32" ? "junction" : "dir"
  fs.symlinkSync(path.join(app.guard, "sub"), path.join(app.work, "protected-link"), kind)
  fs.symlinkSync(path.join(ordinary, "sub"), path.join(app.work, "ordinary-link"), kind)
  const guard = app.paths([app.guard])
  const write = name => {
    const absolute = `${app.work}${path.sep}${name}`
    guard.check(absolute, "tee")
    childProcess.execFileSync(nativeTee, [name], {
      cwd: app.work,
      input: "changed",
      windowsHide: true,
      timeout: 5000,
    })
  }
  write("ordinary-link/../marker.txt")
  assert.equal(fs.readFileSync(ordinaryFile, "utf8"), "changed")
  denied(() => write("protected-link/../unchanged.txt"))
  assert.equal(fs.readFileSync(app.file, "utf8"), "original")
})
