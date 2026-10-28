import assert from "node:assert/strict"
import test from "node:test"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { spawnSync } from "node:child_process"
import { parseSettings } from "../dist/config/index.js"
import { UpdateService } from "../dist/host/update.js"
import { fetchRelease, gitBranch } from "../dist/update/git.js"

const hasGit = spawnSync("git", ["--version"]).status === 0
const run = (cwd, ...args) => {
  const result = spawnSync("git", ["-c", "user.email=a@b.c", "-c", "user.name=t", ...args], {
    cwd,
    encoding: "utf8",
  })
  assert.equal(result.status, 0, result.stderr)
  return result.stdout.trim()
}

/** 建一个带 release 分支的远端，与一个停在旧版本的插件克隆。 */
function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "guard-update-git-"))
  t.after(() => {
    assert.equal(path.dirname(fs.realpathSync(root)), fs.realpathSync(os.tmpdir()))
    fs.rmSync(root, { recursive: true, force: true })
  })
  const source = path.join(root, "source")
  fs.mkdirSync(source)
  run(source, "init", "-q", "-b", "release")
  const release = version => {
    fs.writeFileSync(
      path.join(source, "package.json"),
      JSON.stringify({ name: "yunzai-guard", version }),
    )
    fs.writeFileSync(path.join(source, "index.js"), `// ${version}\n`)
    run(source, "add", "-A")
    run(source, "commit", "-q", "-m", `release: v${version}`)
  }
  release("1.0.0")
  const remote = path.join(root, "remote.git")
  run(root, "clone", "-q", "--bare", source, remote)
  const plugin = path.join(root, "plugin")
  run(root, "clone", "-q", "--depth=1", "-b", "release", `file://${remote}`, plugin)
  release("1.1.0")
  run(source, "push", "-q", remote, "release")
  return { root, plugin }
}

test(
  "release-branch git installs fetch, switch and roll back through the update service",
  { skip: !hasGit },
  async t => {
    const { root, plugin } = fixture(t)
    assert.equal(gitBranch(plugin), "release")
    const settings = parseSettings({})
    const installs = []
    let refuseInstall = false
    const options = {
      pluginDir: plugin,
      stateDir: path.join(root, "state"),
      settings: () => settings.update,
      send: () => true,
      install: (...args) => {
        if (refuseInstall) throw new Error("fixture install refused")
        installs.push(args)
      },
      record() {},
    }
    const service = new UpdateService(options)
    const state = service.state()
    assert.equal(state.installMode, "git")
    assert.equal(state.autoUpdate, true)
    await assert.rejects(fetchRelease(plugin, "9.9.9", false), /不一致/)
    const fetched = await fetchRelease(plugin, "1.1.0", false)
    const handle = service.swap({ version: "1.1.0", directory: plugin, commit: fetched.commit })
    assert.equal(
      JSON.parse(fs.readFileSync(path.join(plugin, "package.json"), "utf8")).version,
      "1.1.0",
    )
    handle.rollback()
    assert.equal(
      JSON.parse(fs.readFileSync(path.join(plugin, "package.json"), "utf8")).version,
      "1.0.0",
    )
    service.swap({ version: "1.1.0", directory: plugin, commit: fetched.commit }).commit()
    assert.equal(service.state().rollback?.version, "1.0.0")
    const restarted = new UpdateService(options)
    const originalPath = process.env.PATH
    try {
      // 状态展示不依赖 Git 可执行文件；回滚版本在宿主启动时解析。
      process.env.PATH = ""
      const state = restarted.state()
      assert.equal(state.autoUpdate, true)
      assert.equal(state.current, "1.1.0")
      assert.equal(state.rollback?.version, "1.0.0")
    } finally {
      if (originalPath === undefined) delete process.env.PATH
      else process.env.PATH = originalPath
    }
    refuseInstall = true
    const refused = await restarted.rollback()
    assert.equal(refused.ok, false)
    assert.match(refused.message, /fixture install refused/)
    assert.equal(restarted.state().phase, "failed")
    refuseInstall = false
    assert.equal((await restarted.rollback()).ok, true)
    const [previous, from, rollback] = installs.at(-1)
    assert.equal(previous.version, "1.0.0")
    assert.equal(from, "1.1.0")
    assert.equal(rollback, true)
    restarted.swap(previous).commit()
    const restored = new UpdateService(options).state()
    assert.equal(restored.current, "1.0.0")
    assert.equal(restored.rollback?.version, "1.1.0")
    fs.appendFileSync(path.join(plugin, "index.js"), "// local\n")
    await assert.rejects(fetchRelease(plugin, "1.1.0", false), /未提交的改动/)
    await fetchRelease(plugin, "1.1.0", true)
  },
)

test(
  "source checkouts on other branches are left to manual updates",
  { skip: !hasGit },
  async t => {
    const { root, plugin } = fixture(t)
    run(plugin, "checkout", "-q", "-b", "main")
    const service = new UpdateService({
      pluginDir: plugin,
      stateDir: path.join(root, "state"),
      settings: () => parseSettings({}).update,
      send: () => true,
      install() {},
      record() {},
    })
    assert.equal(service.state().autoUpdate, false)
    const result = await service.apply(false)
    assert.equal(result.ok, false)
    assert.match(result.message, /源码安装/)
  },
)

test("branch metadata follows worktrees and detached HEAD", { skip: !hasGit }, t => {
  const { root, plugin } = fixture(t)
  const worktree = path.join(root, "worktree")
  run(plugin, "worktree", "add", "-q", "-b", "preview", worktree)
  assert.equal(gitBranch(worktree), "preview")
  run(plugin, "checkout", "-q", "--detach")
  assert.equal(gitBranch(plugin), "HEAD")
})
