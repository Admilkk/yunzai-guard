import assert from "node:assert/strict"
import test from "node:test"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import http from "node:http"
import { once } from "node:events"
import { createHash } from "node:crypto"
import { spawnSync } from "node:child_process"
import { compareVersions, parseVersion } from "../dist/shared/version.js"
import { parseSettings } from "../dist/config/index.js"
import { planSettingsUpdate } from "../dist/config/update.js"
import { crossesMajor, isNewer, parseRelease } from "../dist/update/release.js"
import { assetName, checksumFor, stageRelease, swapPackage } from "../dist/update/install.js"
import { pendingDue, UpdateService } from "../dist/host/update.js"

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "guard-update-"))
const write = (file, text) => {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, text)
}

test("versions compare as semver with prerelease ordering", () => {
  assert.ok(compareVersions("1.0.1", "1.0.0") > 0)
  assert.ok(compareVersions("v1.10.0", "1.9.9") > 0)
  assert.ok(compareVersions("1.0.0", "1.0.0-rc.1") > 0)
  assert.ok(compareVersions("1.0.0-alpha.2", "1.0.0-alpha.10") < 0)
  assert.equal(compareVersions("1.0.0", "1.0.0"), 0)
  assert.equal(compareVersions("1.0", "1.0.0"), undefined)
  assert.equal(parseVersion("x"), undefined)
  assert.equal(isNewer("1.0.1", "1.0.0"), true)
  assert.equal(isNewer("garbage", "1.0.0"), false)
  assert.equal(crossesMajor("2.0.0", "1.9.0"), true)
  assert.equal(crossesMajor("1.1.0", "1.0.0"), false)
})

test("update settings default to a five minute check and apply live", () => {
  const settings = parseSettings({})
  assert.deepEqual(
    { ...settings.update },
    {
      check: true,
      notify: true,
      intervalMs: 300000,
      workerRestart: "idle",
      idleSeconds: 60,
      maxWaitHours: 6,
      window: "03:00-06:00",
    },
  )
  assert.throws(() => parseSettings({ update: { workerRestart: "later" } }))
  assert.throws(() => parseSettings({ update: { window: "3-6" } }))
  assert.equal(parseSettings({ update: { window: "23:00-02:00" } }).update.window, "23:00-02:00")
  assert.throws(() => parseSettings({ update: { intervalMs: 1000 } }))
  assert.throws(() => parseSettings({ update: { unknown: 1 } }))
  const plan = planSettingsUpdate(settings, parseSettings({ update: { check: false } }))
  assert.deepEqual(plan.liveFields, ["update"])
  assert.deepEqual(plan.reloadFields, [])
  assert.equal(plan.live.update.check, false)
})

test("release info only accepts download links from this repository", () => {
  const base = {
    tag_name: "v1.2.3",
    name: "1.2.3",
    body: "notes",
    published_at: "2026-01-01T00:00:00Z",
  }
  const good = "https://github.com/Admilkk/yunzai-guard/releases/download/v1.2.3/a.zip"
  const release = parseRelease({
    ...base,
    assets: [
      { name: "a.zip", browser_download_url: good, size: 1 },
      { name: "evil.zip", browser_download_url: "https://example.com/evil.zip", size: 1 },
    ],
  })
  assert.equal(release.version, "1.2.3")
  assert.deepEqual(
    release.assets.map(item => item.name),
    ["a.zip"],
  )
  assert.throws(() => parseRelease({ ...base, tag_name: "nightly" }))
  assert.throws(() => parseRelease({ ...base, draft: true }))
})

test("asset names and checksum lines follow the packaging script", () => {
  assert.equal(assetName("1.2.3", "win32", "x64"), "yunzai-guard-v1.2.3-win-x64.zip")
  assert.equal(assetName("1.2.3", "linux", "x64"), "yunzai-guard-v1.2.3-linux-x64.tar.gz")
  assert.equal(assetName("1.2.3", "darwin", "arm64"), "yunzai-guard-v1.2.3-macos.tar.gz")
  assert.equal(assetName("1.2.3", "freebsd", "x64"), undefined)
  assert.equal(assetName("1.2.3", "linux", "arm64"), undefined)
  const hash = "a".repeat(64)
  const text = `${hash}  yunzai-guard-v1.2.3-linux-x64.tar.gz\r\n${"b".repeat(64)}  other\n`
  assert.equal(checksumFor(text, "yunzai-guard-v1.2.3-linux-x64.tar.gz"), hash)
  assert.equal(checksumFor(text, "missing"), undefined)
})

