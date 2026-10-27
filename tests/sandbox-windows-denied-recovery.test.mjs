import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { createHash } from "node:crypto"
import { execFileSync, spawn, spawnSync } from "node:child_process"
import { fileURLToPath, pathToFileURL } from "node:url"
import test from "node:test"
import { windowsSandboxSourceNames } from "../dist/sandbox/windows.js"

const repository = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")
const enabled = process.platform === "win32" && process.env.GUARD_TEST_DENIED_RECOVERY === "1"
const pause = ms => new Promise(resolve => setTimeout(resolve, ms))
const sha = value => createHash("sha256").update(value).digest("hex")
const controlPath = root => path.join(root, "data/yunzai-guard")
const cachePath = root => path.join(root, "plugins/yunzai-guard/.cache")
function ledgerPath(root, target) {
  const key = value => sha(path.resolve(value).toUpperCase())
  return path.join(
    process.env.LOCALAPPDATA,
    "YunzaiGuard/WindowsSandboxLabels",
    key(root),
    `deny-${key(target)}.json`,
  )
}
function host(input) {
  const encoded = Buffer.from(JSON.stringify(input)).toString("base64")
  const script = `$ErrorActionPreference='Stop'
$item=[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${encoded}'))|ConvertFrom-Json
$acl=[IO.Directory]::GetAccessControl([string]$item.path)
if($item.operation -eq 'protect'){
  $acl.SetAccessRuleProtection([bool]$item.value,$true)
  [IO.Directory]::SetAccessControl([string]$item.path,$acl)
}elseif($item.operation -eq 'fixture-restore-intent'){
  $acl.SetSecurityDescriptorSddlForm([string]$item.dacl,[Security.AccessControl.AccessControlSections]::Access)
  [IO.Directory]::SetAccessControl([string]$item.path,$acl)
}elseif($item.operation -eq 'add' -or $item.operation -eq 'repair-rule'){
  $sid=New-Object Security.Principal.SecurityIdentifier ([string]$item.sid)
  if($item.operation -eq 'repair-rule'){
    foreach($rule in @($acl.GetAccessRules($true,$false,[Security.Principal.SecurityIdentifier]))){
      if($rule.IdentityReference.Value -eq $item.sid){$acl.RemoveAccessRuleSpecific($rule)}
    }
  }
  $inherit=([Security.AccessControl.InheritanceFlags]::ContainerInherit -bor [Security.AccessControl.InheritanceFlags]::ObjectInherit)
  $rule=New-Object Security.AccessControl.FileSystemAccessRule($sid,[Security.AccessControl.FileSystemRights]([int]$item.rights),$inherit,[Security.AccessControl.PropagationFlags]::None,[Security.AccessControl.AccessControlType]::Allow)
  $acl.AddAccessRule($rule)
  [IO.Directory]::SetAccessControl([string]$item.path,$acl)
}
$acl=[IO.Directory]::GetAccessControl([string]$item.path)
$rules=@($acl.GetAccessRules($true,$true,[Security.Principal.SecurityIdentifier])|ForEach-Object{@{sid=$_.IdentityReference.Value;rights=[int]$_.FileSystemRights;type=[int]$_.AccessControlType;inheritance=[int]$_.InheritanceFlags;propagation=[int]$_.PropagationFlags;inherited=$_.IsInherited}})
@{protected=$acl.AreAccessRulesProtected;dacl=$acl.GetSecurityDescriptorSddlForm([Security.AccessControl.AccessControlSections]::Access);rules=$rules}|ConvertTo-Json -Compress -Depth 5`
  return JSON.parse(
    execFileSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script], {
      windowsHide: true,
      encoding: "utf8",
      timeout: 10000,
    }).trim(),
  )
}
async function until(predicate, description, timeout = 25000) {
  const end = Date.now() + timeout
  while (Date.now() < end) {
    const result = predicate()
    if (result) return result
    await pause(20)
  }
  throw new Error(description)
}
async function stopped(session, timeout = 25000) {
  await until(
    () => session.child.exitCode !== null || session.child.signalCode !== null,
    `Broker did not stop: ${session.stdout}\n${session.stderr}`,
    timeout,
  )
  return { code: session.child.exitCode, signal: session.child.signalCode }
}
function messages(session) {
  return session.stdout.split(/\r?\n/).flatMap(line => {
    try {
      const row = JSON.parse(line)
      return row.message ? [row.message] : []
    } catch {
      return []
    }
  })
}

