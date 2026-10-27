import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { execFileSync, spawn, spawnSync } from "node:child_process"
import { createHash } from "node:crypto"
import { fileURLToPath } from "node:url"
import test from "node:test"
import { compileWindowsSandbox, windowsSandboxSourceNames } from "../dist/sandbox/windows.js"

const repository = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))
function ledgerPath(root, target) {
  const hash = value => createHash("sha256").update(path.resolve(value).toUpperCase()).digest("hex")
  return path.join(
    process.env.LOCALAPPDATA,
    "YunzaiGuard/WindowsSandboxLabels",
    hash(root),
    hash(target) + ".json",
  )
}
async function stopped(child) {
  if (child.exitCode !== null) return { code: child.exitCode, signal: null }
  return new Promise(resolve => child.once("exit", (code, signal) => resolve({ code, signal })))
}
function hostMutation(helper, input) {
  const payload = Buffer.from(JSON.stringify({ helper, ...input })).toString("base64")
  const script = `$ErrorActionPreference='Stop';$data=[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${payload}'))|ConvertFrom-Json;$type=[Reflection.Assembly]::LoadFrom([string]$data.helper).GetType('GuardSandbox');$flags=[Reflection.BindingFlags]'NonPublic,Static';if($data.operation -eq 'label'){$type.GetMethod('RestoreLabel',$flags).Invoke($null,@([string]$data.path,[string]$data.label))}elseif($data.operation -eq 'snapshot'){$acl=[IO.Directory]::GetAccessControl([string]$data.path);@{label=$type.GetMethod('ReadLabel',$flags).Invoke($null,@([string]$data.path));dacl=$acl.GetSecurityDescriptorSddlForm([Security.AccessControl.AccessControlSections]::Access)}|ConvertTo-Json -Compress}else{$sidText=$type.GetMethod('ProfileSid',$flags).Invoke($null,@([string]$data.profile));$sid=New-Object Security.Principal.SecurityIdentifier ([string]$sidText);$rule=New-Object Security.AccessControl.FileSystemAccessRule($sid,[Security.AccessControl.FileSystemRights]::Modify,([Security.AccessControl.InheritanceFlags]::ContainerInherit -bor [Security.AccessControl.InheritanceFlags]::ObjectInherit),[Security.AccessControl.PropagationFlags]::None,[Security.AccessControl.AccessControlType]::Allow);$acl=[IO.Directory]::GetAccessControl([string]$data.path);if($data.operation -eq 'add'){$acl.AddAccessRule($rule)}else{$acl.RemoveAccessRuleSpecific($rule)};[IO.Directory]::SetAccessControl([string]$data.path,$acl)}`
  const output = execFileSync(
    "powershell.exe",
    ["-NoProfile", "-NonInteractive", "-Command", script],
    { encoding: "utf8", windowsHide: true, timeout: 10000 },
  ).trim()
  return output ? JSON.parse(output) : undefined
}

