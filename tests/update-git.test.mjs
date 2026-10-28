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
function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "guard-update-git-"))
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
  async () => {
    const { root, plugin } = fixture()
    assert.equal(gitBranch(plugin), "release")
    const settings = parseSettings({})
    const service = new UpdateService({
      pluginDir: plugin,
      stateDir: path.join(root, "state"),
      settings: () => settings.update,
      send: () => true,
      install() {},
      record() {},
    })
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
    fs.appendFileSync(path.join(plugin, "index.js"), "// local\n")
    await assert.rejects(fetchRelease(plugin, "1.1.0", false), /未提交的改动/)
    await fetchRelease(plugin, "1.1.0", true)
  },
)

test(
  "source checkouts on other branches are left to manual updates",
  { skip: !hasGit },
  async () => {
    const { root, plugin } = fixture()
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