test("swap replaces managed files, keeps the rest, and rolls back", () => {
  const plugin = tmp()
  const staged = tmp()
  write(path.join(plugin, "package.json"), '{"version":"1.0.0"}')
  write(path.join(plugin, "dist", "old.js"), "old")
  write(path.join(plugin, "notes.txt"), "keep")
  write(path.join(plugin, ".cache", "dependencies", "node.exe"), "cache")
  write(path.join(plugin, "node_modules", "pkg", "index.js"), "dep")
  write(path.join(plugin, "runtime", "node-a", "node.exe"), "running")
  write(path.join(staged, "package.json"), '{"version":"1.1.0"}')
  write(path.join(staged, "dist", "new.js"), "new")
  write(path.join(staged, "runtime", "node-a", "node.exe"), "replacement")
  write(path.join(staged, "runtime", "node-b", "node.exe"), "added")
  const handle = swapPackage({ version: "1.1.0", directory: staged }, plugin)
  assert.equal(fs.existsSync(path.join(plugin, "dist", "new.js")), true)
  assert.equal(fs.existsSync(path.join(plugin, "dist", "old.js")), false)
  assert.equal(fs.readFileSync(path.join(plugin, "notes.txt"), "utf8"), "keep")
  assert.equal(
    fs.readFileSync(path.join(plugin, ".cache", "dependencies", "node.exe"), "utf8"),
    "cache",
  )
  assert.equal(fs.readFileSync(path.join(plugin, "node_modules", "pkg", "index.js"), "utf8"), "dep")
  assert.equal(
    fs.readFileSync(path.join(plugin, "runtime", "node-a", "node.exe"), "utf8"),
    "running",
  )
  assert.equal(fs.existsSync(path.join(plugin, "runtime", "node-b", "node.exe")), true)
  handle.rollback()
  assert.equal(fs.readFileSync(path.join(plugin, "package.json"), "utf8"), '{"version":"1.0.0"}')
  assert.equal(fs.existsSync(path.join(plugin, "dist", "old.js")), true)
  assert.equal(fs.existsSync(path.join(plugin, "dist", "new.js")), false)
  assert.equal(fs.existsSync(path.join(plugin, "runtime", "node-b")), false)
})

/** 用系统 tar 构造与平台匹配的发布包。 */
function buildArchive(directory, version, manifest = { name: "yunzai-guard", version }) {
  const content = path.join(directory, "src", "yunzai-guard")
  write(path.join(content, "package.json"), JSON.stringify(manifest))
  for (const file of ["index.js", "dist/launcher.js", "dist/entry/plugin.js", "dist/cli.js"])
    write(path.join(content, file), "// stub")
  const name = assetName(version)
  const archive = path.join(directory, name)
  const tar =
    process.platform === "win32"
      ? path.join(process.env.SystemRoot ?? "C:/Windows", "System32", "tar.exe")
      : "tar"
  const result = spawnSync(tar, [
    "-a",
    "-cf",
    archive,
    "-C",
    path.join(directory, "src"),
    "yunzai-guard",
  ])
  assert.equal(result.status, 0, String(result.stderr))
  return { name, archive }
}

/** 启动本地发布服务器，提供包与校验和。 */
async function serve(files) {
  const server = http.createServer((request, response) => {
    const body = files[request.url.slice(1)]
    if (!body) return response.writeHead(404).end()
    response.writeHead(200).end(body)
  })
  server.listen(0, "127.0.0.1")
  await once(server, "listening")
  return { server, base: `http://127.0.0.1:${server.address().port}` }
}

test(
  "stageRelease verifies the checksum and package contents",
  { skip: !assetName("1.0.0") },
  async () => {
    const work = tmp()
    const plugin = tmp()
    const { name, archive } = buildArchive(work, "9.9.9")
    const bytes = fs.readFileSync(archive)
    const sha = createHash("sha256").update(bytes).digest("hex")
    const { server, base } = await serve({
      [name]: bytes,
      "SHA256SUMS.txt": `${sha}  ${name}\n`,
      "BAD.txt": `${"0".repeat(64)}  ${name}\n`,
    })
    const release = sums => ({
      tag: "v9.9.9",
      version: "9.9.9",
      name: "9.9.9",
      notes: "",
      url: "",
      publishedAt: "",
      assets: [
        { name, url: `${base}/${name}`, size: bytes.length },
        { name: "SHA256SUMS.txt", url: `${base}/${sums}`, size: 1 },
      ],
    })
    try {
      const staged = await stageRelease(release("SHA256SUMS.txt"), plugin, "1.0.0")
      assert.equal(staged.version, "9.9.9")
      assert.equal(fs.existsSync(path.join(staged.directory, "dist", "launcher.js")), true)
      await assert.rejects(stageRelease(release("BAD.txt"), plugin, "1.0.0"), /SHA-256/)
      assert.equal(fs.existsSync(path.join(plugin, "dist")), false)
      await assert.rejects(
        stageRelease({ ...release("SHA256SUMS.txt"), version: "9.9.8" }, plugin, "1.0.0"),
        /发布中缺少/,
      )
    } finally {
      server.close()
    }
  },
)

