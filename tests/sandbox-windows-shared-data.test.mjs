import assert from "node:assert/strict"
import fs from "node:fs"
import path from "node:path"
import { execFileSync } from "node:child_process"
import { fileURLToPath } from "node:url"
import test from "node:test"
import {
  compileWindowsSandbox,
  spawnWindowsSandbox,
  windowsSandboxBuildDigest,
} from "../dist/sandbox/windows.js"

const repository = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")
const delay = ms => new Promise(resolve => setTimeout(resolve, ms))
function snapshot(helper, directories) {
  const payload = Buffer.from(JSON.stringify({ helper, directories })).toString("base64")
  const script = `$ErrorActionPreference='Stop';$data=[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${payload}'))|ConvertFrom-Json;$type=[Reflection.Assembly]::LoadFrom([string]$data.helper).GetType('GuardSandbox');$method=$type.GetMethod('ReadLabel',[Reflection.BindingFlags]'NonPublic,Static');$out=@{};foreach($item in $data.directories.psobject.Properties){$acl=[IO.Directory]::GetAccessControl([string]$item.Value);$out[$item.Name]=@{dacl=$acl.GetSecurityDescriptorSddlForm([Security.AccessControl.AccessControlSections]::Access);label=$method.Invoke($null,@([string]$item.Value))}};$out|ConvertTo-Json -Compress -Depth 4`
  return JSON.parse(
    execFileSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script], {
      encoding: "utf8",
      windowsHide: true,
      timeout: 10000,
    }),
  )
}

