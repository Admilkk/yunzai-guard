import assert from "node:assert/strict"
import fs from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { execFileSync } from "node:child_process"
import { performance } from "node:perf_hooks"
import test from "node:test"
import { spawnWindowsSandbox } from "../dist/sandbox/windows.js"

const repository = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
const supported = process.platform === "win32"
function security(target, file = false) {
  const encoded = Buffer.from(target, "utf8").toString("base64")
  return execFileSync(
    "powershell.exe",
    [
      "-NoProfile",
      "-NonInteractive",
      "-Command",
      `$guardTarget=[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${encoded}')); [IO.${file ? "File" : "Directory"}]::GetAccessControl($guardTarget).GetSecurityDescriptorSddlForm([Security.AccessControl.AccessControlSections]::Access)`,
    ],
    { encoding: "utf8", windowsHide: true },
  ).trim()
}
function externalReadRule(target, add) {
  const encoded = Buffer.from(target, "utf8").toString("base64")
  execFileSync(
    "powershell.exe",
    [
      "-NoProfile",
      "-NonInteractive",
      "-Command",
      `$guardTarget=[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${encoded}')); $guardAcl=[IO.File]::GetAccessControl($guardTarget); $guardSid=New-Object Security.Principal.SecurityIdentifier('S-1-5-32-545'); $guardRule=New-Object Security.AccessControl.FileSystemAccessRule($guardSid,[Security.AccessControl.FileSystemRights]::ReadAttributes,[Security.AccessControl.AccessControlType]::Allow); $guardAcl.${add ? "AddAccessRule" : "RemoveAccessRuleSpecific"}($guardRule); [IO.File]::SetAccessControl($guardTarget,$guardAcl)`,
    ],
    { encoding: "utf8", windowsHide: true },
  )
}
function fixture() {
  const runs = path.join(repository, "tests/runs")
  fs.mkdirSync(runs, { recursive: true })
  const root = fs.mkdtempSync(path.join(runs, "windows-file-grant-"))
  for (const dir of ["plugins/fixture", "config", "data/yunzai-guard"])
    fs.mkdirSync(path.join(root, dir), { recursive: true })
  for (const [name, value] of [
    ["KOOK.yaml", "original"],
    ["other-plugin.yaml", "peer-original"],
    ["bot.yaml", "core-original"],
  ])
    fs.writeFileSync(path.join(root, "config", name), value)
  const program = path.join(root, "probe.cjs")
  fs.writeFileSync(
    program,
    `
    const fs=require('node:fs'),net=require('node:net');
    const socket=net.connect(process.env.YUNZAI_GUARD_PIPE);
    socket.on('connect',()=>socket.write(JSON.stringify({type:'preload-hello',pid:process.pid})+'\\n'));
    socket.once('data',()=>{
      const results={};
      function check(name,fn){try{fn();results[name]='allowed'}catch(error){results[name]=error.code}}
      check('exact',()=>fs.writeFileSync('config/KOOK.yaml','plugin-updated'));
      check('append',()=>fs.appendFileSync('config/KOOK.yaml','-appended'));
      check('peer',()=>fs.writeFileSync('config/other-plugin.yaml','tamper'));
      check('core',()=>fs.writeFileSync('config/bot.yaml','tamper'));
      check('newFile',()=>fs.writeFileSync('config/new.yaml','tamper'));
      check('delete',()=>fs.unlinkSync('config/KOOK.yaml'));
      check('rename',()=>fs.renameSync('config/KOOK.yaml','config/renamed.yaml'));
      check('own',()=>fs.writeFileSync('plugins/fixture/own.txt','allowed'));
      socket.write(JSON.stringify({type:'result',results})+'\\n');
    });setInterval(()=>{},1000);
  `,
  )
  return { root, program }
}
const wait = async predicate => {
  const deadline = performance.now() + 15000
  while (performance.now() < deadline) {
    if (predicate()) return
    await new Promise(resolve => setTimeout(resolve, 20))
  }
  throw new Error("Exact file AppContainer probe timed out")
}