test("release discovery falls back on rate limits and bounds streamed metadata", async () => {
  const { fetchLatestRelease } = await import("../dist/update/release.js")
  const original = globalThis.fetch
  globalThis.fetch = async url =>
    String(url).startsWith("https://api.github.com/")
      ? new Response("{}", { status: 403, headers: { "x-ratelimit-remaining": "0" } })
      : new Response(null, {
          status: 302,
          headers: { location: "https://github.com/Admilkk/yunzai-guard/releases/tag/v1.4.0" },
        })
  try {
    const { release } = await fetchLatestRelease("1.0.0")
    assert.equal(release.version, "1.4.0")
    assert.ok(release.assets.some(item => item.name === "SHA256SUMS.txt"))
    assert.ok(
      release.assets.every(item =>
        item.url.startsWith("https://github.com/Admilkk/yunzai-guard/releases/download/v1.4.0/"),
      ),
    )
    globalThis.fetch = async () => new Response("{}", { status: 403 })
    await assert.rejects(fetchLatestRelease("1.0.0"), /HTTP 403/)
    let reads = 0
    let cancelled = false
    globalThis.fetch = async url =>
      String(url).startsWith("https://api.github.com/")
        ? new Response(
            new ReadableStream({
              pull(controller) {
                controller.enqueue(new Uint8Array(256 * 1024))
                if (++reads === 16) controller.close()
              },
              cancel() {
                cancelled = true
              },
            }),
          )
        : new Response("{}", { status: 403 })
    await assert.rejects(fetchLatestRelease("1.0.0"), /过大/)
    assert.ok(reads < 16)
    assert.equal(cancelled, true)
  } finally {
    globalThis.fetch = original
  }
})

test("failed fresh checks do not install cached releases and can be retried", async t => {
  const plugin = tmp()
  const stateDir = path.join(plugin, "state")
  write(path.join(plugin, "package.json"), '{"version":"1.0.0"}')
  const tag = "v1.1.0"
  const metadata = {
    tag_name: tag,
    assets: [assetName("1.1.0"), "SHA256SUMS.txt"].map(name => ({
      name,
      browser_download_url: `https://github.com/Admilkk/yunzai-guard/releases/download/${tag}/${name}`,
      size: 1,
    })),
  }
  write(path.join(stateDir, "update.json"), JSON.stringify({ release: parseRelease(metadata) }))
  const calls = []
  t.mock.method(globalThis, "fetch", async url => {
    calls.push(String(url))
    return new Response("{}", { status: 403 })
  })
  const service = new UpdateService({
    pluginDir: plugin,
    stateDir,
    settings: () => parseSettings({}).update,
    send: () => true,
    install() {
      assert.fail("a failed version check must not install cached files")
    },
    record() {},
  })
  const failed = await service.apply(false)
  assert.equal(failed.ok, false)
  assert.match(failed.message, /HTTP 403/)
  assert.equal(calls.length, 2)
  assert.equal(service.state().phase, "failed")
  t.mock.method(globalThis, "fetch", async () => new Response('{"tag_name":"v1.0.0"}'))
  const retried = await service.apply(false)
  assert.equal(retried.ok, false)
  assert.match(retried.message, /已是最新版本/)
})

test("a refused package rollback preserves the previous version for retry", async () => {
  const plugin = tmp()
  const previous = path.join(plugin, ".update", "previous")
  write(path.join(plugin, "package.json"), '{"version":"1.1.0"}')
  write(path.join(previous, "package.json"), '{"version":"1.0.0"}')
  let refuseInstall = true
  let staged
  const service = new UpdateService({
    pluginDir: plugin,
    stateDir: path.join(plugin, "state"),
    settings: () => parseSettings({}).update,
    send: () => true,
    install(value) {
      if (refuseInstall) throw new Error("fixture install refused")
      staged = value
    },
    record() {},
  })
  const refused = await service.rollback()
  assert.equal(refused.ok, false)
  assert.match(refused.message, /fixture install refused/)
  assert.equal(JSON.parse(fs.readFileSync(path.join(previous, "package.json"))).version, "1.0.0")
  refuseInstall = false
  assert.equal((await service.rollback()).ok, true)
  service.swap(staged).commit()
  assert.equal(service.state().current, "1.0.0")
  assert.equal(service.state().rollback?.version, "1.1.0")
})

