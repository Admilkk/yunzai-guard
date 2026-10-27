import assert from "node:assert/strict"
import fs from "node:fs"
import path from "node:path"
import { execFile, spawn } from "node:child_process"
import { promisify } from "node:util"
import test from "node:test"
import { createEnvironmentFixture, snapshot, until, waitScopeGone } from "./environment-fixture.mjs"

const execute = promisify(execFile)
const enabled = process.platform === "linux" && process.env.GUARD_TEST_ENVIRONMENTS === "1"
const skip = enabled ? false : "requires GUARD_TEST_ENVIRONMENTS=1 on Linux"
const pm2Cli = process.env.GUARD_PM2_CLI || "/usr/local/lib/node_modules/pm2/bin/pm2"
const quote = value => "'" + value.replaceAll("'", "'\\''") + "'"

function environment(extra = {}) {
  const env = { ...process.env, TERM: "xterm", ...extra }
  for (const key of ["NODE_OPTIONS", "pm_id", "NODE_APP_INSTANCE", "app_type"]) delete env[key]
  return env
}

async function run(file, args, options = {}) {
  return execute(file, args, {
    encoding: "utf8",
    timeout: 90000,
    maxBuffer: 8 * 1024 * 1024,
    ...options,
  })
}

function report(fixture, manager, mode, checks, version, extra = {}) {
  const result = {
    platform: process.platform,
    arch: process.arch,
    node: process.version,
    manager,
    managerVersion: version,
    isolationMode: mode,
    network: mode === "os-sandbox" ? "none" : "host",
    redisFixture: fixture.redisFixture,
    ...fixture.verifyCoreHashes(),
    checks,
    ...extra,
  }
  fs.writeFileSync(
    path.join(fixture.runRoot, "report.json"),
    JSON.stringify(result, null, 2) + "\n",
  )
}

async function internalRestarts(fixture, current, check) {
  for (const command of ["invoke-bot-restart", "restart"]) {
    const previous = current
    const old = snapshot(previous.workerPid)
    assert.ok(old.length >= 1)
    if (command === "restart") fixture.cli("restart")
    else await fixture.control(command)
    current = await fixture.waitOnline(previous.generation + 1)
    assert.equal(current.hostPid, previous.hostPid)
    assert.equal(current.generation, previous.generation + 1)
    await waitScopeGone(old)
    check(`${command} preserves the manager-owned host and removes its previous worker scope`)
  }
  return current
}

