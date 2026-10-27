import fs from "node:fs"
import path from "node:path"
import net from "node:net"
import assert from "node:assert/strict"
import { execFileSync } from "node:child_process"
import { createHash } from "node:crypto"
import { createEnvironmentFixture, until } from "./environment-fixture.mjs"

const stateSchemaVersion = 2
const guardHashScope = "index-dist-native-recursive-regular-files-v1"

function guardFileHashes(pluginDir) {
  const rootStat = fs.lstatSync(pluginDir)
  assert.ok(
    !rootStat.isSymbolicLink() && rootStat.isDirectory(),
    "Guard root must be a real directory",
  )
  const files = new Map()
  const visit = relative => {
    const filename = path.join(pluginDir, relative)
    const stat = fs.lstatSync(filename)
    assert.ok(!stat.isSymbolicLink(), `Guard hash scope rejects symbolic links: ${relative}`)
    if (stat.isDirectory()) {
      for (const name of fs.readdirSync(filename).sort()) visit(path.join(relative, name))
    } else {
      assert.ok(stat.isFile(), `Guard hash scope requires regular files: ${relative}`)
      files.set(relative.split(path.sep).join("/"), hash(filename))
    }
  }
  for (const entry of ["index.js", "dist", "native"]) {
    const stat = fs.lstatSync(path.join(pluginDir, entry))
    assert.ok(!stat.isSymbolicLink(), `Guard hash scope rejects symbolic links: ${entry}`)
    assert.ok(
      entry === "index.js" ? stat.isFile() : stat.isDirectory(),
      `Invalid Guard hash entry: ${entry}`,
    )
    visit(entry)
  }
  return Object.fromEntries([...files].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)))
}

function requireCompleteHashState(state) {
  assert.equal(
    state.schemaVersion,
    stateSchemaVersion,
    "Legacy flat Guard hash state is preserved but cannot qualify recursive coverage; provision a fresh scenario",
  )
  assert.equal(state.guardHashScope, guardHashScope, "Guard hash coverage scope mismatch")
  assert.ok(Array.isArray(state.fixtures) && state.fixtures.length > 0)
  for (const fixture of state.fixtures)
    assert.ok(fixture.guardHashes && !fixture.distHashes, "Recursive Guard hashes are required")
}

async function waitOnline(fixture, timeout = 60000) {
  const current = await until(
    async () => {
      try {
        const credential = JSON.parse(
          fs.readFileSync(path.join(fixture.root, "data/yunzai-guard/control.json")),
        )
        const value = await new Promise((resolve, reject) => {
          const socket = net.connect(credential.port, "127.0.0.1")
          let data = ""
          socket.setTimeout(3000, () => socket.destroy(new Error("Control timeout")))
          socket.on("error", reject)
          socket.on("connect", () =>
            socket.write(JSON.stringify({ token: credential.token, command: "status" }) + "\n"),
          )
          socket.on("data", chunk => {
            data += chunk
            if (data.includes("\n")) {
              socket.end()
              resolve(JSON.parse(data.split("\n")[0]))
            }
          })
        })
        return value.phase === "online" || value.phase === "tripped" ? value : false
      } catch {
        return false
      }
    },
    "Fixture did not restore controlled worker",
    timeout,
  )
  assert.notEqual(current.phase, "tripped", `Fixture startup tripped: ${current.trippedReason}`)
  return current
}

