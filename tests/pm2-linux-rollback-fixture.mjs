import assert from "node:assert/strict"
import fs from "node:fs"
import path from "node:path"
import { execFile } from "node:child_process"
import { promisify } from "node:util"
import { createEnvironmentFixture, snapshot, waitScopeGone } from "./environment-fixture.mjs"

/** 使用隔离的真实 Linux 守护进程；失去已验证的 PID 身份后不再执行命令。 */
export async function createLinuxRollbackFixture() {
  assert.equal(process.platform, "linux")
  const fixture = await createEnvironmentFixture({ mode: "managed", label: "pm2-rollback" })
  const home = path.join(fixture.runRoot, "pm2-home")
  fs.mkdirSync(home)
  const cliPath = fs.realpathSync(
    process.env.GUARD_PM2_CLI || "/usr/local/lib/node_modules/pm2/bin/pm2",
  )
  const execute = promisify(execFile)
  const env = { PM2_HOME: home, PM2_NO_INTERACTION: "true" }
  for (const key of ["PATH", "HOME", "USER", "LOGNAME", "LANG", "TZ", "TMPDIR"])
    if (process.env[key] !== undefined) env[key] = process.env[key]
  const name = "guard-rollback",
    unrelatedName = "guard-rollback-resident"
  const resident = path.join(fixture.runRoot, "resident.cjs")
  fs.writeFileSync(resident, "setInterval(() => {}, 1000)\n")
  const config = (filename, app) => {
    const file = path.join(fixture.runRoot, filename)
    fs.writeFileSync(
      file,
      "module.exports=" +
        JSON.stringify({
          apps: [
            {
              cwd: fixture.root,
              interpreter: process.execPath,
              exec_mode: "fork",
              instances: 1,
              ...app,
            },
          ],
        }),
    )
    return file
  }
  const targetConfigPath = config("target.config.cjs", {
    name,
    script: path.join(fixture.root, "app.js"),
    env: { app_type: "pm2" },
  })
  const unrelatedConfigPath = config("resident.config.cjs", {
    name: unrelatedName,
    script: resident,
  })
  const observed = new Map()
  let daemon
  const capture = pid => {
    const rows = snapshot(pid)
    for (const row of rows) observed.set(`${row.pid}:${row.start}`, row)
    return rows
  }
  const observeDaemon = () => {
    const pidFile = path.join(home, "pm2.pid")
    if (!fs.existsSync(pidFile)) return undefined
    const pid = Number(fs.readFileSync(pidFile, "utf8").trim())
    return Number.isSafeInteger(pid) && pid > 1
      ? snapshot(pid).find(row => row.pid === pid)
      : undefined
  }
  const command = async args => {
    const { stdout } = await execute(process.execPath, [cliPath, ...args, "--silent"], {
      cwd: fixture.root,
      env,
      timeout: 90000,
      maxBuffer: 4 * 1024 * 1024,
    })
    return stdout.trim()
  }
  const cli = async args => {
    assert.ok(daemon)
    assert.deepEqual(observeDaemon(), daemon, "Never recreate or adopt a daemon during the test")
    return command(args)
  }
  const pm2 = {
    home,
    cli,
    observeDaemon,
    listRaw: async () => JSON.parse(await cli(["jlist"])),
    startDaemon: async () => {
      assert.equal(daemon, undefined)
      assert.equal(fs.existsSync(path.join(home, "pm2.pid")), false)
      await command(["ping"])
      daemon = observeDaemon()
      assert.ok(daemon)
      capture(daemon.pid)
      return daemon
    },
  }
  return {
    fixture,
    pm2,
    name,
    unrelatedName,
    targetConfigPath,
    unrelatedConfigPath,
    capture,
    launcherPath: fixture.launcher,
    pm2Version: JSON.parse(
      fs.readFileSync(path.resolve(path.dirname(cliPath), "../package.json"), "utf8"),
    ).version,
    cleanup: async () => {
      if (daemon && observeDaemon()) {
        assert.deepEqual(observeDaemon(), daemon)
        capture(daemon.pid)
        await cli(["kill"])
      }
      await waitScopeGone([...observed.values()])
      await fixture.finish({ stop: false })
      return { confirmed: true, observedScopesGone: true }
    },
  }
}
