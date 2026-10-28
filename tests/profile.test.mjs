import assert from "node:assert/strict"
import test from "node:test"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { parseSettings } from "../dist/config/index.js"
import { BehaviorProfile, featureOf, severityOf } from "../dist/host/profile.js"

const hour = 3600000
const base = new Date(2026, 0, 5, 12, 0, 0).getTime()

/** 创建画像；覆盖默认配置，时间由测试推进。 */
function create(baseline = {}) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "guard-profile-"))
  const settings = parseSettings({ baseline: { enabled: true, learnHours: 24, ...baseline } })
  let now = base
  const profile = new BehaviorProfile({
    file: path.join(directory, "profiles.json"),
    settings: () => settings.baseline,
    clock: () => now,
  })
  return {
    profile,
    directory,
    advance: ms => (now += ms),
    event: (target, extra = {}) =>
      profile.observe({
        plugin: "demo",
        kind: "network",
        operation: "fetch",
        target,
        time: now,
        ...extra,
      }),
  }
}

test("events fold into stable features and severity follows capability", () => {
  assert.deepEqual(featureOf({ kind: "network", target: "https://Api.Example.com:8443/x?y=1" }), {
    kind: "network",
    key: "api.example.com",
  })
  assert.deepEqual(featureOf({ kind: "listen", target: "tcp://127.0.0.1:18088" }), {
    kind: "listen",
    key: "端口 18088",
  })
  assert.deepEqual(featureOf({ kind: "process", target: "C:\\Windows\\System32\\cmd.exe" }), {
    kind: "process",
    key: "cmd",
  })
  assert.deepEqual(featureOf({ kind: "filesystem", target: "D:\\bot\\data\\a\\b.json" }), {
    kind: "filesystem",
    key: "D:/bot/data/a",
  })
  assert.equal(featureOf({ kind: "plugin", target: "x" }), undefined)
  assert.equal(severityOf("native", "x"), "high")
  assert.equal(severityOf("process", "bash"), "high")
  assert.equal(severityOf("process", "git"), "medium")
  assert.equal(severityOf("network", "1.2.3.4"), "high")
  assert.equal(severityOf("network", "example.com"), "medium")
  assert.equal(severityOf("filesystem", "/home/u/.ssh"), "high")
})

test("learning period records silently, then new targets are reported once", () => {
  const t = create()
  assert.deepEqual(t.event("https://a.example.com/"), [])
  t.advance(2 * hour)
  assert.deepEqual(t.event("https://b.example.com/"), [])
  assert.equal(t.profile.detail("demo").features.length, 2)
  t.advance(30 * hour)
  assert.deepEqual(t.event("https://a.example.com/"), [])
  const found = t.event("https://evil.example.net/")
  assert.equal(found.length, 1)
  assert.equal(found[0].type, "new-target")
  assert.equal(found[0].severity, "medium")
  assert.deepEqual(t.event("https://evil.example.net/"), [])
})

test("learnAfterAlert off keeps reporting until the target is trusted", () => {
  const t = create({ learnAfterAlert: false })
  t.event("https://a.example.com/")
  t.advance(30 * hour)
  assert.equal(t.event("https://new.example.com/").length, 1)
  assert.equal(t.event("https://new.example.com/").length, 1)
  assert.equal(t.profile.trust("demo", "network", "new.example.com"), true)
  assert.equal(t.event("https://new.example.com/").length, 0)
  assert.equal(t.profile.forget("demo", "network", "new.example.com"), true)
  assert.equal(t.event("https://new.example.com/").length, 1)
})

test("manual end of learning, ignore lists and disabled kinds are honoured", () => {
  const t = create({
    ignore: ["network:*.cdn.example.com"],
    ignorePlugins: ["quiet-*"],
    kinds: ["network"],
  })
  t.event("https://a.example.com/")
  assert.equal(t.profile.endLearning("demo"), 1)
  assert.equal(t.event("https://b.example.com/").length, 1)
  assert.deepEqual(t.event("https://x.cdn.example.com/"), [])
  assert.deepEqual(t.event("https://a.example.com/", { plugin: "quiet-one" }), [])
  assert.deepEqual(t.event("/tmp/a/b.txt", { kind: "filesystem" }), [])
  assert.deepEqual(t.event("x", { plugin: "unknown" }), [])
})

test("a burst of new targets raises one high severity alert", () => {
  const t = create({ burst: { count: 4, windowMs: 600000 } })
  t.event("https://a.example.com/")
  t.profile.endLearning("demo")
  const types = []
  for (let index = 0; index < 6; index++) {
    t.advance(1000)
    for (const item of t.event(`https://n${index}.example.com/`))
      types.push(`${item.type}:${item.severity}`)
  }
  assert.equal(types.filter(item => item === "burst:high").length, 1)
  assert.equal(types.filter(item => item.startsWith("new-target")).length, 6)
})

