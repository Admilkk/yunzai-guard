import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { createHash, randomBytes } from "node:crypto"
import { execFile, execFileSync } from "node:child_process"
import { promisify } from "node:util"
import test from "node:test"
import { createEnvironmentFixture, snapshot, waitScopeGone, until } from "./environment-fixture.mjs"

const enabled = process.env.GUARD_TEST_ENVIRONMENTS === "1" && process.platform === "win32"
const execute = promisify(execFile)
const pause = ms => new Promise(resolve => setTimeout(resolve, ms))
const pm2Root =
  process.env.GUARD_TEST_PM2_PACKAGE ?? path.join(process.env.APPDATA ?? "", "npm/node_modules/pm2")

function identity(pid) {
  return snapshot(pid).find(row => row.pid === pid)
}
function sha256(file) {
  return createHash("sha256").update(fs.readFileSync(file)).digest("hex")
}

/** 不向默认 PM2 管道发送命令；Windows 上仅隔离 PM2_HOME 还不够。 */
function namespace(fixture) {
  const home = path.join(fixture.runRoot, "pm2-home")
  fs.mkdirSync(home, { recursive: true })
  const suffix = randomBytes(16).toString("hex")
  const endpoints = Object.fromEntries(
    ["DAEMON_RPC_PORT", "DAEMON_PUB_PORT", "INTERACTOR_RPC_PORT"].map((key, index) => [
      key,
      `\\\\.\\pipe\\yunzai-guard-pm2-${suffix}-${index}`,
    ]),
  )
  const preload = path.join(fixture.runRoot, "pm2-test-namespace.cjs")
  const observed = path.join(fixture.runRoot, "pm2-namespace.jsonl")
  const factoryPath = path.join(pm2Root, "paths.js")
  const originalHash = sha256(factoryPath)
  fs.writeFileSync(
    preload,
    `
    const fs=require('node:fs'),path=require('node:path');
    const expected=${JSON.stringify(home)}, endpoints=${JSON.stringify(endpoints)};
    if(path.resolve(process.env.PM2_HOME||'')!==expected)throw new Error('Refusing non-test PM2_HOME');
    const target=${JSON.stringify(factoryPath)};
    const original=require(target);
    require.cache[require.resolve(target)].exports=function(...args){
      const result=original(...args);
      if(path.resolve(result.PM2_HOME)!==expected)throw new Error('PM2 paths escaped test home');
      const names=Object.keys(endpoints);
      const changed={...result,...endpoints};
      if(Object.keys(result).some(key=>!names.includes(key)&&changed[key]!==result[key]))throw new Error('Unexpected PM2 configuration change');
      fs.appendFileSync(${JSON.stringify(observed)},JSON.stringify({pid:process.pid,home:result.PM2_HOME,endpoints,changedKeys:names})+'\\n');
      return changed;
    };
  `,
  )
  const keep = [
    "PATH",
    "SystemRoot",
    "WINDIR",
    "LOCALAPPDATA",
    "APPDATA",
    "USERPROFILE",
    "USERNAME",
    "USERDOMAIN",
    "ComSpec",
    "TEMP",
    "TMP",
    "HOME",
    "HOMEDRIVE",
    "HOMEPATH",
    "ProgramData",
    "ALLUSERSPROFILE",
    "ProgramFiles",
    "ProgramFiles(x86)",
    "CommonProgramFiles",
    "LANG",
    "TZ",
    "PROCESSOR_ARCHITECTURE",
    "NUMBER_OF_PROCESSORS",
  ]
  const env = Object.fromEntries(
    keep.filter(key => process.env[key] !== undefined).map(key => [key, process.env[key]]),
  )
  Object.assign(env, {
    PM2_HOME: home,
    PM2_NO_INTERACTION: "true",
    PM2_DISCRETE_MODE: "true",
    NO_COLOR: "1",
    NODE_OPTIONS: `--require "${preload.replaceAll("\\", "/")}"`,
  })
  const commands = []
  async function cli(args, timeout = 90000) {
    assert.equal(env.PM2_HOME, home)
    const started = Date.now()
    try {
      const { stdout } = await execute(
        process.execPath,
        [path.join(pm2Root, "bin/pm2"), ...args, "--silent"],
        { cwd: fixture.runRoot, env, windowsHide: true, timeout, maxBuffer: 16 * 1024 * 1024 },
      )
      commands.push({ action: args[0], status: "passed", elapsedMs: Date.now() - started })
      return stdout
    } catch (error) {
      commands.push({
        action: args[0],
        status: "failed",
        elapsedMs: Date.now() - started,
        code: error.code,
      })
      // jlist 包含环境变量，异常和证据中不得附带原始 CLI 输出。
      throw new Error(
        `Isolated PM2 ${args[0]} failed (${error.code ?? "unknown"}); inspect dedicated PM2_HOME logs`,
      )
    }
  }
  async function list() {
    const raw = await cli(["jlist"])
    try {
      return JSON.parse(raw.trim()).map(item => ({
        id: item.pm_id,
        pid: item.pid,
        name: item.name,
        status: item.pm2_env?.status,
        restarts: item.pm2_env?.restart_time,
        execMode: item.pm2_env?.exec_mode,
        killRetryTime: item.pm2_env?.kill_retry_time,
        killTimeout: item.pm2_env?.kill_timeout,
        exitCode: item.pm2_env?.exit_code,
      }))
    } catch {
      throw new Error(
        "Isolated PM2 jlist did not return valid JSON; raw environments deliberately omitted",
      )
    }
  }
  return { home, endpoints, preload, observed, commands, cli, list, factoryPath, originalHash }
}