test(
  "AppContainer exact file grants preserve sibling and parent denial and restore ACLs",
  { skip: !supported, timeout: 60000 },
  async t => {
    const { root, program } = fixture()
    const target = path.join(root, "config/KOOK.yaml")
    const before = [security(root), security(path.join(root, "config")), security(target, true)]
    for (const force of [false, true]) {
      const child = spawnWindowsSandbox(
        root,
        {
          shutdownTimeout: 1000,
          sandbox: {
            network: "none",
            writablePaths: ["plugins/fixture"],
            writableFiles: ["config/KOOK.yaml"],
          },
        },
        {
          executable: process.execPath,
          args: [program],
          env: { ...process.env },
          forwardOutput: false,
        },
      )
      const errors = []
      let results
      child.on("error", error => errors.push(error.message))
      child.on("message", message => {
        if (message.type === "preload-hello") child.send({ type: "probe" })
        if (message.type === "result") results = message.results
      })
      try {
        await wait(() => results || errors.length)
        assert.deepEqual(errors, [])
        assert.equal(results.exact, "allowed")
        assert.equal(results.append, "allowed")
        assert.equal(results.own, "allowed")
        for (const key of ["peer", "core", "newFile", "delete", "rename"])
          assert.notEqual(results[key], "allowed", `${key} must remain denied`)
        const journal = JSON.parse(
          fs.readFileSync(path.join(child.sandboxSession, "journal.json"), "utf8"),
        )
        const record = journal.records.find(
          item => item.path.toLowerCase() === target.toLowerCase(),
        )
        assert.equal(record.isFile, true)
        assert.match(record.fileIdentity, /^[a-f0-9]{8}:[a-f0-9]{16}$/)
        assert.ok(
          record.aces.every(ace => ace.inheritance === 0),
          "File ACEs must not inherit",
        )
        assert.match(security(target, true), new RegExp(`\\(A;;[^)]*;${journal.sid}\\)`))
        // 宿主并发 ACL 修改必须在正常清理和崩溃日志清理后保留。
        externalReadRule(target, true)
        if (force) {
          child.kill("SIGKILL")
          await child.sandboxCleanup
        } else await child.sandboxDispose()
        assert.match(security(target, true), /;;;BU\)/)
        assert.equal(security(target, true).includes(journal.sid), false)
        externalReadRule(target, false)
        assert.deepEqual(
          [security(root), security(path.join(root, "config")), security(target, true)],
          before,
        )
        assert.equal(
          fs.readFileSync(target, "utf8"),
          "plugin-updated-appended",
          "Cleanup must retain plugin business data",
        )
        assert.equal(
          fs.readFileSync(path.join(root, "config/other-plugin.yaml"), "utf8"),
          "peer-original",
        )
        assert.equal(fs.readFileSync(path.join(root, "config/bot.yaml"), "utf8"), "core-original")
        assert.equal(fs.existsSync(child.sandboxSession), false)
      } finally {
        await child.sandboxDispose()
      }
    }
    t.diagnostic(`Benign exact-file fixture retained at ${root}`)
  },
)

test(
  "exact file grants reject missing files, hardlinks, junction parents and core/Guard paths",
  { skip: !supported, timeout: 30000 },
  t => {
    const { root, program } = fixture()
    const options = {
      executable: process.execPath,
      args: [program],
      env: { ...process.env },
      forwardOutput: false,
    }
    const launch = file =>
      spawnWindowsSandbox(
        root,
        { sandbox: { network: "none", writablePaths: ["plugins/fixture"], writableFiles: [file] } },
        options,
      )
    assert.throws(() => launch("config/missing.yaml"), /ENOENT/)
    assert.throws(() => launch("config/bot.yaml"), /protected core/)
    assert.throws(() => launch("data/yunzai-guard/private.json"), /Guard/)
    const original = path.join(root, "config/KOOK.yaml"),
      alias = path.join(root, "config/linked.yaml")
    fs.linkSync(original, alias)
    assert.throws(() => launch("config/linked.yaml"), /single-link/)
    fs.unlinkSync(alias)
    const junction = path.join(root, "config/linked-dir")
    fs.symlinkSync(path.join(root, "plugins/fixture"), junction, "junction")
    fs.writeFileSync(path.join(root, "plugins/fixture/test.yaml"), "unchanged")
    assert.throws(() => launch("config/linked-dir/test.yaml"), /重解析点/)
    fs.unlinkSync(junction)
    t.diagnostic(`Rejected exact-file fixture retained at ${root}`)
  },
)