test("rate spikes are judged against the plugin's own history", () => {
  const t = create({ learnHours: 1, spike: { minCount: 20, zScore: 3, windowMs: 60000 } })
  for (let window = 0; window < 12; window++) {
    for (let count = 0; count < 5; count++) t.event("https://a.example.com/")
    t.advance(60000)
  }
  t.advance(2 * hour)
  t.profile.tick(base + 2 * hour)
  let spike
  for (let count = 0; count < 200; count++) t.event("https://a.example.com/")
  t.advance(61000)
  spike = t.profile.tick(base + 2 * hour + 12 * 60000 + 61000 + 1)
  const all = [...spike, ...t.profile.tick()]
  assert.ok(
    all.some(item => item.type === "rate-spike"),
    "expected a spike alert",
  )
})

test("off-hours activity is flagged only after enough learning", () => {
  const t = create({ learnHours: 48 })
  for (let day = 0; day < 2; day++) {
    for (let index = 0; index < 30; index++) t.event("https://a.example.com/")
    t.advance(24 * hour)
  }
  t.profile.endLearning("demo")
  const night = new Date(2026, 0, 8, 3, 0, 0).getTime()
  const found = t.profile.observe({
    plugin: "demo",
    kind: "network",
    operation: "fetch",
    target: "https://a.example.com/",
    time: night,
  })
  assert.ok(found.some(item => item.type === "off-hours"))
  assert.equal(
    t.profile
      .observe({
        plugin: "demo",
        kind: "network",
        operation: "fetch",
        target: "https://a.example.com/",
        time: night + 1000,
      })
      .some(item => item.type === "off-hours"),
    false,
  )
})

test("risk grows with capability and persistence survives a restart", () => {
  const t = create()
  t.event("https://a.example.com/")
  t.event("/opt/x/y.node", { kind: "native" })
  t.event("tcp://0.0.0.0:9000", { kind: "listen" })
  const risk = t.profile.summary().plugins[0].risk
  assert.ok(risk.score >= 40, `score ${risk.score}`)
  t.profile.flush()
  const reload = new BehaviorProfile({
    file: path.join(t.directory, "profiles.json"),
    settings: () => parseSettings({ baseline: { enabled: true } }).baseline,
  })
  assert.equal(reload.detail("demo").features.length, 3)
  reload.reset("demo")
  assert.equal(reload.detail("demo"), undefined)
})

test("prototype-named plugins have independent profiles across restart and reset", () => {
  const t = create()
  const names = ["constructor", "__proto__", "toString"]
  for (const plugin of names) t.event("https://a.example.com/", { plugin })
  t.profile.flush()
  const reload = new BehaviorProfile({
    file: path.join(t.directory, "profiles.json"),
    settings: () => parseSettings({ baseline: { enabled: true } }).baseline,
  })
  assert.equal(reload.summary().plugins.length, names.length)
  for (const plugin of names) assert.equal(reload.detail(plugin).total, 1)
  reload.reset()
  for (const plugin of names) assert.equal(reload.detail(plugin), undefined)
  assert.deepEqual(
    reload.observe({ plugin: "constructor", kind: "network", target: "https://a.example.com/" }),
    [],
  )
  assert.equal(reload.detail("constructor").total, 1)
  reload.flush()
})

test("corrupt saved profile entries are skipped while valid plugin history survives", () => {
  const t = create()
  t.event("https://a.example.com/")
  t.profile.flush()
  const file = path.join(t.directory, "profiles.json")
  const saved = JSON.parse(fs.readFileSync(file, "utf8"))
  saved.plugins.empty = null
  for (const field of ["hourly", "features", "rates", "days", "anomalies", "cooldown"])
    saved.plugins[field] = { ...saved.plugins.demo, [field]: null }
  saved.plugins.badFeature = { ...saved.plugins.demo, features: { "network|x": null } }
  saved.plugins.badRate = { ...saved.plugins.demo, rates: { network: {} } }
  saved.plugins.badAnomaly = { ...saved.plugins.demo, anomalies: [null] }
  fs.writeFileSync(file, JSON.stringify(saved))
  const reload = new BehaviorProfile({
    file,
    settings: () => parseSettings({ baseline: { enabled: true } }).baseline,
  })
  assert.deepEqual(
    reload.summary().plugins.map(item => item.plugin),
    ["demo"],
  )
  assert.equal(reload.detail("demo").features.length, 1)
  assert.doesNotThrow(() => reload.tick())
  assert.doesNotThrow(() =>
    reload.observe({ plugin: "demo", kind: "network", target: "https://a.example.com/" }),
  )
  reload.flush()
})