function terminateOwned(identities) {
  const rows = identities.filter(
    row => Number.isSafeInteger(row.pid) && row.pid > 1 && /^\d{17}$/.test(row.start),
  )
  if (!rows.length) return
  const encoded = Buffer.from(JSON.stringify(rows), "utf8").toString("base64")
  const script = `$guardRows=[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${encoded}'))|ConvertFrom-Json; foreach($guardRow in $guardRows){try{$guardProcess=[Diagnostics.Process]::GetProcessById([int]$guardRow.pid); if($guardProcess.StartTime.ToUniversalTime().ToString('yyyyMMddHHmmssfff') -eq $guardRow.start){$guardProcess.Kill();[void]$guardProcess.WaitForExit(5000)};$guardProcess.Dispose()}catch{}}`
  execFileSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script], {
    windowsHide: true,
    stdio: "ignore",
    timeout: 15000,
  })
}

for (const mode of ["managed", "os-sandbox"])
  test(
    `Windows real PM2 safe stop-confirm-start lifecycle (${mode})`,
    {
      skip: !enabled ? "requires GUARD_TEST_ENVIRONMENTS=1 on Windows" : false,
      timeout: 360000,
    },
    async context => {
      assert.ok(
        fs.existsSync(path.join(pm2Root, "package.json")),
        "An existing PM2 package is required; no global install is performed",
      )
      const version = JSON.parse(
        fs.readFileSync(path.join(pm2Root, "package.json"), "utf8"),
      ).version
      const defaultHome = process.env.PM2_HOME ?? path.join(os.homedir(), ".pm2")
      let defaultIdentity
      try {
        defaultIdentity = identity(
          Number(fs.readFileSync(path.join(defaultHome, "pm2.pid"), "utf8").trim()),
        )
      } catch {}
      const fixture = await createEnvironmentFixture({ mode, label: `windows-pm2-${mode}` })
      const pm2 = namespace(fixture),
        name = `guard-${mode}`
      const config = path.join(fixture.runRoot, "ecosystem.config.cjs")
      fs.writeFileSync(
        config,
        "module.exports=" +
          JSON.stringify(
            {
              apps: [
                {
                  name,
                  script: fixture.launcher,
                  cwd: fixture.root,
                  interpreter: process.execPath,
                  exec_mode: "fork",
                  instances: 1,
                  wait_ready: true,
                  listen_timeout: 60000,
                  shutdown_with_message: true,
                  kill_timeout: 20000,
                  kill_retry_time: 100,
                  autorestart: true,
                  min_uptime: 1000,
                  max_restarts: 5,
                  stop_exit_codes: [78],
                  watch: false,
                  env: { NODE_OPTIONS: "" },
                },
              ],
            },
            null,
            2,
          ) +
          "\n",
      )
      const checks = [],
        owned = []
      let daemonIdentity,
        daemonKilled = false,
        failure
      const check = (name, details = {}) => {
        checks.push({ name, status: "passed", ...details })
        context.diagnostic(`PASS ${mode}: ${name}`)
      }
      const capture = pid => {
        const observed = snapshot(pid),
          confirmed = new Map()
        const rootIdentity = observed.find(row => row.pid === pid)
        if (rootIdentity) confirmed.set(pid, rootIdentity)
        let changed
        do {
          changed = false
          for (const row of observed) {
            const parent = confirmed.get(row.parent)
            if (parent && row.start >= parent.start && !confirmed.has(row.pid)) {
              confirmed.set(row.pid, row)
              changed = true
            }
          }
        } while (changed)
        const rows = [...confirmed.values()]
        owned.push(...rows)
        return rows
      }
      async function onlineNewHost(previousPid) {
        return fixture.waitForStatus(
          state => state.phase === "online" && state.hostPid !== previousPid,
          { timeout: 90000, description: "PM2 did not establish a new online supervisor" },
        )
      }
      try {
        await pm2.cli(["start", config])
        const daemonPid = Number(fs.readFileSync(path.join(pm2.home, "pm2.pid"), "utf8").trim())
        daemonIdentity = identity(daemonPid)
        assert.ok(daemonIdentity, "Dedicated daemon identity exists")
        assert.notEqual(daemonPid, defaultIdentity?.pid)
        let current = await fixture.waitOnline()
        let rows = await pm2.list()
        assert.equal(rows.length, 1)
        assert.equal(rows[0].pid, current.hostPid)
        assert.equal(rows[0].status, "online")
        assert.equal(rows[0].killRetryTime, 100)
        assert.equal(current.capabilities.osSandbox, mode === "os-sandbox")
        capture(current.hostPid)
        check("actual PM2 start manages launcher host and one unchanged-core worker", {
          hostPid: current.hostPid,
          workerPid: current.workerPid,
        })

        for (const command of ["invoke-bot-restart", "restart"]) {
          const previous = current,
            oldScope = capture(current.workerPid)
          if (command === "restart") fixture.cli("restart")
          else await fixture.control(command)
          current = await fixture.waitOnline(previous.generation + 1)
          assert.equal(current.hostPid, previous.hostPid)
          assert.equal(current.generation, previous.generation + 1)
          await waitScopeGone(oldScope)
          rows = await pm2.list()
          assert.equal(rows[0].pid, current.hostPid)
        }
        check("Bot.restart and actual Guard CLI restart retain the PM2-managed supervisor")

        for (let cycle = 1; cycle <= 3; cycle++) {
          const previous = current,
            oldScope = capture(current.hostPid)
          const beforeLog = fs.readFileSync(path.join(pm2.home, "pm2.log"), "utf8").length
          const appId = (await pm2.list())[0].id
          await pm2.cli(["stop", name])
          await waitScopeGone(oldScope)
          await until(
            () =>
              fs
                .readFileSync(path.join(pm2.home, "pm2.log"), "utf8")
                .slice(beforeLog)
                .includes(`App [${name}:${appId}] exited`),
            "PM2 has not processed the previous application's exit event",
            30000,
          )
          rows = await pm2.list()
          assert.equal(rows[0].status, "stopped")
          assert.equal(rows[0].pid, 0)
          await pm2.cli(["start", config])
          current = await onlineNewHost(previous.hostPid)
          rows = await pm2.list()
          assert.equal(rows.length, 1)
          assert.equal(rows[0].pid, current.hostPid)
          assert.equal(rows[0].status, "online")
          check(
            `safe PM2 stop-confirm-start cycle ${cycle} waits for scope exit and the daemon's old exit callback`,
            { execMode: rows[0].execMode, killRetryTime: rows[0].killRetryTime },
          )
        }

        const beforeCrash = current,
          crashedScope = capture(current.hostPid)
        const old = identity(current.hostPid)
        assert.ok(old)
        terminateOwned([old])
        current = await onlineNewHost(beforeCrash.hostPid)
        await waitScopeGone(crashedScope)
        rows = await pm2.list()
        assert.equal(rows.length, 1)
        assert.equal(rows[0].pid, current.hostPid)
        check(
          "PM2 automatically replaces a force-killed host without leaving its previous worker scope",
        )

        let oldScope = capture(current.hostPid)
        await pm2.cli(["stop", name])
        await waitScopeGone(oldScope)
        rows = await pm2.list()
        assert.equal(rows[0].status, "stopped")
        assert.equal(rows[0].pid, 0)
        await pause(400)
        assert.equal((await pm2.list())[0].status, "stopped")
        check("PM2 stop uses the real shutdown message and leaves no managed processes")
        await pm2.cli(["delete", name])
        assert.equal((await pm2.list()).length, 0)
        check("PM2 delete removes the dedicated application")

        await pm2.cli(["start", config])
        current = await fixture.waitOnline()
        oldScope = capture(current.hostPid)
        await pm2.cli(["kill"])
        daemonKilled = true
        await waitScopeGone([...oldScope, daemonIdentity])
        check("dedicated PM2 daemon kill gracefully drains the running host and worker scope")
        assert.equal(
          sha256(pm2.factoryPath),
          pm2.originalHash,
          "Installed PM2 source must remain unchanged",
        )
        const observations = fs
          .readFileSync(pm2.observed, "utf8")
          .trim()
          .split("\n")
          .map(line => JSON.parse(line))
        assert.ok(observations.length > 0)
        for (const observation of observations) {
          assert.equal(path.resolve(observation.home), pm2.home)
          assert.deepEqual(observation.endpoints, pm2.endpoints)
          assert.deepEqual(observation.changedKeys, Object.keys(pm2.endpoints))
        }
        if (defaultIdentity)
          assert.deepEqual(
            identity(defaultIdentity.pid),
            defaultIdentity,
            "The pre-existing default PM2 daemon identity changed",
          )
        check(
          "only test PM2_HOME and three random test pipes were used; installed PM2 source and default daemon preserved",
        )
        const hashes = await fixture.finish({ stop: false })
        check("all 47 original Yunzai core files remain byte-identical", hashes)
      } catch (error) {
        failure = error
        throw error
      } finally {
        if (!daemonKilled) {
          try {
            await pm2.cli(["kill"], 45000)
            daemonKilled = true
          } catch {}
        }
        try {
          await fixture.finish({ stop: true, timeout: 15000 })
        } catch {}
        const all = [...owned, ...(daemonIdentity ? [daemonIdentity] : [])]
        try {
          await waitScopeGone(all, { timeout: 15000 })
        } catch {
          terminateOwned(all)
          await waitScopeGone(all, { timeout: 15000 })
        }
        fs.writeFileSync(
          path.join(fixture.runRoot, "environment-windows-report.json"),
          JSON.stringify(
            {
              platform: process.platform,
              node: process.version,
              pm2Version: version,
              mode,
              pm2Home: pm2.home,
              endpoints: pm2.endpoints,
              daemonIdentity,
              checks,
              commands: pm2.commands,
              defaultDaemonObserved: Boolean(defaultIdentity),
              namespaceNote:
                "PM2 6.0.14 uses fixed Windows pipes despite PM2_HOME. Test-only in-memory paths factory wrapper changes only the three IPC endpoints; real installed CLI and daemon management logic are unchanged.",
              supportedPath:
                "PM2 stop, verify prior PID scope gone, wait for daemon App exited log and stopped jlist, then start ecosystem",
              unsupportedNativeOperations:
                "PM2 6.0.14/Node24 Windows native restart and reload have observed old-exit callback races; slowing polling to 1000ms did not make them reliable",
              redisFixture: fixture.redisFixture,
              dependencyLayout: fixture.dependencyLayout,
              error: failure?.stack,
            },
            null,
            2,
          ) + "\n",
        )
        context.diagnostic(`Evidence: ${fixture.runRoot}`)
      }
    },
  )

// 原 PM2 app.js 拒绝负例仅属于 0.3.1 历史行为。
// 当前普通入口、已有 daemon 与无关应用保留由 environment-pm2-auto.test.mjs 实测。