test(
  "shared directory journal replays real broker exits at every durable permission checkpoint",
  { skip: process.platform !== "win32", timeout: 180000 },
  async () => {
    const run = fs.mkdtempSync(path.join(repository, "tests/runs/windows-shared-recovery-"))
    const source = path.join(run, "GuardSharedLabels.cs")
    const checkpoint =
      'if (Environment.GetEnvironmentVariable("GUARD_LEASE_EXPERIMENT_CUT") == stage) Environment.Exit(91);'
    const originalSource = fs.readFileSync(
      path.join(repository, "native/windows/GuardSharedLabels.cs"),
      "utf8",
    )
    assert.equal(originalSource.split("/* GuardSharedLabelCheckpoint */").length, 2)
    fs.writeFileSync(source, originalSource.replace("/* GuardSharedLabelCheckpoint */", checkpoint))
    const helper = path.join(run, "GuardSandbox.exe")
    const compiler = path.join(
      process.env.SystemRoot,
      "Microsoft.NET/Framework64/v4.0.30319/csc.exe",
    )
    const compile = spawnSync(
      compiler,
      [
        "/nologo",
        "/target:exe",
        "/reference:System.Web.Extensions.dll",
        `/out:${helper}`,
        ...windowsSandboxSourceNames.map(name =>
          name === "GuardSharedLabels.cs" ? source : path.join(repository, "native/windows", name),
        ),
      ],
      { encoding: "utf8", windowsHide: true },
    )
    assert.equal(compile.status, 0, compile.stdout + compile.stderr)
    const productionHelper = compileWindowsSandbox()
    const report = {
      run,
      scope:
        "Actual helper with a test-copy-only Environment.Exit checkpoint; production source contains no environment-controlled exit",
      cuts: [],
    }
    const sessions = []
    function launch(root, cut) {
      const session = fs.mkdtempSync(
        path.join(fs.realpathSync(os.tmpdir()), "yunzai-guard-windows-"),
      )
      sessions.push(session)
      const runtime = path.join(session, "runtime")
      fs.mkdirSync(runtime)
      const executable = path.join(runtime, "node.exe")
      fs.copyFileSync(process.execPath, executable)
      const journal = path.join(session, "journal.json")
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
          "--shared-write",
          path.join(root, "data/UserData"),
          "--",
          executable,
          "--preserve-symlinks",
          "--preserve-symlinks-main",
          path.join(root, "probe.cjs"),
        ],
        {
          cwd: root,
          env: { ...process.env, GUARD_LEASE_EXPERIMENT_CUT: cut },
          windowsHide: true,
          stdio: ["pipe", "pipe", "pipe"],
        },
      )
      const result = { child, journal, session, stdout: "", stderr: "" }
      child.stdout.on("data", chunk => {
        result.stdout += chunk
      })
      child.stderr.on("data", chunk => {
        result.stderr += chunk
      })
      child.stdin.on("error", () => {})
      return result
    }
    async function ready(session) {
      const end = Date.now() + 15000
      while (!session.stdout.includes('"type":"live"')) {
        assert.equal(session.child.exitCode, null, session.stdout + session.stderr)
        assert.ok(Date.now() < end, session.stdout + session.stderr)
        await sleep(20)
      }
    }
    const plan = [
      ...["journal-prepared", "reserved", "low", "granted", "active"].map(stage => ({
        stage,
        peer: false,
        acquire: true,
      })),
      ...["journal-prepared", "reserved", "low", "granted", "active"].map(stage => ({
        stage,
        peer: true,
        acquire: true,
      })),
      ...[
        "releasing",
        "revoked-ace",
        "revoked",
        "restoring",
        "restored-label",
        "restored",
        "ledger-deleted",
      ].map(stage => ({ stage, peer: false, acquire: false })),
      ...["releasing", "revoked-ace", "revoked", "peer-removed"].map(stage => ({
        stage,
        peer: true,
        acquire: false,
      })),
    ]
    try {
      for (const item of plan) {
        const root = path.join(run, `${item.peer ? "peer" : "last"}-${item.stage}`),
          target = path.join(root, "data/UserData")
        fs.mkdirSync(target, { recursive: true })
        fs.writeFileSync(path.join(target, "original.txt"), "original-business-data")
        fs.writeFileSync(
          path.join(root, "probe.cjs"),
          "const fs=require('node:fs'),net=require('node:net');const socket=net.connect(process.env.YUNZAI_GUARD_PIPE);const send=message=>socket.write(JSON.stringify(message)+'\\n');socket.on('connect',()=>{send({type:'preload-hello',pid:process.pid});fs.appendFileSync('data/UserData/runtime.txt','guest\\n');send({type:'live'})});socket.on('data',()=>{fs.appendFileSync('data/UserData/runtime.txt','peer-after-recovery\\n');send({type:'still-live'})});setInterval(()=>{},1000)",
        )
        let peer
        const row = { ...item, root }
        report.cuts.push(row)
        try {
          if (item.peer) {
            peer = launch(root, "")
            await ready(peer)
          }
          const broken = launch(root, item.stage)
          if (!item.acquire) {
            await ready(broken)
            broken.child.stdin.write('{"type":"stop"}\n')
          }
          const end = await stopped(broken.child)
          assert.equal(end.code, 91, broken.stdout + broken.stderr)
          row.exit = end
          row.journal = JSON.parse(fs.readFileSync(broken.journal, "utf8"))
          const filename = ledgerPath(root, target)
          row.beforeRecovery = fs.existsSync(filename)
            ? JSON.parse(fs.readFileSync(filename, "utf8"))
            : null
          if (item.peer)
            assert.equal(
              row.beforeRecovery.originalLabel.includes(";;;LW)"),
              false,
              "A peer Low must never become original",
            )
          const cleanup = spawnSync(productionHelper, ["--cleanup", broken.journal], {
            encoding: "utf8",
            windowsHide: true,
            timeout: 20000,
          })
          row.recovery = { status: cleanup.status, stdout: cleanup.stdout, stderr: cleanup.stderr }
          assert.equal(cleanup.status, 0, cleanup.stdout + cleanup.stderr)
          assert.equal(fs.existsSync(broken.journal), false)
          row.afterRecovery = fs.existsSync(filename)
            ? JSON.parse(fs.readFileSync(filename, "utf8"))
            : null
          if (item.peer) {
            assert.equal(row.afterRecovery.members.length, 1)
            assert.equal(
              row.afterRecovery.members[0].profile,
              JSON.parse(fs.readFileSync(peer.journal, "utf8")).profile,
            )
            assert.equal(peer.child.exitCode, null)
            peer.child.stdin.write('{"type":"ipc","message":{"type":"probe"}}\n')
            const liveEnd = Date.now() + 10000
            while (!peer.stdout.includes('"type":"still-live"')) {
              assert.ok(Date.now() < liveEnd, peer.stdout + peer.stderr)
              await sleep(20)
            }
          } else assert.equal(row.afterRecovery, null)
          assert.equal(
            fs.readFileSync(path.join(target, "original.txt"), "utf8"),
            "original-business-data",
          )
        } finally {
          if (peer && peer.child.exitCode === null) {
            peer.child.stdin.write('{"type":"stop"}\n')
            await stopped(peer.child)
          }
        }
        assert.equal(fs.existsSync(ledgerPath(root, target)), false)
      }
      const root = path.join(run, "external-changes"),
        target = path.join(root, "data/UserData")
      fs.mkdirSync(target, { recursive: true })
      fs.copyFileSync(path.join(report.cuts[0].root, "probe.cjs"), path.join(root, "probe.cjs"))
      fs.writeFileSync(path.join(target, "original.txt"), "original-business-data")
      const session = launch(root, ""),
        external = { root },
        rogueProfile = "YunzaiGuard." + "f".repeat(32)
      report.externalChanges = external
      const replay = () => {
        const result = spawnSync(productionHelper, ["--cleanup", session.journal], {
          encoding: "utf8",
          windowsHide: true,
          timeout: 20000,
        })
        return { status: result.status, stdout: result.stdout, stderr: result.stderr }
      }
      try {
        await ready(session)
        external.before = hostMutation(productionHelper, { operation: "snapshot", path: target })
        hostMutation(productionHelper, {
          operation: "label",
          path: target,
          label: "S:(ML;OICI;NW;;;ME)",
        })
        session.child.stdin.write('{"type":"stop"}\n')
        await stopped(session.child)
        assert.equal(
          fs.existsSync(session.journal),
          true,
          "External Medium must retain the journal",
        )
        external.mediumRefusal = replay()
        assert.equal(external.mediumRefusal.status, 1)
        assert.match(external.mediumRefusal.stdout, /changed externally/)
        external.afterMediumRefusal = hostMutation(productionHelper, {
          operation: "snapshot",
          path: target,
        })
        assert.match(external.afterMediumRefusal.label, /;;;ME\)/)
        hostMutation(productionHelper, {
          operation: "label",
          path: target,
          label: "S:(ML;OICI;NW;;;LW)",
        })
        hostMutation(productionHelper, { operation: "add", path: target, profile: rogueProfile })
        external.unknownWriterRefusal = replay()
        assert.equal(external.unknownWriterRefusal.status, 1)
        assert.match(external.unknownWriterRefusal.stdout, /untracked/)
        assert.equal(fs.existsSync(session.journal), true)
        hostMutation(productionHelper, { operation: "remove", path: target, profile: rogueProfile })
        external.afterHostRepair = replay()
        assert.equal(external.afterHostRepair.status, 0, external.afterHostRepair.stdout)
        external.idempotentReplay = replay()
        assert.equal(external.idempotentReplay.status, 0)
        assert.equal(fs.existsSync(session.journal), false)
        assert.equal(fs.existsSync(ledgerPath(root, target)), false)
        external.after = hostMutation(productionHelper, { operation: "snapshot", path: target })
        assert.equal(external.after.label.includes(";;;LW)"), false)
        assert.equal(
          fs.readFileSync(path.join(target, "original.txt"), "utf8"),
          "original-business-data",
        )
      } finally {
        if (session.child.exitCode === null) {
          session.child.stdin.write('{"type":"stop"}\n')
          await stopped(session.child)
        }
        if (fs.existsSync(session.journal)) {
          hostMutation(productionHelper, {
            operation: "remove",
            path: target,
            profile: rogueProfile,
          })
          hostMutation(productionHelper, {
            operation: "label",
            path: target,
            label: "S:(ML;OICI;NW;;;LW)",
          })
          external.finalRepair = replay()
        }
      }
      report.status = "21-real-broker-cut-replays-and-external-change-recovery-passed"
    } finally {
      fs.writeFileSync(path.join(run, "report.json"), JSON.stringify(report, null, 2) + "\n")
      // 只删除已确认日志清除的私有测试会话。
      for (const session of sessions)
        if (!fs.existsSync(path.join(session, "journal.json"))) {
          assert.equal(
            path.dirname(session).toLowerCase(),
            fs.realpathSync(os.tmpdir()).toLowerCase(),
          )
          assert.match(path.basename(session), /^yunzai-guard-windows-[\w-]+$/)
          fs.rmSync(session, { recursive: true, force: true })
        }
    }
  },
)