function deferredService(t) {
  const plugin = tmp()
  t.after(() => fs.rmSync(plugin, { recursive: true, force: true }))
  write(path.join(plugin, "package.json"), '{"version":"1.0.0"}')
  const installs = []
  const sent = []
  let cancelled = 0
  const service = new UpdateService({
    pluginDir: plugin,
    stateDir: path.join(plugin, "state"),
    settings: () => parseSettings({}).update,
    send: text => sent.push(text) > 0,
    install: (...args) => installs.push(args),
    cancelPending: async () => {
      cancelled++
    },
    record() {},
  })
  const staged = {
    version: "1.1.0",
    directory: path.join(plugin, ".update", "staged", "yunzai-guard"),
    plan: { level: "worker", changed: ["dist/worker-preload.js"] },
  }
  return { service, installs, sent, staged, cancelled: () => cancelled }
}

test("等待中的业务侧更新：再次请求更新即马上执行，还原即取消", async t => {
  const { service, installs, sent, staged, cancelled } = deferredService(t)
  service.defer(staged, "1.0.0", false)
  assert.equal(service.state().phase, "pending")
  assert.equal(service.state().pending.version, "1.1.0")
  assert.match(sent.at(-1), /业务侧更新将在空闲时生效，再次发送 #guard更新 可马上生效/)
  // 有等待中的更新时不再联网检查，直接执行等待中的那次。
  const applied = await service.apply(false)
  assert.equal(applied.ok, true)
  assert.deepEqual(installs.at(-1), [staged, "1.0.0", false, true])
  assert.equal(service.state().pending, undefined)
  assert.equal((await service.applyPending()).ok, false)

  service.defer(staged, "1.0.0", false)
  const cancelledResult = await service.rollback()
  assert.equal(cancelledResult.ok, true)
  assert.match(cancelledResult.message, /已取消待生效的更新 1\.1\.0/)
  assert.equal(cancelled(), 1)
  assert.equal(service.state().pending, undefined)
  assert.equal(service.state().phase, "idle")
})

test("更新结果按完成方式说明业务是否中断", t => {
  const { service, sent } = deferredService(t)
  const cases = [
    ["hot", false, /已更新至 1\.1\.0（原 1\.0\.0），业务未中断/],
    ["worker", false, /业务进程已重启/],
    ["relaunch", true, /已还原至 1\.1\.0（原 1\.0\.0），宿主已重新启动/],
    ["host-pending", false, /宿主重启后完全生效/],
  ]
  for (const [mode, rollback, pattern] of cases) {
    service.finish({ ok: true, from: "1.0.0", to: "1.1.0", mode, rollback })
    assert.match(sent.at(-1), pattern)
    assert.equal(service.state().hostRestartPending, mode === "host-pending")
  }
  service.finish({ ok: false, from: "1.0.0", to: "1.1.0", mode: "hot", message: "坏了" })
  assert.match(sent.at(-1), /更新失败：坏了/)
  assert.equal(service.state().phase, "failed")
})

test("宿主重启前的待确认记录累加启动次数并可清除", t => {
  const { service } = deferredService(t)
  assert.equal(service.takeVerify(), undefined)
  service.markVerify({ from: "1.0.0", to: "1.1.0", rollback: false })
  assert.deepEqual(service.takeVerify(), {
    from: "1.0.0",
    to: "1.1.0",
    rollback: false,
    revert: false,
    attempts: 1,
  })
  assert.equal(service.takeVerify().attempts, 2)
  service.clearVerify()
  assert.equal(service.takeVerify(), undefined)
})

test("业务侧更新按配置择时执行", () => {
  const settings = overrides => ({ ...parseSettings({}).update, ...overrides })
  const hour = 3600_000
  const at = (hours, minutes = 0) => new Date(2026, 0, 1, hours, minutes).getTime()
  const base = { since: at(10), lastActivityAt: at(10), now: at(10, 0) }
  assert.equal(pendingDue({ ...base, settings: settings({ workerRestart: "now" }) }), true)
  // idle：最近有插件处理消息时等待，连续空闲达到阈值后执行，超过最长等待则直接执行。
  const idle = settings({ idleSeconds: 60, maxWaitHours: 6 })
  assert.equal(pendingDue({ ...base, settings: idle, now: at(10, 0) + 30_000 }), false)
  assert.equal(pendingDue({ ...base, settings: idle, now: at(10, 1) }), true)
  assert.equal(
    pendingDue({ ...base, settings: idle, lastActivityAt: at(15, 59, 30), now: at(16) - 1 }),
    false,
  )
  assert.equal(
    pendingDue({ ...base, settings: idle, lastActivityAt: at(16), now: base.since + 6 * hour }),
    true,
  )
  const window = settings({ workerRestart: "window", window: "03:00-06:00" })
  assert.equal(pendingDue({ ...base, settings: window, now: at(4) }), true)
  assert.equal(pendingDue({ ...base, settings: window, now: at(10, 2) + 7 * hour }), false)
})