for (const mode of ["managed", "os-sandbox"]) {
  test(`real Linux PM2 fork lifecycle in ${mode}`, { skip, timeout: 360000 }, async context => {
    const fixture = await createEnvironmentFixture({ mode, label: `pm2-${mode}` })
    const pm2Home = path.join(fixture.runRoot, "pm2-home")
    fs.mkdirSync(pm2Home, { mode: 0o700 })
    const env = environment({ PM2_HOME: pm2Home, PM2_NO_INTERACTION: "1" })
    const checks = []
    const check = name => {
      checks.push({ name, status: "passed" })
      context.diagnostic(`PASS ${name}`)
    }
    const pm2 = (...args) => run(process.execPath, [pm2Cli, ...args], { env, cwd: fixture.root })
    const list = async () => JSON.parse((await pm2("jlist")).stdout.trim())
    const config = path.join(fixture.runRoot, "ecosystem.config.cjs")
    fs.writeFileSync(
      config,
      "module.exports = " +
        JSON.stringify({
          apps: [
            {
              name: "guard-fixture",
              script: fixture.launcher,
              cwd: fixture.root,
              exec_mode: "fork",
              instances: 1,
              wait_ready: true,
              listen_timeout: 60000,
              kill_timeout: 20000,
              kill_retry_time: 1000,
              stop_exit_codes: [78],
              shutdown_with_message: true,
              restart_delay: 500,
              min_uptime: 1000,
              max_restarts: 5,
              autorestart: true,
            },
          ],
        }) +
        "\n",
    )
    try {
      await pm2("start", config)
      let current = await fixture.waitOnline()
      let app = (await list()).find(item => item.name === "guard-fixture")
      assert.equal(app.pid, current.hostPid)
      assert.equal(app.pm2_env.status, "online")
      assert.equal(app.pm2_env.exec_mode, "fork_mode")
      check("actual PM2 owns the online launcher in a private PM2_HOME")
      current = await internalRestarts(fixture, current, check)
      for (const command of ["restart", "reload"]) {
        const previous = current
        const old = snapshot(previous.hostPid)
        await pm2(command, "guard-fixture")
        current = await fixture.waitForStatus(
          value => value.phase === "online" && value.hostPid !== previous.hostPid,
        )
        await fixture.waitOnline()
        await waitScopeGone(old)
        app = (await list()).find(item => item.name === "guard-fixture")
        assert.equal(app.pid, current.hostPid)
        check(`PM2 ${command} replaces the host and removes the entire observed old scope`)
      }
      const beforeKill = current
      const killedScope = snapshot(current.hostPid)
      process.kill(current.hostPid, "SIGKILL")
      current = await fixture.waitForStatus(
        value => value.phase === "online" && value.hostPid !== beforeKill.hostPid,
      )
      await fixture.waitOnline()
      await waitScopeGone(killedScope)
      assert.equal((await list()).find(item => item.name === "guard-fixture").pid, current.hostPid)
      check("PM2 automatically recovers a killed host without retaining the observed old scope")
      const old = snapshot(current.hostPid)
      await pm2("stop", "guard-fixture")
      await waitScopeGone(old)
      assert.equal(
        (await list()).find(item => item.name === "guard-fixture").pm2_env.status,
        "stopped",
      )
      assert.equal(fs.existsSync(path.join(fixture.stateDir, "control.json")), false)
      check("PM2 stop gracefully removes host, worker scope and its control credential")
      await pm2("restart", "guard-fixture")
      current = await fixture.waitOnline()
      const deletedScope = snapshot(current.hostPid)
      await pm2("delete", "guard-fixture")
      await waitScopeGone(deletedScope)
      assert.equal((await list()).length, 0)
      check(
        "PM2 restart from stopped and delete leave no registered application or observed processes",
      )
      await pm2("start", config)
      current = await fixture.waitOnline()
      const daemon = Number(fs.readFileSync(path.join(pm2Home, "pm2.pid"), "utf8"))
      const daemonScope = snapshot(daemon)
      assert.ok(daemonScope.some(item => item.pid === current.hostPid))
      await pm2("kill")
      await waitScopeGone(daemonScope)
      check("private PM2 daemon shutdown terminates its live application and observed descendants")
      await fixture.finish({ stop: false })
      check("all 47 original core files remain byte-identical")
      const version = JSON.parse(
        fs.readFileSync(path.resolve(path.dirname(pm2Cli), "../package.json"), "utf8"),
      ).version
      report(fixture, "pm2", mode, checks, version, {
        executionMode: "fork",
        reloadSemantics: "fork restart; no zero-downtime cluster claim",
      })
    } finally {
      // PM2_HOME 和 UNIX socket 均由本夹具独占。
      await pm2("kill").catch(() => {})
      await fixture.finish()
      context.diagnostic(`Evidence: ${fixture.runRoot}`)
    }
  })

  test(
    `real Linux screen terminal lifecycle in ${mode}`,
    { skip, timeout: 240000 },
    async context => {
      const fixture = await createEnvironmentFixture({ mode, label: `screen-${mode}` })
      const screenDir = path.join(fixture.runRoot, "screen")
      fs.mkdirSync(screenDir, { mode: 0o700 })
      const env = environment({ SCREENDIR: screenDir })
      const name = "guard-environment"
      const screen = (...args) => run("screen", args, { env, cwd: fixture.root })
      const checks = []
      const check = name => {
        checks.push({ name, status: "passed" })
        context.diagnostic(`PASS ${name}`)
      }
      const start = () =>
        screen(
          "-c",
          "/dev/null",
          "-L",
          "-Logfile",
          path.join(fixture.runRoot, "screen-output.log"),
          "-dmS",
          name,
          process.execPath,
          fixture.launcher,
        )
      let attached
      try {
        await start()
        let current = await fixture.waitOnline()
        check("real detached screen owns a live foreground launcher inside its PTY")
        current = await internalRestarts(fixture, current, check)
        const beforeAttach = current
        attached = spawn(
          "script",
          ["-q", "-c", `screen -c /dev/null -r ${quote(name)}`, "/dev/null"],
          {
            cwd: fixture.root,
            env,
            stdio: ["pipe", "ignore", "ignore"],
          },
        )
        await until(
          async () => (await screen("-ls")).stdout.includes("(Attached)"),
          "screen did not reattach to a real terminal",
        )
        await screen("-S", name, "-X", "detach")
        await until(() => attached.exitCode !== null, "detached screen client did not exit")
        current = await fixture.status()
        assert.equal(current.hostPid, beforeAttach.hostPid)
        assert.equal(current.workerPid, beforeAttach.workerPid)
        check("screen reattach and detach preserve the same host and worker")
        const interrupted = snapshot(current.hostPid)
        await screen("-S", name, "-p", "0", "-X", "stuff", "\u0003")
        await waitScopeGone(interrupted)
        assert.ok(fixture.events().some(item => item.type === "host-stop"))
        check("real PTY Ctrl+C gracefully stops the launcher and observed worker scope")
        await start()
        current = await fixture.waitOnline()
        const closed = snapshot(current.hostPid)
        await screen("-S", name, "-X", "quit")
        await waitScopeGone(closed)
        check("screen quit leaves no observed host or worker processes")
        await fixture.finish({ stop: false })
        check("all 47 original core files remain byte-identical")
        report(fixture, "screen", mode, checks, (await screen("--version")).stdout.trim())
      } finally {
        await screen("-S", name, "-X", "quit").catch(() => {})
        attached?.stdin?.end()
        if (attached && attached.exitCode === null) attached.kill("SIGTERM")
        await fixture.finish()
        context.diagnostic(`Evidence: ${fixture.runRoot}`)
      }
    },
  )

  test(
    `real Linux tmux terminal lifecycle in ${mode}`,
    { skip, timeout: 240000 },
    async context => {
      const fixture = await createEnvironmentFixture({ mode, label: `tmux-${mode}` })
      const socket = path.join(fixture.runRoot, "tmux.sock")
      const env = environment()
      const tmux = (...args) =>
        run("tmux", ["-S", socket, "-f", "/dev/null", ...args], { env, cwd: fixture.root })
      const checks = []
      const check = name => {
        checks.push({ name, status: "passed" })
        context.diagnostic(`PASS ${name}`)
      }
      const command = `exec ${quote(process.execPath)} ${quote(fixture.launcher)}`
      const start = () => tmux("new-session", "-d", "-s", "guard", "-c", fixture.root, command)
      try {
        await start()
        let current = await fixture.waitOnline()
        assert.equal(
          (await tmux("display-message", "-p", "#{pane_pid}")).stdout.trim(),
          String(current.hostPid),
        )
        check("real tmux owns the launcher as its PTY foreground process")
        current = await internalRestarts(fixture, current, check)
        const interrupted = snapshot(current.hostPid)
        await tmux("send-keys", "-t", "guard", "C-c")
        await waitScopeGone(interrupted)
        assert.ok(fixture.events().some(item => item.type === "host-stop"))
        check("tmux PTY Ctrl+C gracefully stops host and observed worker scope")
        await start()
        current = await fixture.waitOnline()
        const closed = snapshot(current.hostPid)
        await tmux("kill-server")
        await waitScopeGone(closed)
        check("dedicated tmux server shutdown leaves no observed host or worker processes")
        await fixture.finish({ stop: false })
        check("all 47 original core files remain byte-identical")
        report(fixture, "tmux", mode, checks, (await run("tmux", ["-V"], { env })).stdout.trim())
      } finally {
        await tmux("kill-server").catch(() => {})
        await fixture.finish()
        context.diagnostic(`Evidence: ${fixture.runRoot}`)
      }
    },
  )

  test(`real Linux nohup lifecycle in ${mode}`, { skip, timeout: 120000 }, async context => {
    const fixture = await createEnvironmentFixture({ mode, label: `nohup-${mode}` })
    const checks = []
    const check = name => {
      checks.push({ name, status: "passed" })
      context.diagnostic(`PASS ${name}`)
    }
    const start = () => {
      const output = fs.openSync(path.join(fixture.runRoot, "nohup-output.log"), "a")
      const child = spawn("nohup", [process.execPath, fixture.launcher], {
        cwd: fixture.root,
        env: environment(),
        detached: true,
        stdio: ["ignore", output, output],
      })
      fs.closeSync(output)
      return child
    }
    let host = start()
    try {
      let current = await fixture.waitOnline()
      assert.equal(current.hostPid, host.pid)
      check("actual nohup starts a detached launcher with redirected output and no stdin")
      const hungUp = snapshot(current.hostPid)
      process.kill(current.hostPid, "SIGHUP")
      await waitScopeGone(hungUp)
      await until(() => host.signalCode !== null, "direct SIGHUP did not terminate the nohup host")
      assert.equal(host.signalCode, "SIGHUP")
      check("direct SIGHUP terminates Node despite nohup; the observed worker scope still exits")
      host = start()
      current = await fixture.waitOnline()
      assert.equal(current.hostPid, host.pid)
      current = await internalRestarts(fixture, current, check)
      const stopped = snapshot(current.hostPid)
      process.kill(current.hostPid, "SIGTERM")
      await waitScopeGone(stopped)
      await until(
        () => host.exitCode !== null || host.signalCode !== null,
        "nohup child did not exit",
      )
      assert.equal(host.exitCode, 0)
      assert.ok(fixture.events().some(item => item.type === "host-stop"))
      check("SIGTERM gracefully stops the nohup host and observed worker scope")
      await fixture.finish({ stop: false })
      check("all 47 original core files remain byte-identical")
      report(fixture, "nohup", mode, checks, "Alpine BusyBox nohup", {
        hangupSupport:
          "not guaranteed: tested Node resets inherited SIGHUP ignore; direct SIGHUP terminates the host",
        recoverySupport: "nohup provides no supervisor or automatic restart",
      })
    } finally {
      await fixture.finish()
      if (host.exitCode === null && host.signalCode === null) host.kill("SIGTERM")
      context.diagnostic(`Evidence: ${fixture.runRoot}`)
    }
  })
}

// 普通 app.js 的自动接管由 environment-linux-pm2-auto.test.mjs 验证，不再作为无效入口。
