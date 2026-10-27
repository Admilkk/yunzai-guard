import assert from "node:assert/strict"
import test from "node:test"
import { linuxSandboxIdentity } from "../dist/sandbox/linux-identity.js"

test("Linux sandbox user lookup preserves the actual uid/gid with only a private home", () => {
  const identity = linuxSandboxIdentity({
    username: "bot-user",
    uid: 1001,
    gid: 1002,
    homedir: "/host/private",
  })
  assert.equal(identity.passwd, "bot-user:x:1001:1002::/home:/bin/sh\n")
  assert.equal(identity.group, "bot-user:x:1002:\n")
  assert.equal(identity.passwd.includes("/host/private"), false)
  assert.equal(identity.passwd.split("\n").filter(Boolean).length, 1)
  assert.equal(
    linuxSandboxIdentity({ username: "root", uid: 0, gid: 0 }).passwd.startsWith("root:x:0:0:"),
    true,
  )
})

test("invalid account data cannot inject another identity or passwd field", () => {
  for (const username of ["", "a:b", "a\nb", "a\rb", "a\0b", "x".repeat(257)])
    assert.throws(
      () => linuxSandboxIdentity({ username, uid: 1000, gid: 1000 }),
      /当前用户身份无效/,
    )
  for (const value of [-1, 0.5, NaN, Infinity, 0x100000000, "1000"])
    for (const field of ["uid", "gid"])
      assert.throws(
        () => linuxSandboxIdentity({ username: "bot", uid: 1000, gid: 1000, [field]: value }),
        /当前用户身份无效/,
      )
})