for (const parallel of [false, true])
  test(
    `three AppContainers share original data with ${parallel ? "parallel" : "sequential"} startup and preserve peer labels`,
    { skip: process.platform !== "win32", timeout: 90000 },
    async () => {
      const root = fs.mkdtempSync(path.join(repository, "tests/runs/windows-shared-data-"))
      const ids = ["first", "second", "third"]
      const shared = ["data/UserData", "data/PlayerData", "data/db"]
      const directories = Object.fromEntries(
        shared.map((value, index) => [`shared${index}`, path.join(root, value)]),
      )
      for (const directory of [
        ...Object.values(directories),
        ...ids.map(id => path.join(root, "plugins", id)),
      ])
        fs.mkdirSync(directory, { recursive: true })
      fs.mkdirSync(path.join(root, "lib"))
      fs.writeFileSync(path.join(root, "lib/core.txt"), "unchanged-core")
      fs.writeFileSync(path.join(root, "data/UserData/original.json"), '{"original":true}\n')
      for (const id of ids)
        fs.writeFileSync(path.join(root, "plugins", id, "index.js"), "unchanged-plugin")
      const entry = path.join(root, "probe.cjs")
      fs.writeFileSync(
        entry,
        `const fs=require('node:fs'),path=require('node:path'),net=require('node:net'),{DatabaseSync}=require('node:sqlite');
const id=process.env.FIXTURE_ID,socket=net.connect(process.env.YUNZAI_GUARD_PIPE);let pending='';
socket.on('connect',()=>socket.write(JSON.stringify({type:'preload-hello',pid:process.pid})+'\\n'));
socket.on('data',chunk=>{pending+=chunk;while(pending.includes('\\n')){const i=pending.indexOf('\\n'),message=JSON.parse(pending.slice(0,i));pending=pending.slice(i+1);if(message.type!=='probe')continue;const result={};
for(const [name,target] of Object.entries({own:'plugins/'+id+'/own.txt',user:'data/UserData/'+id+'.txt',player:'data/PlayerData/'+id+'.txt',db:'data/db/'+id+'.txt',core:'lib/core.txt',peer:'plugins/'+(id==='first'?'second':'first')+'/index.js',state:'data/yunzai-guard/outside.txt',outside:'data/outside.txt'})){try{fs.appendFileSync(target,id+'\\n');result[name]={allowed:true}}catch(error){result[name]={allowed:false,code:error.code}}}
try{fs.renameSync('data/UserData','data/UserData-renamed');result.renameShared={allowed:true}}catch(error){result.renameShared={allowed:false,code:error.code}}
let db;try{db=new DatabaseSync('data/db/shared.sqlite');db.exec('PRAGMA busy_timeout=3000;CREATE TABLE IF NOT EXISTS events(plugin TEXT)');db.prepare('INSERT INTO events(plugin) VALUES(?)').run(id);result.sqlite={allowed:true}}catch(error){result.sqlite={allowed:false,code:error.code,message:error.message}}finally{db?.close()}
socket.write(JSON.stringify({type:'probe-result',request:message.request,result})+'\\n');}});setInterval(()=>{},1000);`,
      )
      const helper = compileWindowsSandbox(),
        before = snapshot(helper, directories)
      const sessions = [],
        messages = [],
        errors = [],
        report = { root, shared, parallel, before, sessions: [], probes: [], errors }
      let requestId = 0
      const wait = async predicate => {
        const end = Date.now() + 20000
        while (!predicate()) {
          assert.deepEqual(errors, [])
          assert.ok(Date.now() < end, `Wait timed out: ${JSON.stringify(messages)}`)
          await delay(20)
        }
      }
      const probe = async session => {
        const request = ++requestId
        session.child.send({ type: "probe", request })
        await wait(() =>
          messages.some(row => row.id === session.id && row.frame.request === request),
        )
        const result = messages.find(row => row.id === session.id && row.frame.request === request)
          .frame.result
        for (const name of ["own", "user", "player", "db", "sqlite"])
          assert.equal(
            result[name].allowed,
            true,
            `${session.id}:${name}: ${JSON.stringify(result[name])}`,
          )
        for (const name of ["core", "peer", "state", "outside", "renameShared"])
          assert.equal(result[name].allowed, false, `${session.id}:${name}`)
        report.probes.push({ id: session.id, request, result })
      }
      try {
        for (const id of ids) {
          const child = spawnWindowsSandbox(
            root,
            { sandbox: { network: "none", writablePaths: [`plugins/${id}`, ...shared] } },
            {
              executable: process.execPath,
              args: [entry],
              env: { ...process.env, FIXTURE_ID: id },
              forwardOutput: false,
              sessionKey: id,
              sharedWritablePaths: shared,
            },
          )
          const session = { id, child }
          sessions.push(session)
          child.on("message", frame => messages.push({ id, frame }))
          child.on("error", error => errors.push({ id, error: error.message }))
          if (!parallel) {
            await wait(() =>
              messages.some(row => row.id === id && row.frame.type === "preload-hello"),
            )
            await probe(session)
          }
        }
        await Promise.all(
          sessions.map(session =>
            wait(() =>
              messages.some(row => row.id === session.id && row.frame.type === "preload-hello"),
            ),
          ),
        )
        for (const session of sessions)
          report.sessions.push(
            JSON.parse(
              fs.readFileSync(path.join(session.child.sandboxSession, "journal.json"), "utf8"),
            ),
          )
        if (parallel) await Promise.all(sessions.map(probe))
        const active = snapshot(helper, directories)
        report.active = active
        for (const item of Object.values(active)) assert.match(item.label, /;;;LW\)/)
        // 即使按非后进先出顺序关闭，只要仍有会话存活，就不能恢复共享 Medium 标签。
        if (parallel)
          await Promise.all([
            sessions[1].child.sandboxDispose(),
            sessions[0].child.sandboxDispose(),
          ])
        else await sessions[1].child.sandboxDispose()
        if (!parallel) await probe(sessions[0])
        await probe(sessions[2])
        const afterSecond = snapshot(helper, directories)
        report.afterSecond = afterSecond
        for (const item of Object.values(afterSecond)) {
          assert.match(item.label, /;;;LW\)/)
          assert.equal(item.dacl.includes(report.sessions[1].sid), false)
          assert.equal(item.dacl.includes(report.sessions[0].sid), !parallel)
          assert.equal(item.dacl.includes(report.sessions[2].sid), true)
        }
        await sessions[0].child.sandboxDispose()
        await probe(sessions[2])
        await sessions[2].child.sandboxDispose()
        const after = snapshot(helper, directories)
        report.after = after
        for (const name of Object.keys(before)) {
          assert.equal(after[name].dacl, before[name].dacl)
          assert.equal(after[name].label.includes(";;;LW)"), false)
        }
        // 移除 Guard 无需导出业务数据，文件及其原格式保持一致。
        assert.equal(
          fs.readFileSync(path.join(root, "data/UserData/original.json"), "utf8"),
          '{"original":true}\n',
        )
        assert.equal(fs.readFileSync(path.join(root, "lib/core.txt"), "utf8"), "unchanged-core")
        for (const id of ids)
          assert.equal(
            fs.readFileSync(path.join(root, "plugins", id, "index.js"), "utf8"),
            "unchanged-plugin",
          )
        const { DatabaseSync } = await import("node:sqlite")
        const database = new DatabaseSync(path.join(root, "data/db/shared.sqlite"))
        try {
          const rows = database.prepare("SELECT plugin FROM events").all()
          assert.equal(rows.length, report.probes.length)
          assert.deepEqual([...new Set(rows.map(row => row.plugin))].sort(), ids)
          report.originalSqliteDirectReadAfterStop = rows
        } finally {
          database.close()
        }
        report.status = "three-session-original-path-passed"
      } finally {
        for (const session of sessions) {
          try {
            await session.child.sandboxDispose()
          } catch (error) {
            report.cleanupError ??= []
            report.cleanupError.push(error.message)
          }
        }
        report.helperSourceSha256 = windowsSandboxBuildDigest(repository)
        fs.writeFileSync(path.join(root, "report.json"), JSON.stringify(report, null, 2) + "\n")
      }
    },
  )
