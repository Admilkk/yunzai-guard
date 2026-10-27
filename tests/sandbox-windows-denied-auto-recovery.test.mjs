import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { createHash } from "node:crypto"
import { execFileSync, spawn, spawnSync } from "node:child_process"
import { fileURLToPath, pathToFileURL } from "node:url"
import test from "node:test"

const repository = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")
const enabled = process.platform === "win32" && process.env.GUARD_TEST_DENIED_RECOVERY === "1"
const sha = file => createHash("sha256").update(fs.readFileSync(file)).digest("hex")
async function until(predicate, label) {
  const end = Date.now() + 30000
  while (Date.now() < end) {
    if (predicate()) return
    await new Promise(resolve => setTimeout(resolve, 20))
  }
  throw new Error(label)
}
const dacl = directory =>
  execFileSync(
    "powershell.exe",
    [
      "-NoProfile",
      "-NonInteractive",
      "-Command",
      `[IO.Directory]::GetAccessControl([Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${Buffer.from(directory).toString("base64")}'))).GetSecurityDescriptorSddlForm([Security.AccessControl.AccessControlSections]::Access)`,
    ],
    { encoding: "utf8", windowsHide: true },
  ).trim()

test(
  "a different plugin startup automatically recovers a killed broker's denied-directory lease",
  { skip: !enabled, timeout: 120000 },
  async t => {
    const run = fs.mkdtempSync(path.join(repository, "tests/runs/windows-denied-auto-"))
    const product = path.join(run, "product")
    fs.cpSync(
      process.env.GUARD_TEST_PRIVATE_DIST ?? path.join(repository, "dist"),
      path.join(product, "dist"),
      { recursive: true },
    )
    fs.cpSync(path.join(repository, "native/windows"), path.join(product, "native/windows"), {
      recursive: true,
    })
    const { compileWindowsSandbox, windowsSandboxSourceNames } = await import(
      pathToFileURL(path.join(product, "dist/sandbox/windows.js"))
    )
    const helper = compileWindowsSandbox()
    const root = path.join(run, "fixture")
    const state = path.join(root, "data/yunzai-guard")
    for (const directory of [state, path.join(root, "plugins/one"), path.join(root, "plugins/two")])
      fs.mkdirSync(directory, { recursive: true })
    fs.writeFileSync(path.join(state, "canary.txt"), "synthetic-no-secrets")
    fs.writeFileSync(
      path.join(root, "probe.cjs"),
      `const fs=require("node:fs"),net=require("node:net");const socket=net.connect(process.env.YUNZAI_GUARD_PIPE);socket.once("connect",()=>{let read=false,list=false,write=false;try{fs.readFileSync("data/yunzai-guard/canary.txt");read=true}catch{}try{fs.readdirSync("data/yunzai-guard");list=true}catch{}try{fs.writeFileSync("data/yunzai-guard/forbidden.txt","bad");write=true}catch{}fs.writeFileSync(process.env.FIXTURE_OWN+"/original-data.txt","retained");socket.write(JSON.stringify({type:"preload-hello",pid:process.pid})+"\\n");socket.write(JSON.stringify({type:"probe",read,list,write})+"\\n")});setInterval(()=>{},1000);`,
    )
    const watched = [root, state, path.join(root, "plugins/one"), path.join(root, "plugins/two")]
    const before = watched.map(dacl)
    const sessions = []
    const report = {
      root,
      helperSha256: sha(helper),
      sourceHashes: Object.fromEntries(
        windowsSandboxSourceNames.map(name => [
          name,
          sha(path.join(product, "native/windows", name)),
        ]),
      ),
      errors: [],
    }
    function launch(own) {
      const directory = fs.mkdtempSync(
        path.join(fs.realpathSync(os.tmpdir()), "yunzai-guard-windows-"),
      )
      const runtime = path.join(directory, "runtime")
      fs.mkdirSync(runtime)
      const executable = path.join(runtime, "node.exe")
      fs.copyFileSync(process.execPath, executable)
      const journal = path.join(directory, "journal.json")
      const child = spawn(
        helper,
        [
          "--root",
          root,
          "--journal",
          journal,
          "--read",
          runtime,
          "--network",
          "none",
          "--discard-output",
          "true",
          "--write",
          path.join(root, "plugins", own),
          "--deny",
          state,
          "--",
          executable,
          "--preserve-symlinks",
          "--preserve-symlinks-main",
          path.join(root, "probe.cjs"),
        ],
        {
          cwd: root,
          env: { ...process.env, FIXTURE_OWN: `plugins/${own}` },
          windowsHide: true,
          stdio: ["pipe", "pipe", "pipe"],
        },
      )
      const session = { child, journal, directory, own, stdout: "", stderr: "" }
      child.stdout.on("data", bytes => (session.stdout += bytes))
      child.stderr.on("data", bytes => (session.stderr += bytes))
      child.stdin.on("error", () => {})
      child.on("error", error => report.errors.push(error.message))
      sessions.push(session)
      return session
    }
    const frames = session =>
      session.stdout.split(/\r?\n/).flatMap(line => {
        try {
          return [JSON.parse(line)]
        } catch {
          return []
        }
      })
    const live = async session => {
      await until(
        () => frames(session).some(row => row.message?.type === "probe"),
        `Guest did not become live: ${session.stdout} ${session.stderr}`,
      )
      const probe = frames(session).find(row => row.message?.type === "probe").message
      assert.deepEqual(probe, { type: "probe", read: false, list: false, write: false })
      return frames(session).find(row => row.type === "ready")
    }
    try {
      const first = launch("one")
      report.firstReady = await live(first)
      first.child.kill("SIGKILL")
      await until(
        () => first.child.exitCode !== null || first.child.signalCode !== null,
        "Killed broker did not exit",
      )
      assert.equal(fs.existsSync(first.journal), true, "Forced exit must leave recovery work")
      report.originalJournalRetainedAfterKill = true
      const second = launch("two")
      report.secondReady = await live(second)
      assert.equal(
        fs.existsSync(first.journal),
        false,
        "New scope must automatically recover the older journal",
      )
      report.automaticRecoveryConfirmed = true
      assert.equal(dacl(root).includes(report.firstReady.appContainerSid), false)
      second.child.stdin.write(JSON.stringify({ type: "stop" }) + "\n")
      await until(
        () => second.child.exitCode !== null || second.child.signalCode !== null,
        "Second broker did not stop",
      )
      assert.equal(fs.existsSync(second.journal), false)
      assert.deepEqual(watched.map(dacl), before)
      for (const own of ["one", "two"])
        assert.equal(
          fs.readFileSync(path.join(root, "plugins", own, "original-data.txt"), "utf8"),
          "retained",
        )
      assert.deepEqual(report.errors, [])
      report.originalDaclsRestored = true
      report.originalDataRetained = true
      report.status = "passed"
      t.diagnostic(`Automatic denied-directory lease recovery evidence retained at ${run}`)
    } catch (error) {
      report.failure = error.stack
      throw error
    } finally {
      try {
        for (const session of sessions) {
          if (session.child.exitCode === null && session.child.signalCode === null)
            session.child.kill("SIGKILL")
          await until(
            () => session.child.exitCode !== null || session.child.signalCode !== null,
            "Test broker cleanup timed out",
          )
          if (fs.existsSync(session.journal)) {
            const cleaned = spawnSync(helper, ["--cleanup", session.journal], {
              windowsHide: true,
              encoding: "utf8",
              timeout: 30000,
            })
            assert.equal(cleaned.status, 0, cleaned.stdout + cleaned.stderr)
          }
          assert.equal(fs.existsSync(session.journal), false)
          const absolute = fs.realpathSync(session.directory)
          assert.equal(path.dirname(absolute), fs.realpathSync(os.tmpdir()))
          assert.match(path.basename(absolute), /^yunzai-guard-windows-/)
          fs.rmSync(absolute, { recursive: true, force: true })
        }
        report.cleanupConfirmed = true
      } catch (error) {
        report.cleanupFailure = error.stack
        throw error
      } finally {
        fs.writeFileSync(path.join(run, "report.json"), JSON.stringify(report, null, 2) + "\n")
      }
    }
  },
)
