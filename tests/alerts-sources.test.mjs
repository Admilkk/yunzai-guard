import assert from "node:assert/strict"
import test from "node:test"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import http from "node:http"
import { once } from "node:events"
import { createHmac } from "node:crypto"
import { spawnSync } from "node:child_process"
import { parseSettings } from "../dist/config/index.js"
import { AlertService } from "../dist/host/alerts.js"
import { SourceWatch, cleanRemote } from "../dist/host/sources.js"

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "guard-alerts-"))

/** 创建告警服务；send 可控，记录所有送达文本。 */
function create(alerts = {}, online = true) {
  const sent = []
  const state = { online }
  const settings = parseSettings({ alerts })
  const directory = tmp()
  const service = new AlertService({
    settings: () => settings,
    stateDir: directory,
    projectId: "test",
    send: text => (state.online ? (sent.push(text), true) : false),
    record() {},
  })
  return { service, sent, state, directory }
}

test("alert history ignores malformed rows without hiding valid alerts", () => {
  const { service, directory } = create()
  service.raise("deny", "有效告警", "保留这条记录")
  const invalid = [null, [], "text", {}, { time: 1, category: "deny", title: null, text: "bad" }]
  fs.appendFileSync(
    path.join(directory, "alerts.jsonl"),
    invalid.map(value => JSON.stringify(value)).join("\n") + "\n{partial\n",
  )
  assert.equal(service.history().length, 1)
  assert.equal(service.history()[0].text, "保留这条记录")
  service.stop()
})

test("deny and restart events become alerts and repeated ones are merged", () => {
  const { service, sent } = create()
  const event = {
    action: "deny",
    plugin: "demo",
    kind: "network",
    operation: "fetch",
    target: "https://x.test/",
    ruleId: "r1",
  }
  service.onEvent(event)
  service.onEvent(event)
  service.onEvent(event)
  service.onEvent({ ...event, action: "audit" })
  assert.equal(sent.length, 1)
  assert.match(sent[0], /已拦截 demo：网络访问 https:\/\/x\.test\/（规则 r1）/)
  service.onEvent({ ...event, action: "restart", ruleId: "r2" })
  assert.equal(sent.length, 2)
  assert.match(sent[1], /重启规则 r2/)
  assert.equal(service.history().length, 2)
  service.stop()
})

test("the per-window cap suppresses extra alerts and categories can be switched off", () => {
  const { service, sent } = create({ throttle: { maxPerWindow: 2 }, on: { tripped: false } })
  for (let index = 0; index < 5; index++) service.raise("integrity", `t${index}`, `完整性 ${index}`)
  assert.equal(sent.length, 2)
  service.raise("tripped", "x", "熔断")
  assert.equal(sent.length, 2)
  service.stop()
})

test("alerts wait for the business process and flush when it comes online", () => {
  const { service, sent, state } = create({}, false)
  service.raise("anomaly", "a", "第一条")
  service.raise("anomaly", "b", "第二条")
  assert.equal(sent.length, 0)
  state.online = true
  service.flush()
  assert.deepEqual(sent, ["第一条", "第二条"])
  service.stop()
})

test("masters and the whole alert pipeline can be disabled independently", () => {
  const off = create({ enabled: false })
  off.service.raise("deny", "x", "不应送达")
  assert.equal(off.sent.length, 0)
  const quiet = create({ masters: false })
  quiet.service.raise("deny", "x", "只写历史")
  assert.equal(quiet.sent.length, 0)
  assert.equal(quiet.service.history().length, 1)
})

test("webhook receives signed alerts and batched audit events", async () => {
  const received = []
  const server = http.createServer((request, response) => {
    let body = ""
    request.on("data", chunk => (body += chunk))
    request.on("end", () => {
      received.push({ headers: request.headers, body })
      response.writeHead(204).end()
    })
  })
  server.listen(0, "127.0.0.1")
  await once(server, "listening")
  const url = `http://127.0.0.1:${server.address().port}/hook`
  const { service } = create({
    webhook: { url, secret: "s3cret" },
    forward: { actions: ["deny", "audit"], kinds: ["network"] },
  })
  try {
    const test = await service.testWebhook()
    assert.equal(test.ok, true)
    assert.equal(
      received[0].headers["x-guard-signature"],
      `sha256=${createHmac("sha256", "s3cret").update(received[0].body).digest("hex")}`,
    )
    service.raise("deny", "d", "已拦截一次")
    service.onEvent({
      action: "audit",
      plugin: "p",
      kind: "network",
      operation: "fetch",
      target: "https://a.test/",
    })
    service.onEvent({
      action: "audit",
      plugin: "p",
      kind: "filesystem",
      operation: "fs.writeFile",
      target: "/tmp/x",
    })
    service.stop()
    for (let index = 0; index < 50 && received.length < 3; index++)
      await new Promise(resolve => setTimeout(resolve, 50))
    const types = received.map(item => JSON.parse(item.body).type)
    assert.ok(types.includes("yunzai-guard.alert"))
    const events = JSON.parse(
      received.find(item => JSON.parse(item.body).type === "yunzai-guard.events").body,
    ).events
    assert.equal(events.length, 1)
    assert.equal(events[0].kind, "network")
  } finally {
    server.close()
  }
})

