import assert from "node:assert/strict"
import fs from "node:fs"
import net from "node:net"
import os from "node:os"
import path from "node:path"
import test from "node:test"
import { GuardPanel } from "../dist/web/server.js"
import { parseSettings } from "../dist/config/index.js"
import { renderSettings } from "../dist/config/settings-file.js"
import { SettingsController } from "../dist/host/settings.js"
import { savePanelSettings } from "../dist/web/panel-settings.js"
import { sha256 } from "../dist/shared/hash.js"
import { writeSettingsDocument, readSettingsDocument } from "../dist/web/guard-settings.js"
import {
  applySettingsOperation,
  listSettingsOperations,
  previewSettingsOperation,
} from "../dist/web/settings-history.js"

async function fixture(t) {
  const temporaryRoot = fs.realpathSync(os.tmpdir())
  const root = fs.mkdtempSync(path.join(temporaryRoot, "guard-operations-"))
  const stateDir = path.join(root, "data/yunzai-guard")
  fs.mkdirSync(stateDir, { recursive: true })
  const initial = parseSettings({ alerts: { webhook: { secret: "original-private-secret" } } })
  const original = "# original operation comment\n" + renderSettings(initial)
  fs.writeFileSync(path.join(stateDir, "settings.yaml"), original)
  let failure = false
  let onApply
  const controller = new SettingsController(initial, {
    prepare: async () => {},
    applyLive: async () => {
      if (failure) throw new Error("apply fixture failed")
    },
    reload: async () => {
      if (failure) throw new Error("reload fixture failed")
    },
  })
  const probe = net.createServer()
  await new Promise(resolve => probe.listen(0, "127.0.0.1", resolve))
  const port = probe.address().port
  await new Promise(resolve => probe.close(resolve))
  savePanelSettings(stateDir, { host: "127.0.0.1", port })
  let panel
  const start = async () => {
    panel = new GuardPanel({
      root,
      stateDir,
      settings: initial,
      version: "test",
      getSettings: () => controller.active,
      configuration: () => controller.state,
      applySettings: next => {
        const state = controller.request(next)
        onApply?.()
        return state
      },
      status: () => ({ phase: "online", generation: 1 }),
      restart() {},
      resume() {},
    })
    assert.equal(await panel.start(), true)
  }
  await start()
  t.after(async () => {
    await panel.stop()
    assert.equal(path.dirname(root), temporaryRoot)
    fs.rmSync(root, { recursive: true, force: true })
  })
  let session
  const request = async (route, body, method = body === undefined ? "GET" : "POST") => {
    const response = await fetch(`http://127.0.0.1:${port}${route}`, {
      method,
      signal: AbortSignal.timeout(5000),
      headers: {
        Connection: "close",
        ...(session ? { Cookie: session.cookie, "x-guard-csrf": session.csrf } : {}),
        ...(body ? { "Content-Type": "application/json" } : {}),
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
    })
    return { status: response.status, headers: response.headers, body: await response.json() }
  }
  const login = async () => {
    const token = panel.loginLink().urls[0].split("#login=")[1]
    const result = await request("/api/login/link", { token })
    assert.equal(result.status, 200)
    session = {
      cookie: result.headers.get("set-cookie").split(";")[0],
      csrf: result.body.csrfToken,
    }
  }
  await login()
  const current = async () => (await request("/api/settings")).body
  const save = async (change, title = "fixture save") => {
    const before = await current()
    const document = structuredClone(before.normalized)
    change(document)
    return request("/api/settings", { document, title, revision: before.revision }, "PUT")
  }
  return {
    root,
    stateDir,
    initial,
    original,
    controller,
    current,
    save,
    request,
    fail: value => {
      failure = value
    },
    onApply: action => {
      onApply = action
    },
    restart: async () => {
      await panel.stop()
      await start()
      await login()
    },
  }
}

test("操作记录跨面板重启保留，并核对真实应用状态及密钥脱敏", async t => {
  const app = await fixture(t)
  const saved = await app.save(document => {
    document.alerts.webhook.secret = "changed-private-secret"
  }, "修改通知")
  assert.equal(saved.status, 200)
  assert.equal(saved.body.operation.status, "applying")
  await app.controller.applyPending()
  await app.current()
  await app.restart()
  const listed = (await app.request("/api/settings/operations")).body
  assert.equal(listed.operations[0].id, saved.body.operation.id)
  assert.equal(listed.operations[0].status, "applied")
  assert.equal(listed.operations[0].canUndo, true)
  assert.equal(listed.lastAppliedId, saved.body.operation.id)
  for (const secret of ["original-private-secret", "changed-private-secret"]) {
    assert.equal(JSON.stringify(listed).includes(secret), false)
    assert.equal(
      fs.readFileSync(path.join(app.stateDir, "settings-operations.json"), "utf8").includes(secret),
      false,
    )
  }
  const preview = await app.request("/api/settings/operations/preview", {
    id: saved.body.operation.id,
    revision: (await app.current()).revision,
  })
  assert.equal(preview.status, 200)
  assert.equal(JSON.stringify(preview.body.changes).includes("private-secret"), false)
  assert.equal(preview.body.raw, app.original)
  const restored = await app.request("/api/settings/operations/restore", {
    id: saved.body.operation.id,
    revision: preview.body.revision,
    previewToken: preview.body.previewToken,
  })
  assert.equal(restored.status, 200)
  assert.equal(fs.readFileSync(path.join(app.stateDir, "settings.yaml"), "utf8"), app.original)
})

test("旧操作恢复须预览后续差异，过期预览或配置版本不能覆盖新修改", async t => {
  const app = await fixture(t)
  const first = await app.save(document => {
    document.alerts.enabled = false
  }, "关闭通知")
  await app.controller.applyPending()
  await app.current()
  const second = await app.save(document => {
    document.recovery.maxRestarts++
  }, "修改恢复")
  await app.controller.applyPending()
  const current = await app.current()
  const body = { id: first.body.operation.id, revision: current.revision }
  assert.equal((await app.request("/api/settings/operations/restore", body)).status, 409)
  const preview = (await app.request("/api/settings/operations/preview", body)).body
  assert.equal(preview.hasLaterChanges, true)
  fs.appendFileSync(path.join(app.stateDir, "settings.yaml"), "\n# concurrent change\n")
  assert.equal(
    (
      await app.request("/api/settings/operations/restore", {
        ...body,
        previewToken: preview.previewToken,
      })
    ).status,
    409,
  )
  const afterConcurrent = await app.current()
  assert.equal(
    (
      await app.request("/api/settings/operations/restore", {
        ...body,
        revision: afterConcurrent.revision,
        previewToken: preview.previewToken,
      })
    ).status,
    409,
  )
  assert.match((await app.current()).text, /concurrent change/)
  const nextPreview = (
    await app.request("/api/settings/operations/preview", {
      ...body,
      revision: afterConcurrent.revision,
    })
  ).body
  assert.equal(
    (
      await app.request("/api/settings/operations/restore", {
        ...body,
        revision: nextPreview.revision,
        previewToken: nextPreview.previewToken,
      })
    ).status,
    200,
  )
  assert.equal((await app.current()).text, app.original)
  assert.notEqual(second.body.operation.id, first.body.operation.id)
})

test("最新撤销也必须先预览，凭据不能跨恢复目标复用", async t => {
  const app = await fixture(t)
  const saved = await app.save(document => {
    document.alerts.enabled = false
  })
  await app.controller.applyPending()
  const current = await app.current()
  const body = { id: saved.body.operation.id, revision: current.revision }
  assert.equal((await app.request("/api/settings/operations/restore", body)).status, 409)
  const preview = (await app.request("/api/settings/operations/preview", body)).body
  assert.equal(preview.hasLaterChanges, false)
  assert.equal(
    (
      await app.request("/api/settings/operations/restore", {
        ...body,
        target: "after",
        previewToken: preview.previewToken,
      })
    ).status,
    409,
  )
  assert.equal((await app.current()).revision, current.revision)
  assert.equal(
    (
      await app.request("/api/settings/operations/restore", {
        ...body,
        previewToken: preview.previewToken,
      })
    ).status,
    200,
  )
})

test("预览期间活动配置变更后，原凭据不能确认不同的重启计划", async t => {
  const app = await fixture(t)
  const good = await app.save(document => {
    document.alerts.enabled = false
  }, "已应用版本")
  await app.controller.applyPending()
  await app.current()
  await app.save(document => {
    document.rules.push({ id: "pending-rule", kind: "network", action: "deny" })
  }, "应用中的规则")
  const current = await app.current()
  const body = { id: good.body.operation.id, target: "after", revision: current.revision }
  const preview = (await app.request("/api/settings/operations/preview", body)).body
  assert.deepEqual(preview.plan.reloadFields, [])
  await app.controller.applyPending()
  assert.equal((await app.current()).revision, current.revision)
  assert.equal(
    (
      await app.request("/api/settings/operations/restore", {
        ...body,
        previewToken: preview.previewToken,
      })
    ).status,
    409,
  )
  const fresh = (await app.request("/api/settings/operations/preview", body)).body
  assert.deepEqual(fresh.plan.reloadFields, ["rules"])
  assert.notEqual(fresh.previewToken, preview.previewToken)
  assert.equal(
    (
      await app.request("/api/settings/operations/restore", {
        ...body,
        previewToken: fresh.previewToken,
      })
    ).status,
    200,
  )
})

test("应用回调期间外部修改文件后，保存响应不再报告可直接撤销", async t => {
  const app = await fixture(t)
  app.onApply(() =>
    fs.appendFileSync(path.join(app.stateDir, "settings.yaml"), "\n# external after write\n"),
  )
  const saved = await app.save(document => {
    document.alerts.enabled = false
  })
  assert.equal(saved.status, 200)
  assert.equal(saved.body.operation.canUndo, false)
  assert.equal(saved.body.operation.revision, saved.body.revision)
  const current = await app.current()
  assert.notEqual(current.revision, saved.body.revision)
  assert.equal((await app.request("/api/settings/operations")).body.operations[0].canUndo, false)
  assert.match(current.text, /external after write/)
})

test("旧备份恢复和规则导入也关联实际应用代次，失败不会保持未确认", async t => {
  const app = await fixture(t)
  await app.save(document => {
    document.alerts.enabled = false
  })
  await app.controller.applyPending()
  const before = await app.current()
  const backups = (await app.request("/api/settings/backups")).body.backups
  app.fail(true)
  const restored = await app.request("/api/settings/restore", {
    id: backups[0].id,
    revision: before.revision,
  })
  assert.equal(restored.status, 200)
  assert.equal(restored.body.operation.status, "applying")
  await app.controller.applyPending()
  const imported = await app.request("/api/settings/import-rules", {
    rules: [{ id: "imported", kind: "network", action: "deny" }],
    revision: restored.body.revision,
  })
  assert.equal(imported.status, 200)
  assert.equal(imported.body.operation.status, "applying")
  await app.controller.applyPending()
  const history = (await app.request("/api/settings/operations")).body.operations
  assert.equal(history.find(item => item.id === restored.body.operation.id).status, "failed")
  assert.equal(history.find(item => item.id === imported.body.operation.id).status, "failed")
})

test("待办确认缺少配置版本时返回 400", async t => {
  const app = await fixture(t)
  assert.equal((await app.request("/api/tasks/ack", { ids: ["a".repeat(64)] })).status, 400)
})

test("失败和被后续请求替代的应用不会被标记为成功", async t => {
  const app = await fixture(t)
  const first = await app.save(document => {
    document.alerts.enabled = false
  })
  const second = await app.save(document => {
    document.recovery.maxRestarts++
  })
  app.fail(true)
  await app.controller.applyPending()
  const listed = (await app.request("/api/settings/operations")).body
  assert.equal(
    listed.operations.find(item => item.id === first.body.operation.id).status,
    "unknown",
  )
  assert.equal(
    listed.operations.find(item => item.id === second.body.operation.id).status,
    "failed",
  )
  assert.equal(listed.lastAppliedId, undefined)
  assert.equal(
    (
      await app.request("/api/settings/operations/preview", {
        id: second.body.operation.id,
        target: "after",
        revision: (await app.current()).revision,
      })
    ).status,
    400,
  )
})

test("只恢复已确认应用成功的配置；恢复前返回实际业务重启计划", async t => {
  const app = await fixture(t)
  const good = await app.save(document => {
    document.alerts.enabled = false
  }, "通知配置")
  await app.controller.applyPending()
  await app.current()
  await app.save(document => {
    document.rules.push({ id: "deny-test", kind: "network", action: "deny" })
  }, "新规则")
  const preview = await app.request("/api/settings/operations/preview", {
    id: good.body.operation.id,
    target: "after",
    revision: (await app.current()).revision,
  })
  assert.equal(preview.status, 200)
  // 当前活动快照仍是已成功的通知配置，恢复它不需要重启业务。
  assert.deepEqual(preview.body.plan.reloadFields, [])
  assert.equal(preview.body.document.alerts.enabled, false)
  assert.equal(preview.body.document.rules.length, 0)
})

test("失败配置原值重试复用原操作，刷新后仍可撤销真实修改并保留注释", async t => {
  const app = await fixture(t)
  app.fail(true)
  const changed = await app.save(document => {
    document.rules.push({ id: "retry-rule", kind: "network", action: "deny" })
  }, "限制联网")
  assert.equal(changed.status, 200)
  await app.controller.applyPending()
  await app.current()
  const beforeRetry = (await app.request("/api/settings/operations")).body.operations
  assert.equal(beforeRetry.length, 1)
  assert.equal(beforeRetry[0].status, "failed")
  const backups = fs.readdirSync(path.join(app.stateDir, "settings-history"))
  const snapshots = fs.readdirSync(path.join(app.stateDir, "settings-operation-snapshots"))
  app.fail(false)
  const retried = await app.save(() => {}, "重试应用")
  assert.equal(retried.status, 200)
  assert.equal(retried.body.revision, changed.body.revision)
  assert.equal(retried.body.operation.id, changed.body.operation.id)
  assert.equal(retried.body.operation.title, "限制联网")
  assert.equal(retried.body.operation.time, changed.body.operation.time)
  assert.equal(retried.body.operation.beforeRevision, changed.body.operation.beforeRevision)
  assert.equal(retried.body.backup, null)
  assert.deepEqual(fs.readdirSync(path.join(app.stateDir, "settings-history")), backups)
  assert.deepEqual(
    fs.readdirSync(path.join(app.stateDir, "settings-operation-snapshots")),
    snapshots,
  )
  await app.controller.applyPending()
  await app.current()
  await app.restart()
  const history = (await app.request("/api/settings/operations")).body
  assert.equal(history.operations.length, 1)
  assert.equal(history.operations[0].status, "applied")
  assert.equal(history.operations[0].canUndo, true)
  const preview = await app.request("/api/settings/operations/preview", {
    id: history.operations[0].id,
    revision: (await app.current()).revision,
  })
  const restored = await app.request("/api/settings/operations/restore", {
    id: history.operations[0].id,
    revision: preview.body.revision,
    previewToken: preview.body.previewToken,
  })
  assert.equal(restored.status, 200)
  assert.equal((await app.current()).text, app.original)
  await app.controller.applyPending()
  assert.deepEqual(app.controller.active.rules, [])
})

test("无历史记录的原值保存不生成零变化撤销项，也不轮转备份", async t => {
  const app = await fixture(t)
  const result = await app.save(() => {})
  assert.equal(result.status, 200)
  assert.equal(result.body.operation, undefined)
  assert.equal(result.body.backup, null)
  assert.deepEqual((await app.request("/api/settings/operations")).body.operations, [])
  assert.equal(fs.existsSync(path.join(app.stateDir, "settings-history")), false)
  assert.equal(fs.existsSync(path.join(app.stateDir, "settings-operation-snapshots")), false)
  assert.equal((await app.current()).text, app.original)
})

test("已有零变化历史不提供撤销", async t => {
  const app = await fixture(t)
  await app.save(document => {
    document.alerts.enabled = false
  })
  const file = path.join(app.stateDir, "settings-operations.json")
  const records = JSON.parse(fs.readFileSync(file, "utf8"))
  records[0].beforeRevision = records[0].revision
  records[0].before = records[0].after
  fs.writeFileSync(file, JSON.stringify(records))
  const listed = (await app.request("/api/settings/operations")).body.operations[0]
  assert.equal(listed.canUndo, false)
  assert.equal(listed.canRestoreBefore, false)
})

test("新宿主可核对应用结果，旧的 superseded 记录保持未知；快照有界且拒绝被改动备份", async t => {
  const app = await fixture(t)
  const first = writeSettingsDocument(app.stateDir, app.initial, {
    ...app.initial,
    alerts: { ...app.initial.alerts, enabled: false },
  })
  const firstState = app.controller.request(
    parseSettings({ ...app.initial, alerts: { ...app.initial.alerts, enabled: false } }),
  )
  applySettingsOperation(app.stateDir, first.operation.id, firstState)
  const second = writeSettingsDocument(app.stateDir, app.initial, {
    ...app.initial,
    recovery: { ...app.initial.recovery, maxRestarts: 9 },
  })
  const secondState = app.controller.request(
    parseSettings({ ...app.initial, recovery: { ...app.initial.recovery, maxRestarts: 9 } }),
  )
  applySettingsOperation(app.stateDir, second.operation.id, secondState)
  await app.controller.applyPending()
  const fresh = await import(`../dist/web/settings-history.js?host=${Date.now()}`)
  const current = readSettingsDocument(app.stateDir, app.controller.active)
  const confirmed = fresh.listSettingsOperations(
    app.stateDir,
    current.text,
    app.controller.active,
    app.controller.state,
  )
  assert.equal(confirmed.operations.find(item => item.id === first.operation.id).status, "unknown")
  assert.equal(confirmed.operations.find(item => item.id === second.operation.id).status, "applied")
  const index = JSON.parse(
    fs.readFileSync(path.join(app.stateDir, "settings-operations.json"), "utf8"),
  )
  const latest = index[0]
  fs.appendFileSync(
    path.join(app.stateDir, "settings-operation-snapshots", latest.after.snapshot),
    "\n# tampered\n",
  )
  assert.throws(
    () =>
      previewSettingsOperation(
        app.stateDir,
        latest.id,
        "after",
        current.text,
        current.normalized,
        app.controller.active,
      ),
    /备份内容已变更/,
  )
  for (let i = 0; i < 35; i++)
    writeSettingsDocument(app.stateDir, app.initial, {
      ...app.initial,
      recovery: { ...app.initial.recovery, maxRestarts: i + 1 },
    })
  assert.equal(
    listSettingsOperations(
      app.stateDir,
      fs.readFileSync(path.join(app.stateDir, "settings.yaml"), "utf8"),
      app.initial,
    ).operations.length,
    30,
  )
  assert.ok(fs.readdirSync(path.join(app.stateDir, "settings-operation-snapshots")).length <= 31)
  assert.equal(fs.readdirSync(path.join(app.stateDir, "settings-history")).length, 30)
})