// 探针仅在明确准备的可丢弃客户环境中运行。
assert.equal(process.env.GUARD_TEST_SYSTEMD_VM, "1")
assert.equal(process.platform, "linux")
assert.equal(fs.readFileSync("/etc/hostname", "utf8").trim(), "guard-systemd-test")
assert.equal(fs.readFileSync("/proc/1/comm", "utf8").trim(), "systemd")
const root = path.resolve("tests/runs/systemd-vm")
fs.mkdirSync(root, { recursive: true })
const stateFile = path.join(root, "state.json")
const preparedFile = path.join(root, "prepared.json")
const resultFile = path.join(root, "results.json")
const pm2 = args => execFileSync("pm2", args, { encoding: "utf8", timeout: 90000 })
const hash = file => createHash("sha256").update(fs.readFileSync(file)).digest("hex")
const pause = ms => new Promise(resolve => setTimeout(resolve, ms))
const command = process.argv[2]
if (command === "setup" || command === "prepare") {
  assert.ok(!fs.existsSync(stateFile), "Do not overwrite an existing VM scenario")
  const prepared = process.argv.includes("--prepared")
  const preparation = prepared ? JSON.parse(fs.readFileSync(preparedFile)) : undefined
  if (preparation) requireCompleteHashState(preparation)
  const fixtures = preparation?.fixtures ?? []
  const modes = process.argv.includes("--managed-only") ? ["managed"] : ["managed", "os-sandbox"]
  for (const mode of prepared ? [] : modes) {
    const fixture = await createEnvironmentFixture({ mode, label: "systemd-" + mode })
    const guardHashes = guardFileHashes(fixture.pluginDir)
    const config = path.join(fixture.runRoot, "ecosystem.config.cjs")
    fs.writeFileSync(
      config,
      "module.exports=" +
        JSON.stringify({
          apps: [
            {
              name: "guard-" + mode,
              script: path.join(fixture.root, "app.js"),
              cwd: fixture.root,
              exec_mode: "fork",
              instances: 1,
              env: { app_type: "pm2" },
            },
          ],
        }),
    )
    fixtures.push({
      mode,
      root: fixture.root,
      config,
      configHash: hash(config),
      expectedHashes: fixture.expectedHashes,
      guardHashes,
    })
  }
  if (command === "prepare") {
    fs.writeFileSync(
      preparedFile,
      JSON.stringify({ schemaVersion: stateSchemaVersion, guardHashScope, fixtures }),
      { flag: "wx" },
    )
    console.log("PREPARE PASSED")
  } else {
    for (const fixture of fixtures) {
      pm2(["start", fixture.config])
      const current = await waitOnline(fixture)
      assert.equal(current.phase, "online")
      assert.deepEqual(
        guardFileHashes(path.join(fixture.root, "plugins/yunzai-guard")),
        fixture.guardHashes,
      )
    }
    const resident = path.join(root, "resident.cjs")
    fs.writeFileSync(resident, "setInterval(()=>{},1000)\n")
    pm2(["start", resident, "--name", "guard-resident"])
    pm2(["save"])
    fs.writeFileSync(
      stateFile,
      JSON.stringify({ schemaVersion: stateSchemaVersion, guardHashScope, fixtures }),
    )
    console.log("SETUP PASSED")
  }
} else if (command === "verify") {
  const state = JSON.parse(fs.readFileSync(stateFile))
  requireCompleteHashState(state)
  const bootId = fs.readFileSync("/proc/sys/kernel/random/boot_id", "utf8").trim()
  const previous = fs.existsSync(resultFile) ? JSON.parse(fs.readFileSync(resultFile)) : []
  assert.ok(Array.isArray(previous))
  for (const result of previous)
    assert.ok(
      result.schemaVersion === stateSchemaVersion && result.guardHashScope === guardHashScope,
      "Legacy results are preserved; do not append recursive coverage to a flat-history scenario",
    )
  const label = process.argv[3]
  if (label.startsWith("reboot"))
    assert.notEqual(bootId, previous.at(-1).bootId, "A real guest kernel reboot is required")
  assert.equal(
    execFileSync("systemctl", ["is-active", "pm2-guard"], { encoding: "utf8" }).trim(),
    "active",
  )
  assert.equal(
    execFileSync("systemctl", ["is-enabled", "pm2-guard"], { encoding: "utf8" }).trim(),
    "enabled",
  )
  const daemon = Number(
    execFileSync("systemctl", ["show", "pm2-guard", "-p", "MainPID", "--value"], {
      encoding: "utf8",
    }),
  )
  assert.equal(daemon, Number(fs.readFileSync(path.join(process.env.HOME, ".pm2/pm2.pid"))))
  const statuses = []
  for (const fixture of state.fixtures) {
    const current = await waitOnline(fixture, 90000)
    assert.equal(current.generation, 1)
    assert.equal(current.recoveryCount, 0)
    assert.equal(current.capabilities.osSandbox, fixture.mode === "os-sandbox")
    for (const [file, expected] of Object.entries(fixture.expectedHashes))
      assert.equal(hash(path.join(fixture.root, file)), expected)
    assert.deepEqual(
      guardFileHashes(path.join(fixture.root, "plugins/yunzai-guard")),
      fixture.guardHashes,
    )
    assert.equal(hash(fixture.config), fixture.configHash)
    const rows = JSON.parse(pm2(["jlist", "--silent"]))
    assert.equal(rows.length, state.fixtures.length + 1)
    const target = rows.filter(row => row.name === "guard-" + fixture.mode)
    assert.equal(target.length, 1)
    assert.equal(target[0].pid, current.hostPid)
    assert.equal(target[0].pm2_env.status, "online")
    assert.ok(target[0].pm2_env.pm_exec_path.endsWith("/dist/launcher.js"))
    assert.equal(rows.find(row => row.name === "guard-resident").pm2_env.status, "online")
    assert.ok(!JSON.stringify(rows).includes("YUNZAI_GUARD_PM2_TICKET"))
    statuses.push({
      mode: fixture.mode,
      hostPid: current.hostPid,
      workerPid: current.workerPid,
      generation: current.generation,
    })
  }
  const dump = fs.readFileSync(path.join(process.env.HOME, ".pm2/dump.pm2"), "utf8")
  assert.ok(!dump.includes("YUNZAI_GUARD_PM2_TICKET"))
  await pause(1000)
  const result = {
    schemaVersion: stateSchemaVersion,
    guardHashScope,
    label,
    bootId,
    daemon,
    statuses,
    coreFilesUnchanged: true,
    distUnchanged: true,
    guardFilesUnchanged: true,
    unitActiveAndEnabled: true,
    ticketAbsent: true,
  }
  previous.push(result)
  fs.writeFileSync(resultFile, JSON.stringify(previous, null, 2))
  console.log(JSON.stringify(result))
} else throw new Error("Expected prepare, setup or verify")
