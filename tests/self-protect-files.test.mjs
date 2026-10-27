import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { once } from "node:events"
import { pathToFileURL } from "node:url"
import { promisify } from "node:util"
import test from "node:test"
import { installFileGuard } from "../dist/protect/files.js"

test("文件自保护拒绝受保护变更，并保留业务文件接口语义", async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "guard-files-"))
  const protectedRoot = path.join(root, "guard")
  const ordinaryRoot = path.join(root, "other")
  fs.mkdirSync(protectedRoot)
  fs.mkdirSync(ordinaryRoot)
  const protectedFile = path.join(protectedRoot, "data.txt")
  const ordinaryFile = path.join(ordinaryRoot, "data.txt")
  fs.writeFileSync(protectedFile, "original")
  fs.writeFileSync(ordinaryFile, "ordinary")
  const secret = path.join(protectedRoot, "control.json")
  fs.writeFileSync(secret, '{"token":"private"}')
  const secretRoot = path.join(protectedRoot, "private")
  fs.mkdirSync(secretRoot)
  const invalidName = directory => Buffer.concat([Buffer.from(`${directory}/`), Buffer.of(0xff)])
  if (process.platform === "linux") {
    fs.writeFileSync(invalidName(ordinaryRoot), "ordinary-bytes")
    fs.writeFileSync(invalidName(secretRoot), "private-bytes")
  }
  const link = path.join(root, "alias")
  let linked = false
  try {
    fs.symlinkSync(protectedRoot, link, process.platform === "win32" ? "junction" : "dir")
    linked = true
  } catch (error) {
    if (!["EPERM", "EACCES", "ENOTSUP"].includes(error.code)) throw error
  }
  const oldFd = fs.openSync(protectedFile, "r+")
  const remove = fs.rmSync
  const close = fs.closeSync
  t.after(() => {
    close(oldFd)
    remove(root, { recursive: true, force: true })
  })
  const events = []
  installFileGuard({
    roots: [protectedRoot],
    readRoots: [secret, secretRoot],
    deny(operation, target) {
      events.push({ operation, target })
      throw Object.assign(new Error("Guard file is protected"), { code: "GUARD_DENIED" })
    },
    seal(object, key, value) {
      Object.defineProperty(object, key, { value, writable: false, configurable: false })
    },
  })

  await t.test("同步、回调和 Promise 写入保持各自的报错方式", async () => {
    assert.throws(() => fs.writeFileSync(protectedFile, "bad"), { code: "GUARD_DENIED" })
    let returned = false
    const result = new Promise(resolve => {
      fs.appendFile(protectedFile, "bad", error => {
        assert.equal(returned, true)
        resolve(error)
      })
    })
    returned = true
    assert.equal((await result).code, "GUARD_DENIED")
    await assert.rejects(fs.promises.writeFile(protectedFile, "bad"), { code: "GUARD_DENIED" })
    fs.writeFileSync(ordinaryFile, "sync")
    await new Promise((resolve, reject) =>
      fs.appendFile(ordinaryFile, "+callback", error => (error ? reject(error) : resolve())),
    )
    await fs.promises.appendFile(ordinaryFile, "+promise")
    assert.equal(fs.readFileSync(ordinaryFile, "utf8"), "sync+callback+promise")
  })

  await t.test("移动源、目的、祖先和复制目的均不能替换保护树", async () => {
    assert.throws(() => fs.renameSync(protectedFile, ordinaryFile), { code: "GUARD_DENIED" })
    assert.throws(() => fs.renameSync(ordinaryFile, protectedFile), { code: "GUARD_DENIED" })
    assert.throws(() => fs.rmSync(root, { recursive: true }), { code: "GUARD_DENIED" })
    await assert.rejects(fs.promises.copyFile(ordinaryFile, protectedFile), {
      code: "GUARD_DENIED",
    })
    assert.throws(() => fs.cpSync(ordinaryRoot, protectedRoot, { recursive: true }), {
      code: "GUARD_DENIED",
    })
    const copy = path.join(ordinaryRoot, "copy.txt")
    fs.copyFileSync(protectedFile, copy)
    assert.equal(fs.readFileSync(copy, "utf8"), "original")
    fs.unlinkSync(copy)
  })

  await t.test("符号链接、链接新建及尚不存在的后代不能绕过", () => {
    if (linked)
      assert.throws(() => fs.writeFileSync(path.join(link, "data.txt"), "bad"), {
        code: "GUARD_DENIED",
      })
    assert.throws(() => fs.linkSync(protectedFile, path.join(root, "hardlink")), {
      code: "GUARD_DENIED",
    })
    assert.throws(() => fs.symlinkSync("../guard", path.join(ordinaryRoot, "new-alias")), {
      code: "GUARD_DENIED",
    })
    assert.throws(
      () => fs.mkdirSync(path.join(protectedRoot, "missing", "nested"), { recursive: true }),
      { code: "GUARD_DENIED" },
    )
    assert.throws(() => fs.openSync(protectedFile, fs.constants.O_RDWR), { code: "GUARD_DENIED" })
  })

  await t.test("记录的 fd、FileHandle 以及 Linux 安装前 fd 受保护", async () => {
    const fd = fs.openSync(protectedFile, "r")
    try {
      assert.throws(() => fs.writeSync(fd, "bad"), { code: "GUARD_DENIED" })
      assert.throws(() => fs.writeFileSync(fd, "bad"), { code: "GUARD_DENIED" })
      assert.throws(() => fs.fchmodSync(fd, 0o600), { code: "GUARD_DENIED" })
    } finally {
      fs.closeSync(fd)
    }
    const file = await fs.promises.open(protectedFile, "r")
    try {
      await assert.rejects(file.writeFile("bad"), { code: "GUARD_DENIED" })
      await assert.rejects(fs.promises.writeFile(file, "bad"), { code: "GUARD_DENIED" })
      await assert.rejects(file.chmod(0o600), { code: "GUARD_DENIED" })
      const [error] = await once(file.createWriteStream(), "error")
      assert.equal(error.code, "GUARD_DENIED")
    } finally {
      await file.close()
    }
    if (process.platform === "linux")
      assert.throws(() => fs.writeSync(oldFd, "bad"), { code: "GUARD_DENIED" })
    const ordinary = await fs.promises.open(ordinaryFile, "r+")
    try {
      await ordinary.writeFile("handle")
      assert.ok((await ordinary.readFile("utf8")) !== undefined)
      const result = await promisify(fs.write)(ordinary.fd, Buffer.from("ok"), 0, 2, 0)
      assert.equal(result.bytesWritten, 2)
      assert.equal(result.buffer.toString(), "ok")
      const protectedFd = fs.openSync(protectedFile, "r")
      try {
        assert.throws(
          () => Object.defineProperty(ordinary, "fd", { value: protectedFd }),
          TypeError,
        )
        const fdSlot = Object.getOwnPropertySymbols(ordinary).find(
          key => ordinary[key] === ordinary.fd,
        )
        assert.ok(fdSlot)
        const savedFd = ordinary[fdSlot]
        try {
          ordinary[fdSlot] = protectedFd
          await assert.rejects(ordinary.chmod(0o444), { code: "GUARD_DENIED" })
        } finally {
          ordinary[fdSlot] = savedFd
        }
      } finally {
        fs.closeSync(protectedFd)
      }
    } finally {
      await ordinary.close()
    }
    assert.equal(ordinary.fd, -1)
  })

  await t.test("写入流按异步 error 语义失败，普通流可完成", async () => {
    const blocked = fs.createWriteStream(protectedFile)
    assert.ok(blocked instanceof fs.WriteStream)
    const [error] = await once(blocked, "error")
    assert.equal(error.code, "GUARD_DENIED")
    const fd = fs.openSync(protectedFile, "r")
    try {
      const [fdError] = await once(fs.createWriteStream(undefined, { fd }), "error")
      assert.equal(fdError.code, "GUARD_DENIED")
    } finally {
      fs.closeSync(fd)
    }
    const stream = fs.createWriteStream(ordinaryFile)
    stream.end("stream")
    await once(stream, "close")
    assert.equal(fs.readFileSync(ordinaryFile, "utf8"), "stream")
  })

  await t.test("URL、Buffer 与有副作用的选项只能使用检查过的路径", () => {
    assert.throws(() => fs.writeFileSync(pathToFileURL(protectedFile), "bad"), {
      code: "GUARD_DENIED",
    })
    assert.throws(() => fs.writeFileSync(Buffer.from(protectedFile), "bad"), {
      code: "GUARD_DENIED",
    })
    const bytes = new Uint8Array(Buffer.from(protectedFile))
    Object.defineProperty(bytes, "length", { value: 0 })
    assert.throws(() => fs.writeFileSync(bytes, "bad"), { code: "GUARD_DENIED" })
    const url = pathToFileURL(protectedFile)
    const urlLike = {
      href: url.href,
      protocol: url.protocol,
      hostname: url.hostname,
      pathname: url.pathname,
    }
    assert.throws(() => fs.writeFileSync(urlLike, "bad"), { code: "GUARD_DENIED" })
    let evaluated = 0
    fs.writeFileSync(
      {
        ...urlLike,
        get pathname() {
          return ++evaluated === 1 ? pathToFileURL(ordinaryFile).pathname : url.pathname
        },
      },
      "snapshot",
    )
    assert.equal(evaluated, 1)
    assert.equal(fs.readFileSync(new Uint8Array(Buffer.from(ordinaryFile)), "utf8"), "snapshot")
    const unstable = {}
    assert.throws(
      () =>
        fs.writeFileSync(unstable, "bad", {
          get encoding() {
            Object.assign(unstable, urlLike)
            return "utf8"
          },
        }),
      { code: "ERR_INVALID_ARG_TYPE" },
    )
    const buffer = Buffer.from(ordinaryFile)
    assert.equal(buffer.length, Buffer.byteLength(protectedFile))
    fs.writeFileSync(buffer, "stable", {
      get encoding() {
        buffer.set(Buffer.from(protectedFile))
        return "utf8"
      },
    })
    assert.equal(fs.readFileSync(ordinaryFile, "utf8"), "stable")
    assert.equal(fs.readFileSync(protectedFile, "utf8"), "original")
    const previous = process.cwd()
    const cwd = process.cwd
    try {
      process.chdir(ordinaryRoot)
      fs.writeFileSync("data.txt", "absolute", {
        get encoding() {
          process.chdir(protectedRoot)
          return "utf8"
        },
      })
      assert.equal(fs.readFileSync(ordinaryFile, "utf8"), "absolute")
      process.cwd = () => ordinaryRoot
      assert.throws(() => fs.writeFileSync("data.txt", "bad"), { code: "GUARD_DENIED" })
    } finally {
      process.cwd = cwd
      process.chdir(previous)
    }
  })

  await t.test("控制凭据禁止读取和复制，源码与业务读取保持可用", async () => {
    assert.throws(() => fs.readFileSync(secret, "utf8"), { code: "GUARD_DENIED" })
    assert.throws(() => fs.readFileSync(new Uint8Array(Buffer.from(secret)), "utf8"), {
      code: "GUARD_DENIED",
    })
    const url = pathToFileURL(secret)
    await assert.rejects(
      fs.promises.readFile({
        href: url.href,
        protocol: url.protocol,
        hostname: url.hostname,
        pathname: url.pathname,
      }),
      { code: "GUARD_DENIED" },
    )
    assert.throws(() => fs.openSync(secret, "r"), { code: "GUARD_DENIED" })
    assert.throws(() => fs.openSync(secret, "r+"), { code: "GUARD_DENIED" })
    const callbackError = await new Promise(resolve => fs.readFile(secret, resolve))
    assert.equal(callbackError.code, "GUARD_DENIED")
    await assert.rejects(fs.promises.readFile(secret), { code: "GUARD_DENIED" })
    await assert.rejects(fs.promises.open(secret, "r"), { code: "GUARD_DENIED" })
    await assert.rejects(fs.openAsBlob(secret), { code: "GUARD_DENIED" })
    const blob = await fs.openAsBlob(ordinaryFile)
    assert.equal(await blob.text(), fs.readFileSync(ordinaryFile, "utf8"))
    const [streamError] = await once(fs.createReadStream(secret), "error")
    assert.equal(streamError.code, "GUARD_DENIED")
    assert.throws(() => fs.copyFileSync(secret, path.join(ordinaryRoot, "leaked.json")), {
      code: "GUARD_DENIED",
    })
    await assert.rejects(
      fs.promises.cp(protectedRoot, path.join(ordinaryRoot, "copy"), { recursive: true }),
      { code: "GUARD_DENIED" },
    )
    assert.throws(() => fs.readFileSync(protectedFile, { flag: "w" }), { code: "GUARD_DENIED" })
    const [writeFlagError] = await once(fs.createReadStream(protectedFile, { flags: "w" }), "error")
    assert.equal(writeFlagError.code, "GUARD_DENIED")
    assert.equal(fs.readFileSync(protectedFile, "utf8"), "original")
    const file = await fs.promises.open(ordinaryFile, "r")
    try {
      assert.equal(typeof (await file.readFile("utf8")), "string")
    } finally {
      await file.close()
    }
    if (process.platform === "linux") {
      assert.equal(fs.readFileSync(invalidName(ordinaryRoot), "utf8"), "ordinary-bytes")
      assert.throws(() => fs.readFileSync(invalidName(secretRoot), "utf8"), {
        code: "GUARD_DENIED",
      })
    }
  })

  await t.test("写入检查不能被替换，保护文件内容保持不变", () => {
    const write = fs.writeFileSync
    assert.throws(() => {
      fs.writeFileSync = () => {}
    }, TypeError)
    assert.throws(() => Object.defineProperty(fs.promises, "writeFile", { value() {} }), TypeError)
    assert.equal(fs.writeFileSync, write)
    assert.equal(fs.readFileSync(protectedFile, "utf8"), "original")
    assert.ok(events.length >= 20)
  })
})
