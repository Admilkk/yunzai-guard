import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { spawnSync } from "node:child_process"
import { fileURLToPath } from "node:url"
import test from "node:test"

const preload = fileURLToPath(new URL("../dist/pm2-preload.cjs", import.meta.url))
const windows = { skip: process.platform !== "win32" }

function fixture(name = "pm2", version = "6.0.14") {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "guard-pm2-preload-"))
  for (const folder of ["lib", "bin"]) fs.mkdirSync(path.join(root, folder))
  fs.writeFileSync(path.join(root, "package.json"), JSON.stringify({ name, version }))
  fs.writeFileSync(
    path.join(root, "lib/God.js"),
    `
const god = { clusters_db: {}, processIsDead(){}, handleExit(){} }
god.originalPoll = god.processIsDead
module.exports = god
`,
  )
  const entry = path.join(root, "lib/Daemon.js")
  fs.writeFileSync(
    entry,
    `
const god = require("./God.js")
console.log(JSON.stringify({ wrapped: god.processIsDead !== god.originalPoll }))
`,
  )
  const cli = path.join(root, "bin/pm2")
  fs.writeFileSync(cli, 'console.log("CLI_BODY")')
  return {
    entry,
    cli,
    root,
    close() {
      assert.equal(fs.realpathSync.native(path.dirname(root)), fs.realpathSync.native(os.tmpdir()))
      assert.equal(path.dirname(fs.realpathSync.native(root)), fs.realpathSync.native(os.tmpdir()))
      assert.match(path.basename(root), /^guard-pm2-preload-/)
      fs.rmSync(root, { recursive: true, force: true })
    },
  }
}

function run(args) {
  const env = { ...process.env }
  delete env.NODE_OPTIONS
  return spawnSync(process.execPath, ["--require", preload, ...args], {
    env,
    encoding: "utf8",
    windowsHide: true,
    timeout: 15000,
  })
}

test("PM2 compatibility preload leaves normal Node applications untouched", () => {
  const result = run(["-e", 'console.log("ordinary-app")'])
  assert.equal(result.status, 0, result.stderr)
  assert.equal(result.stdout.trim(), "ordinary-app")
  assert.equal(result.stderr, "")
})

test("PM2 compatibility preload ignores unrelated Daemon.js and CLI package names", () => {
  const probe = fixture("unrelated-program", "99.0.0")
  try {
    const result = run([probe.entry])
    assert.equal(result.status, 0, result.stderr)
    assert.deepEqual(JSON.parse(result.stdout), { wrapped: false })
    const cli = run([probe.cli])
    assert.equal(cli.status, 0, cli.stderr)
    assert.equal(cli.stdout.trim(), "CLI_BODY")
  } finally {
    probe.close()
  }
})

test("Windows preload installs only inside the supported PM2 daemon", windows, () => {
  const probe = fixture()
  try {
    const result = run([probe.entry])
    assert.equal(result.status, 0, result.stderr)
    assert.deepEqual(JSON.parse(result.stdout), { wrapped: true })
    assert.match(result.stderr, /PM2 兼容层已启用/)
    const cli = run([probe.cli])
    assert.equal(cli.status, 0, cli.stderr)
    assert.equal(cli.stdout.trim(), "CLI_BODY")
    assert.equal(cli.stderr, "")
  } finally {
    probe.close()
  }
})

test(
  "Windows preload does not mistake a Daemon.js alias for another PM2 library entry",
  windows,
  context => {
    const probe = fixture()
    try {
      const other = path.join(probe.root, "lib/Other.js")
      fs.copyFileSync(probe.entry, other)
      fs.rmSync(probe.entry)
      try {
        fs.symlinkSync(other, probe.entry, "file")
      } catch (error) {
        if (["EPERM", "EACCES", "ENOSYS"].includes(error.code)) {
          context.skip("file symlinks are unavailable for this test user")
          return
        }
        throw error
      }
      const result = run([probe.entry])
      assert.equal(result.status, 0, result.stderr)
      assert.deepEqual(JSON.parse(result.stdout), { wrapped: false })
      assert.equal(result.stderr, "")
    } finally {
      probe.close()
    }
  },
)

test("Windows preload refuses unsupported PM2 before running the CLI or daemon", windows, () => {
  const probe = fixture("pm2", "0.0.0-unvalidated")
  try {
    for (const entry of [probe.cli, probe.entry]) {
      const result = run([entry])
      assert.equal(result.status, 1)
      assert.match(result.stderr, /PM2 版本 .* 不受支持/)
      assert.equal(result.stdout, "")
    }
  } finally {
    probe.close()
  }
})

test(
  "Linux compatibility preload does not install Windows hooks",
  { skip: process.platform !== "linux" },
  () => {
    const probe = fixture()
    try {
      const result = run([probe.entry])
      assert.equal(result.status, 0, result.stderr)
      assert.deepEqual(JSON.parse(result.stdout), { wrapped: false })
      assert.equal(result.stderr, "")
    } finally {
      probe.close()
    }
  },
)