test("webhook settings reject bad URLs and unknown actions", () => {
  assert.throws(() => parseSettings({ alerts: { webhook: { url: "ftp://x" } } }))
  assert.throws(() => parseSettings({ alerts: { forward: { actions: ["nope"] } } }))
  assert.equal(
    parseSettings({ alerts: { webhook: { url: "https://hooks.example.com/x" } } }).alerts.webhook
      .format,
    "json",
  )
})

const hasGit = spawnSync("git", ["--version"]).status === 0

test("remote credentials are stripped from reported addresses", () => {
  assert.equal(cleanRemote("https://user:token@github.com/a/b.git"), "https://github.com/a/b.git")
  assert.equal(
    cleanRemote("https://user:p@ss@github.com/a/b.git?token=private#secret"),
    "https://github.com/a/b.git",
  )
  assert.equal(cleanRemote("git@github.com:a/b.git"), "git@github.com:a/b.git")
})

test("git plugins are scanned and changes are reported", { skip: !hasGit }, async () => {
  const root = tmp()
  const plugins = path.join(root, "plugins")
  const repo = path.join(plugins, "demo-plugin")
  fs.mkdirSync(path.join(plugins, "plain-plugin"), { recursive: true })
  fs.mkdirSync(repo, { recursive: true })
  const git = (...args) =>
    spawnSync("git", ["-c", "user.email=a@b.c", "-c", "user.name=t", ...args], { cwd: repo })
  git("init", "-q")
  git("remote", "add", "origin", "https://user:pw@example.com/org/demo.git")
  fs.writeFileSync(path.join(repo, "index.js"), "export {}\n")
  git("add", ".")
  git("commit", "-q", "-m", "init")
  const changes = []
  const settings = parseSettings({ sources: { notify: { commit: true } } })
  const watch = new SourceWatch({
    pluginsDir: plugins,
    stateDir: path.join(root, "state"),
    settings: () => settings.sources,
    onChange: change => changes.push(change),
  })
  const first = await watch.scan()
  const demo = first.find(item => item.plugin === "demo-plugin")
  assert.equal(demo.git, true)
  assert.equal(demo.remote, "https://example.com/org/demo.git")
  assert.equal(demo.dirty, 0)
  assert.equal(first.find(item => item.plugin === "plain-plugin").git, false)
  assert.deepEqual(changes, [])
  const marker = path.join(root, "host-command-executed")
  const hook = path.join(repo, "hook.cjs")
  fs.writeFileSync(hook, `require("node:fs").writeFileSync(${JSON.stringify(marker)}, "executed");`)
  const command = `"${process.execPath}" "${hook}"`
  fs.writeFileSync(path.join(repo, ".gitattributes"), "index.js filter=probe\n")
  git("config", "core.fsmonitor", command)
  git("config", "filter.probe.clean", command)
  const index = fs.readFileSync(path.join(repo, ".git", "index"))
  fs.writeFileSync(path.join(repo, "index.js"), "export []\n")
  await watch.scan()
  assert.equal(fs.existsSync(marker), false, "来源检查不能执行插件配置中的命令")
  assert.deepEqual(fs.readFileSync(path.join(repo, ".git", "index")), index)
  assert.deepEqual(
    changes.map(item => item.type),
    ["dirty"],
  )
  git("config", "--unset", "core.fsmonitor")
  git("config", "--unset", "filter.probe.clean")
  git("commit", "-q", "-am", "second")
  await watch.scan()
  assert.ok(changes.some(item => item.type === "commit"))
  const worktree = path.join(plugins, "worktree-plugin")
  assert.equal(git("worktree", "add", "-q", "-b", "preview", worktree).status, 0)
  const linked = (await watch.scan()).find(item => item.plugin === "worktree-plugin")
  assert.equal(linked.branch, "preview")
  assert.equal(linked.dirty, 0)
  assert.equal(linked.error, undefined)
})

test("already modified plugins still report further changes", { skip: !hasGit }, async () => {
  const root = tmp()
  const plugins = path.join(root, "plugins")
  const repo = path.join(plugins, "demo-plugin")
  fs.mkdirSync(repo, { recursive: true })
  const git = (...args) =>
    spawnSync("git", ["-c", "user.email=a@b.c", "-c", "user.name=t", ...args], { cwd: repo })
  git("init", "-q")
  git("config", "core.autocrlf", "false")
  fs.writeFileSync(path.join(repo, "配置.js"), "export {}\n")
  fs.writeFileSync(path.join(repo, "index.js"), "export {}\n")
  git("add", ".")
  git("commit", "-q", "-m", "init")
  const changes = []
  const settings = parseSettings({})
  const watch = new SourceWatch({
    pluginsDir: plugins,
    stateDir: path.join(root, "state"),
    settings: () => settings.sources,
    onChange: change => changes.push(change),
  })
  await watch.scan()
  fs.writeFileSync(path.join(repo, "配置.js"), "export const a = 1\n")
  const [first] = await watch.scan()
  assert.deepEqual(first.dirtyFiles, ["配置.js"])
  await watch.scan()
  assert.equal(changes.length, 1)
  fs.writeFileSync(path.join(repo, "index.js"), "export const b = 1\n")
  await watch.scan()
  fs.writeFileSync(path.join(repo, "index.js"), "export const b = 2\n")
  await watch.scan()
  assert.equal(changes.length, 3)
  assert.ok(changes.slice(1).every(item => item.type === "dirty" && item.text.includes("index.js")))
})