test(
  "denied control-directory leases survive overlap, external changes and durable broker cuts",
  {
    skip: enabled
      ? false
      : "requires Windows and GUARD_TEST_DENIED_RECOVERY=1; private fixture canaries only",
    timeout: 600000,
  },
  async t => {
    const dist = process.env.GUARD_TEST_PRIVATE_DIST ?? path.join(repository, "dist")
    const run = fs.mkdtempSync(path.join(repository, "tests/runs/windows-denied-recovery-"))
    const privateProduct = path.join(run, "product")
    fs.cpSync(path.resolve(dist), path.join(privateProduct, "dist"), { recursive: true })
    const moduleFile = path.join(privateProduct, "dist/sandbox/windows.js")
    const sourceRoot = path.join(privateProduct, "native/windows")
    fs.mkdirSync(sourceRoot, { recursive: true })
    for (const name of [...windowsSandboxSourceNames, "PrepareBrokerCache.ps1"])
      fs.copyFileSync(path.join(repository, "native/windows", name), path.join(sourceRoot, name))
    assert.ok(
      fs.existsSync(path.join(sourceRoot, "GuardDeniedDirectories.cs")),
      "Use the new private build with GuardDeniedDirectories.cs; never test a historical helper",
    )
    const { compileWindowsSandbox } = await import(pathToFileURL(moduleFile))
    const productionHelper = compileWindowsSandbox()
    const sources = windowsSandboxSourceNames
    const sourceHashes = {}
    const checkpoint =
      'if (Environment.GetEnvironmentVariable("GUARD_DENIED_EXPERIMENT_CUT") == stage) Environment.Exit(91);'
    const staged = []
    for (const name of sources) {
      const bytes = fs.readFileSync(path.join(sourceRoot, name))
      sourceHashes[name] = sha(bytes)
      let text = bytes.toString("utf8")
      if (name === "GuardDeniedDirectories.cs") {
        assert.equal(text.split("/* GuardDeniedDirectoryCheckpoint */").length, 2)
        text = text.replace("/* GuardDeniedDirectoryCheckpoint */", checkpoint)
      }
      const target = path.join(run, name)
      fs.writeFileSync(target, text)
      staged.push(target)
    }
    const helper = path.join(run, "GuardSandbox.exe")
    assert.ok(
      helper.length < 240,
      "The experiment must avoid the known CLR long-path executable boundary",
    )
    const compiler = path.join(
      process.env.SystemRoot,
      "Microsoft.NET/Framework64/v4.0.30319/csc.exe",
    )
    const built = spawnSync(
      compiler,
      [
        "/nologo",
        "/target:exe",
        "/reference:System.Web.Extensions.dll",
        `/out:${helper}`,
        ...staged,
      ],
      { windowsHide: true, encoding: "utf8" },
    )
    assert.equal(built.status, 0, built.stdout + built.stderr)
    const report = {
      run,
      sourceRoot,
      sourceHashes,
      productionHelper,
      productionHelperSha256: sha(fs.readFileSync(productionHelper)),
      checkpointHelperSha256: sha(fs.readFileSync(helper)),
      scope:
        "Real AppContainer/helper with fixture-only canaries and test-copy-only Environment.Exit injection; no real Guard state, token or production ACL. Direct broker stop intentionally TerminateJobObject(code=1); recovery success is verified independently",
      cuts: [],
      sessions: [],
    }
    const sessions = []
    const dummySid = "S-1-5-21-111111111-222222222-333333333-424242"
    const collisionSid = "S-1-5-21-111111111-222222222-333333333-424243"
    let sequence = 0
    function fixture(label) {
      const root = path.join(run, label)
      for (const target of [
        controlPath(root),
        cachePath(root),
        path.join(root, "plugins/one"),
        path.join(root, "plugins/two"),
      ])
        fs.mkdirSync(target, { recursive: true })
      for (const target of [controlPath(root), cachePath(root)])
        fs.writeFileSync(path.join(target, "canary.txt"), "dummy-protected-control-canary")
      fs.writeFileSync(
        path.join(root, "probe.cjs"),
        `const fs=require('node:fs'),net=require('node:net');
const socket=net.connect(process.env.YUNZAI_GUARD_PIPE),send=value=>socket.write(JSON.stringify(value)+'\\n');
const check=fn=>{try{fn();return {allowed:true}}catch(error){return {allowed:false,code:error.code}}};
const probe=()=>{const results={};for(const target of ['data/yunzai-guard','plugins/yunzai-guard/.cache'])results[target]={read:check(()=>fs.readFileSync(target+'/canary.txt')),list:check(()=>fs.readdirSync(target)),write:check(()=>fs.writeFileSync(target+'/unexpected.txt','bad'))};results.own=check(()=>fs.appendFileSync(process.env.FIXTURE_OWN+'/ordinary.txt','business\\n'));return results};
socket.on('connect',()=>{send({type:'preload-hello',pid:process.pid});send({type:'live',probe:probe()})});
socket.on('data',()=>send({type:'probe-result',request:++globalThis.requestCounter,probe:probe()}));globalThis.requestCounter=0;setInterval(()=>{},1000)
`,
      )
      return root
    }
    function launch(root, cut = "", own = "one") {
      const session = fs.mkdtempSync(
        path.join(fs.realpathSync(os.tmpdir()), "yunzai-guard-windows-"),
      )
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
          "--write",
          path.join(root, `plugins/${own}`),
          "--deny",
          controlPath(root),
          "--deny",
          cachePath(root),
          "--",
          executable,
          "--preserve-symlinks",
          "--preserve-symlinks-main",
          path.join(root, "probe.cjs"),
        ],
        {
          cwd: root,
          env: { ...process.env, GUARD_DENIED_EXPERIMENT_CUT: cut, FIXTURE_OWN: `plugins/${own}` },
          windowsHide: true,
          stdio: ["pipe", "pipe", "pipe"],
        },
      )
      const result = { child, journal, session, root, cut, own, stdout: "", stderr: "" }
      sessions.push(result)
      child.stdout.on("data", bytes => {
        result.stdout += bytes
      })
      child.stderr.on("data", bytes => {
        result.stderr += bytes
      })
      child.stdin.on("error", () => {})
      child.on("error", error => {
        result.stderr += String(error.stack)
      })
      return result
    }
    function assertProbe(probe) {
      for (const target of ["data/yunzai-guard", "plugins/yunzai-guard/.cache"])
        for (const operation of ["read", "list", "write"]) {
          assert.equal(probe[target][operation].allowed, false, `${target}:${operation}`)
          assert.ok(
            ["EACCES", "EPERM"].includes(probe[target][operation].code),
            JSON.stringify(probe[target][operation]),
          )
        }
      assert.equal(
        probe.own.allowed,
        true,
        "Ordinary explicitly granted business write must remain available",
      )
    }
    async function ready(session) {
      const row = await until(() => {
        assert.equal(session.child.exitCode, null, session.stdout + session.stderr)
        return messages(session).find(item => item.type === "live")
      }, "Sandbox never produced its actual canary probe")
      assertProbe(row.probe)
      return row
    }
    async function probe(session) {
      const before = messages(session).filter(row => row.type === "probe-result").length
      session.child.stdin.write('{"type":"ipc","message":{"type":"probe"}}\n')
      const row = await until(
        () => messages(session).filter(row => row.type === "probe-result")[before],
        "Peer did not respond after recovery",
      )
      assertProbe(row.probe)
      return row
    }
    const replay = session => {
      const result = spawnSync(productionHelper, ["--cleanup", session.journal], {
        windowsHide: true,
        encoding: "utf8",
        timeout: 30000,
      })
      return {
        status: result.status,
        signal: result.signal,
        stdout: result.stdout,
        stderr: result.stderr,
      }
    }
    const stop = async session => {
      if (session.child.exitCode === null && session.child.signalCode === null)
        session.child.stdin.write('{"type":"stop"}\n')
      return await stopped(session)
    }
    const stopHealthy = async session => {
      assert.equal(
        session.child.exitCode,
        null,
        "The canary must remain live until the explicit broker stop",
      )
      assert.equal(session.child.signalCode, null)
      const result = await stop(session)
      assert.equal(
        result.code,
        1,
        "The direct broker stop command intentionally terminates its Job with code 1",
      )
      assert.equal(fs.existsSync(session.journal), false, session.stderr)
    }
    const ledgers = root =>
      [controlPath(root), cachePath(root)].map(target => ({
        target,
        file: ledgerPath(root, target),
        value: fs.existsSync(ledgerPath(root, target))
          ? JSON.parse(fs.readFileSync(ledgerPath(root, target), "utf8"))
          : null,
      }))
    const verifyOriginal = root => {
      for (const target of [controlPath(root), cachePath(root)]) {
        assert.equal(
          fs.readFileSync(path.join(target, "canary.txt"), "utf8"),
          "dummy-protected-control-canary",
        )
        assert.equal(fs.existsSync(path.join(target, "unexpected.txt")), false)
      }
    }
    const assertClean = root => {
      for (const item of ledgers(root)) assert.equal(item.value, null)
      verifyOriginal(root)
    }
    try {
      for (const reverse of [false, true]) {
        const root = fixture(`overlap-${reverse ? "reverse" : "fifo"}`)
        const before = [controlPath(root), cachePath(root)].map(target => host({ path: target }))
        const one = launch(root, "", "one"),
          two = launch(root, "", "two")
        const row = { kind: "overlap", root, reverse, before }
        report.sessions.push(row)
        try {
          row.initialProbes = await Promise.all([ready(one), ready(two)])
          row.active = ledgers(root)
          for (const item of row.active) assert.equal(item.value.members.length, 2)
          const [first, last] = reverse ? [two, one] : [one, two]
          await stopHealthy(first)
          row.peerProbe = await probe(last)
          for (const item of ledgers(root)) assert.equal(item.value.members.length, 1)
          await stopHealthy(last)
          for (const [index, target] of [controlPath(root), cachePath(root)].entries())
            assert.equal(host({ path: target }).dacl, before[index].dacl)
          assertClean(root)
        } finally {
          await stop(one)
          await stop(two)
        }
      }
      for (const legacySid of ["S-1-15-2-1", "S-1-15-2-111-222-333-444-555-666-777"]) {
        const root = fixture(
          `legacy-read-${legacySid === "S-1-15-2-1" ? "all-packages" : "old-package"}`,
        )
        host({ operation: "add", path: root, sid: legacySid, rights: 131241 })
        const before = [root, controlPath(root), cachePath(root)].map(target =>
          host({ path: target }),
        )
        const session = launch(root)
        const row = { kind: "legacy-inherited-package-read-refusal", root, legacySid, before }
        report.sessions.push(row)
        try {
          row.exit = await stopped(session)
          assert.notEqual(row.exit.code, 0)
          assert.equal(
            session.stdout.includes('"type":"ready"'),
            false,
            "No Guest may start while a prior package read grant is inherited",
          )
          assert.match(session.stdout + session.stderr, /untracked AppContainer read grant/)
          row.after = [root, controlPath(root), cachePath(root)].map(target =>
            host({ path: target }),
          )
          assert.deepEqual(
            row.after.map(value => value.dacl),
            before.map(value => value.dacl),
            "A rejected baseline must not promote or reset the legacy ACL",
          )
          assert.equal(fs.existsSync(session.journal), false)
          assertClean(root)
        } finally {
          await stop(session)
        }
      }
      const plan = [
        ...["reserved", "protected", "active"].map(stage => ({
          stage,
          acquire: true,
          peer: false,
        })),
        ...["reserved", "protected", "active"].map(stage => ({ stage, acquire: true, peer: true })),
        ...[
          "releasing",
          "revoked-ace",
          "revoked",
          "restoring",
          "restored-acl",
          "restored",
          "ledger-deleted",
        ].map(stage => ({ stage, acquire: false, peer: false })),
        ...["releasing", "revoked-ace", "revoked", "peer-removed"].map(stage => ({
          stage,
          acquire: false,
          peer: true,
        })),
      ]
      for (const item of plan) {
        const root = fixture(`${++sequence}-${item.peer ? "peer" : "last"}-${item.stage}`)
        const baseline = [controlPath(root), cachePath(root)].map(target => host({ path: target }))
        const row = { ...item, root, baseline }
        report.cuts.push(row)
        let peer, broken
        try {
          if (item.peer) {
            peer = launch(root, "", "two")
            await ready(peer)
          }
          broken = launch(root, item.stage)
          if (!item.acquire) {
            await ready(broken)
            broken.child.stdin.write('{"type":"stop"}\n')
          }
          row.exit = await stopped(broken)
          assert.equal(row.exit.code, 91, broken.stdout + broken.stderr)
          assert.equal(fs.existsSync(broken.journal), true)
          row.journal = JSON.parse(fs.readFileSync(broken.journal, "utf8"))
          assert.equal(row.journal.version, 4)
          row.beforeRecovery = ledgers(root)
          row.recovery = replay(broken)
          assert.equal(row.recovery.status, 0, row.recovery.stdout + row.recovery.stderr)
          assert.equal(fs.existsSync(broken.journal), false)
          row.idempotentRecovery = replay(broken)
          assert.equal(row.idempotentRecovery.status, 0)
          if (peer) {
            for (const directory of ledgers(root)) assert.equal(directory.value.members.length, 1)
            row.peerProbe = await probe(peer)
            await stopHealthy(peer)
          }
          assertClean(root)
          for (const [index, target] of [controlPath(root), cachePath(root)].entries())
            assert.equal(host({ path: target }).dacl, baseline[index].dacl)
        } finally {
          if (broken) await stop(broken)
          if (peer) await stop(peer)
        }
      }
      {
        const root = fixture("original-already-protected")
        const before = [controlPath(root), cachePath(root)].map(target =>
          host({ operation: "protect", path: target, value: true }),
        )
        const session = launch(root)
        const row = { kind: "original-protected", root, before }
        report.sessions.push(row)
        try {
          await ready(session)
          await stopHealthy(session)
        } finally {
          await stop(session)
        }
        for (const [index, target] of [controlPath(root), cachePath(root)].entries()) {
          const after = host({ path: target })
          assert.equal(after.protected, true)
          assert.equal(after.dacl, before[index].dacl)
        }
        assertClean(root)
      }
      {
        const root = fixture("external-distinct-sid")
        const session = launch(root)
        const row = { kind: "external-distinct-sid", root }
        report.sessions.push(row)
        try {
          await ready(session)
          row.hostAdded = host({
            operation: "add",
            path: controlPath(root),
            sid: dummySid,
            rights: 128,
          })
          await stopHealthy(session)
          row.after = host({ path: controlPath(root) })
          assert.ok(
            row.after.rules.some(
              rule => rule.sid === dummySid && !rule.inherited && (rule.rights & 128) === 128,
            ),
          )
          assertClean(root)
        } finally {
          await stop(session)
        }
      }
      for (const mutation of ["inheritance", "same-key"]) {
        const root = fixture(`external-conflict-${mutation}`)
        if (mutation === "same-key")
          host({ operation: "add", path: root, sid: collisionSid, rights: 131241 })
        const session = launch(root)
        const target = controlPath(root)
        const row = { kind: `external-${mutation}-conflict`, root }
        report.sessions.push(row)
        try {
          await ready(session)
          row.before = host({ path: target })
          if (mutation === "inheritance") host({ operation: "protect", path: target, value: false })
          else host({ operation: "add", path: target, sid: collisionSid, rights: 2 })
          await stop(session)
          assert.equal(
            fs.existsSync(session.journal),
            true,
            "Conflicting host changes must preserve recovery ownership",
          )
          row.beforeReplay = host({ path: target })
          row.refusedRecovery = replay(session)
          assert.notEqual(row.refusedRecovery.status, 0)
          row.afterRefusal = host({ path: target })
          assert.equal(
            row.afterRefusal.dacl,
            row.beforeReplay.dacl,
            "A rejected recovery must not reset the external ACL",
          )
          assert.equal(row.afterRefusal.protected, row.beforeReplay.protected)
          if (mutation === "inheritance") host({ operation: "protect", path: target, value: true })
          else {
            const baselineRule = row.before.rules.filter(
              rule => rule.sid === collisionSid && !rule.inherited,
            )
            assert.equal(baselineRule.length, 1)
            host({
              operation: "repair-rule",
              path: target,
              sid: collisionSid,
              rights: baselineRule[0].rights,
            })
          }
          row.afterExplicitFixtureRepair = replay(session)
          assert.equal(
            row.afterExplicitFixtureRepair.status,
            0,
            JSON.stringify(row.afterExplicitFixtureRepair),
          )
          assert.equal(replay(session).status, 0)
          assertClean(root)
        } finally {
          await stop(session)
        }
      }
      {
        const root = fixture("restoring-cut-external-unprotect")
        const target = controlPath(root),
          session = launch(root, "restoring")
        const row = { kind: "restoring-cut-external-unprotect-conflict", root }
        report.sessions.push(row)
        try {
          await ready(session)
          session.child.stdin.write('{"type":"stop"}\n')
          assert.equal((await stopped(session)).code, 91)
          row.lease = JSON.parse(fs.readFileSync(ledgerPath(root, target), "utf8"))
          assert.equal(row.lease.members.length, 1)
          assert.equal(row.lease.members[0].phase, "restoring")
          assert.equal(typeof row.lease.restoreDacl, "string")
          row.beforeHostChange = host({ path: target })
          assert.equal(row.beforeHostChange.protected, true)
          // 仅切换标志位，保留提升后的显式 ACE，因此不构成原先保存的还原状态。
          row.afterHostChange = host({ operation: "protect", path: target, value: false })
          row.refusedRecovery = replay(session)
          assert.notEqual(
            row.refusedRecovery.status,
            0,
            "Protection-bit equality must not be mistaken for completed restoration",
          )
          assert.equal(fs.existsSync(session.journal), true)
          row.afterRefusal = host({ path: target })
          assert.equal(
            row.afterRefusal.dacl,
            row.afterHostChange.dacl,
            "Rejected recovery must not rewrite the host's changed ACL",
          )
          // 完成不重置的断言后，仅显式修复本夹具，不作为自动清理。
          row.explicitFixtureRepair = host({
            operation: "fixture-restore-intent",
            path: target,
            dacl: row.lease.restoreDacl,
          })
          row.afterExplicitFixtureRepair = replay(session)
          assert.equal(
            row.afterExplicitFixtureRepair.status,
            0,
            JSON.stringify(row.afterExplicitFixtureRepair),
          )
          assert.equal(replay(session).status, 0)
          assertClean(root)
        } finally {
          await stop(session)
        }
      }
      await t.test(
        "a reparse denied directory is rejected; unavailable link privilege is a skip",
        async st => {
          const root = fixture("reparse-refusal"),
            target = controlPath(root),
            moved = `${target}-owned-original`
          for (const candidate of [root, target, moved])
            assert.ok(path.resolve(candidate).startsWith(path.resolve(run) + path.sep))
          fs.renameSync(target, moved)
          let linked = false
          try {
            try {
              fs.symlinkSync(moved, target, "junction")
              linked = true
            } catch (error) {
              if (["EPERM", "EACCES"].includes(error.code)) {
                st.skip(`Fixture junction privilege unavailable: ${error.code}`)
                return
              }
              throw error
            }
            const before = host({ path: root }),
              session = launch(root)
            await stopped(session)
            assert.notEqual(session.child.exitCode, 0)
            assert.equal(fs.existsSync(session.journal), false)
            assert.equal(host({ path: root }).dacl, before.dacl)
          } finally {
            if (linked) {
              assert.equal(fs.lstatSync(target).isSymbolicLink(), true)
              fs.unlinkSync(target)
            }
            fs.renameSync(moved, target)
          }
        },
      )
      for (const [name, expected] of Object.entries(sourceHashes))
        assert.equal(
          sha(fs.readFileSync(path.join(sourceRoot, name))),
          expected,
          `Private source changed during acceptance: ${name}`,
        )
      report.status = "passed"
    } catch (error) {
      report.status = "failed"
      report.error = String(error.stack)
      throw error
    } finally {
      for (const session of sessions) {
        if (session.child.exitCode === null && session.child.signalCode === null)
          await stop(session)
        report.sessionEvidence ??= []
        report.sessionEvidence.push({
          root: session.root,
          privateSession: session.session,
          cut: session.cut,
          journal: session.journal,
          journalRetained: fs.existsSync(session.journal),
          exitCode: session.child.exitCode,
          signal: session.child.signalCode,
          stdout: session.stdout,
          stderr: session.stderr,
        })
      }
      fs.writeFileSync(path.join(run, "report.json"), JSON.stringify(report, null, 2) + "\n")
      t.diagnostic(`Evidence retained: ${run}`)
      // 保留夹具目录、私有会话和全部日志供检查，不重置 ACL 或删除现场。
    }
  },
)
