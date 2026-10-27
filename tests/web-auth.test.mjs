import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import test from "node:test"
import { PanelAuth } from "../dist/web/auth.js"
import { loadPanelSettings, savePanelSettings } from "../dist/web/panel-settings.js"

function fixture(t) {
  const temporaryRoot = fs.realpathSync(os.tmpdir())
  const directory = fs.mkdtempSync(path.join(temporaryRoot, "guard-panel-auth-"))
  t.after(() => {
    assert.equal(path.dirname(directory), temporaryRoot)
    fs.rmSync(directory, { recursive: true, force: true })
  })
  const settings = loadPanelSettings(directory)
  return { directory, settings, auth: new PanelAuth(() => settings, directory) }
}

test("验证码只用一次，临时会话隔离 CSRF 且可立即退出", t => {
  const { auth } = fixture(t)
  const code = auth.requestCode()
  assert.throws(() => auth.requestCode(), { status: 429 })
  assert.throws(() => auth.checkCode("wrong", "127.0.0.1"), { status: 401 })
  const token = auth.checkCode(code.toLowerCase(), "127.0.0.1")
  assert.match(token, /^[A-Za-z0-9_-]{43}$/)
  assert.equal(auth.verify(token).remember, false)
  assert.throws(() => auth.checkCode(code, "127.0.0.1"), { status: 401 })
  assert.equal(auth.verifyCsrf(token, auth.csrf(token)), true)
  assert.equal(auth.verifyCsrf(auth.issue(), auth.csrf(token)), false)
  assert.equal(auth.verifyCsrf(token, "x".repeat(100000)), false)
  auth.logout(token)
  assert.equal(auth.verify(token), undefined)
  assert.throws(() => auth.csrf(token), { status: 401 })
  assert.equal(auth.verify({}), undefined)
})

test("可信设备跨宿主重启续会话，只保存摘要并支持撤销和密钥轮换", t => {
  const { auth, directory, settings } = fixture(t)
  const code = auth.requestCode()
  const trusted = auth.checkCode(code, "127.0.0.1", { remember: true, userAgent: "Guard browser" })
  const temporary = auth.issue()
  const record = auth.sessions(trusted).find(item => item.current)
  assert.equal(record.remember, true)
  assert.equal(record.expiresAt - record.createdAt, 30 * 24 * 3600_000)
  assert.equal(record.userAgent, "Guard browser")
  const disk = fs.readFileSync(path.join(directory, "auth-sessions.json"), "utf8")
  assert.equal(disk.includes(trusted), false)
  assert.equal(disk.includes(temporary), false)
  const stored = JSON.parse(disk)
  assert.equal(stored.sessions.length, 1)
  assert.match(stored.sessions[0].hash, /^[a-f0-9]{64}$/)
  const restarted = new PanelAuth(() => settings, directory)
  assert.equal(restarted.verify(trusted).remember, true)
  assert.equal(restarted.verify(temporary), undefined)
  assert.equal(restarted.csrf(trusted), auth.csrf(trusted))
  assert.equal(restarted.revoke(record.id), true)
  assert.equal(new PanelAuth(() => settings, directory).verify(trusted), undefined)
  const another = restarted.issue({ remember: true })
  assert.equal(
    new PanelAuth(() => ({ ...settings, jwtSecret: "new-key".repeat(8) }), directory).verify(
      another,
    ),
    undefined,
  )
})

test("登录限速、会话数量和可信设备配置保持有界", t => {
  const { auth, directory } = fixture(t)
  const code = auth.requestCode()
  for (let index = 0; index < 8; index++)
    assert.throws(() => auth.checkCode("wrong", "blocked"), { status: 401 })
  assert.throws(() => auth.checkCode(code, "blocked"), { status: 429 })
  assert.ok(auth.checkCode(code, "another-address"))
  for (let index = 0; index < 40; index++) auth.issue()
  assert.equal(auth.tokenCount, 32)
  assert.equal(loadPanelSettings(directory).trustedDeviceTtlDays, 30)
  assert.equal(savePanelSettings(directory, { trustedDeviceTtlDays: 90 }).trustedDeviceTtlDays, 90)
  for (const value of [0, 91, 1.5, NaN])
    assert.throws(() => savePanelSettings(directory, { trustedDeviceTtlDays: value }))
  fs.writeFileSync(path.join(directory, "auth-sessions.json"), "not JSON")
  assert.throws(() => new PanelAuth(() => loadPanelSettings(directory), directory), { status: 500 })
})

test("失败记录占满时淘汰最早记录，新地址仍可登录", t => {
  const { auth } = fixture(t)
  const code = auth.requestCode()
  for (let index = 0; index < 1100; index++)
    assert.throws(() => auth.checkCode("wrong", `flood-${index}`), { status: 401 })
  assert.ok(auth.checkCode(code, "administrator"))
})
