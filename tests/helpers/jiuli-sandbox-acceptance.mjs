import assert from "node:assert/strict"
import fs from "node:fs"
import path from "node:path"
import net from "node:net"
import { createHash, randomBytes } from "node:crypto"
import { spawn, execFileSync } from "node:child_process"
import { fileURLToPath, pathToFileURL } from "node:url"
import { until, snapshot, waitScopeGone } from "../environment-fixture.mjs"
import { readAuditRecords } from "../audit-reader.mjs"

export async function runJiuliSandboxAcceptance(options = {}) {
  const repository = fileURLToPath(new URL("../../", import.meta.url))
  const configuredSource = options.source ?? process.env.GUARD_JIULI_SOURCE
  assert.ok(
    configuredSource && path.isAbsolute(configuredSource),
    "Set GUARD_JIULI_SOURCE to an installed and compiled JiuLi directory",
  )
  const source = fs.realpathSync(configuredSource)
  assert.equal(JSON.parse(fs.readFileSync(path.join(source, "package.json"))).name, "jiuli")
  assert.ok(
    fs.existsSync(path.join(source, "lib/core/loader.js")),
    "Build JiuLi before running acceptance",
  )
  assert.ok(
    fs.existsSync(path.join(source, "node_modules")),
    "Install JiuLi dependencies before running acceptance",
  )
  const product = fs.realpathSync(options.product ?? process.env.GUARD_JIULI_PRODUCT ?? repository)
  const output = path.resolve(
    options.output ??
      process.env.GUARD_JIULI_OUTPUT ??
      path.join(repository, "tests/runs/jiuli-sandbox"),
  )
  const runRoot = path.join(
    output,
    `${process.platform}-sandbox-${Date.now()}-${randomBytes(3).toString("hex")}`,
  )
  const root = path.join(runRoot, "project")
  assert.ok(!fs.existsSync(root))
  fs.mkdirSync(root, { recursive: true })
  const omitted = new Set([".git", "logs", "data", "temp", "resources"])
  const links = []
  function copyProject(from, to) {
    const relative = path.relative(source, from)
    if (omitted.has(relative.split(path.sep)[0]) || relative.startsWith(`config${path.sep}config`))
      return
    const stat = fs.lstatSync(from)
    if (stat.isSymbolicLink()) {
      const resolved = fs.realpathSync.native(from)
      const tail = path.relative(source, resolved)
      assert.ok(
        tail !== ".." && !tail.startsWith(`..${path.sep}`) && !path.isAbsolute(tail),
        `External source link: ${relative}`,
      )
      links.push({
        from: to,
        to: path.join(root, tail),
        directory: fs.statSync(from).isDirectory(),
      })
    } else if (stat.isDirectory()) {
      fs.mkdirSync(to, { recursive: true })
      for (const name of fs.readdirSync(from))
        copyProject(path.join(from, name), path.join(to, name))
    } else if (stat.isFile()) fs.copyFileSync(from, to)
  }
  copyProject(source, root)
  for (const link of links) {
    fs.mkdirSync(path.dirname(link.from), { recursive: true })
    fs.symlinkSync(
      process.platform === "win32" ? link.to : path.relative(path.dirname(link.from), link.to),
      link.from,
      link.directory ? (process.platform === "win32" ? "junction" : "dir") : "file",
    )
  }
  const pluginDir = path.join(root, "plugins/yunzai-guard")
  fs.mkdirSync(pluginDir)
  for (const name of ["dist", "native"])
    fs.cpSync(path.join(product, name), path.join(pluginDir, name), { recursive: true })
  for (const name of ["index.js", "package.json"])
    fs.copyFileSync(path.join(product, name), path.join(pluginDir, name))
  let privateRuntimeDir
  if (process.platform === "win32") {
    const relative = ".cache/private-node/v24.22.1-appcontainer-canonical-v2-final-win-x64/runtime"
    const runtime =
      options.privateRuntime ??
      process.env.GUARD_JIULI_PRIVATE_NODE ??
      path.join(repository, relative)
    const target = path.join(pluginDir, relative)
    privateRuntimeDir = target
    fs.mkdirSync(target, { recursive: true })
    for (const name of ["node.exe", "build-manifest.json", "os-verification.json"])
      fs.copyFileSync(path.join(runtime, name), path.join(target, name))
  }
  const stateDir = path.join(root, "data/yunzai-guard")
  fs.mkdirSync(stateDir, { recursive: true })
  const hash = file => createHash("sha256").update(fs.readFileSync(file)).digest("hex")
  const coreFiles = {}
  for (const area of ["app.js", "package.json", "src", "lib", "config/default_config"]) {
    const walk = relative => {
      const file = path.join(root, relative),
        info = fs.lstatSync(file)
      if (info.isDirectory())
        for (const name of fs.readdirSync(file)) walk(path.join(relative, name))
      else if (info.isFile()) coreFiles[relative] = hash(file)
    }
    walk(area)
  }
  const ids = ["jiuli-sandbox-alpha", "jiuli-sandbox-beta"]
  const ruleId = "jiuli-sandbox-rule"
  const sandboxIds = [...ids, ruleId]
  const report = {
    status: "running",
    core: "JiuLi",
    coreVersion: JSON.parse(fs.readFileSync(path.join(root, "package.json"))).version,
    platform: process.platform,
    node: process.version,
    runRoot,
    checks: [],
    generations: [],
    realAccountLogin: false,
    scope:
      "Generated unchanged legacy/class/DSL plugins through actual JiuLi; assertions apply after cold handoff",
    realRedis: true,
  }
  report.guardVersion = JSON.parse(fs.readFileSync(path.join(product, "package.json"))).version
  const productFiles = {}
  for (const area of ["dist", "native", "index.js", "package.json"]) {
    const walk = relative => {
      const file = path.join(product, relative)
      const info = fs.lstatSync(file)
      assert.equal(info.isSymbolicLink(), false, `Linked acceptance input: ${relative}`)
      if (info.isDirectory())
        for (const name of fs.readdirSync(file)) walk(path.join(relative, name))
      else if (info.isFile() && !/\.(?:map|d\.ts|d\.cts)$/.test(relative))
        productFiles[relative.split(path.sep).join("/")] = hash(file)
    }
    walk(area)
  }
  report.guardInputFiles = productFiles
  report.guardInputSha256 = createHash("sha256")
    .update(JSON.stringify(Object.fromEntries(Object.entries(productFiles).sort())))
    .digest("hex")
  if (fs.existsSync(path.join(product, "release.json"))) {
    const manifest = JSON.parse(fs.readFileSync(path.join(product, "release.json"), "utf8"))
    report.guardCommit = manifest.commit
    for (const [file, expected] of Object.entries(manifest.files)) {
      assert.equal(hash(path.join(product, file)), expected, `Release input changed: ${file}`)
      if (
        file.startsWith("dist/") ||
        file.startsWith("native/") ||
        ["index.js", "package.json"].includes(file)
      )
        assert.equal(hash(path.join(pluginDir, file)), expected, `Copied release changed: ${file}`)
    }
    report.releaseFilesVerified = Object.keys(manifest.files).length
  }
  if (privateRuntimeDir)
    report.privateRuntime = {
      selection: "explicit canonical v2 final candidate; YUNZAI_GUARD_PRIVATE_NODE=1",
      sha256: hash(path.join(privateRuntimeDir, "node.exe")),
      buildManifestSha256: hash(path.join(privateRuntimeDir, "build-manifest.json")),
      osVerificationSha256: hash(path.join(privateRuntimeDir, "os-verification.json")),
    }
  const receipt = path.join(runRoot, "receipt.json")
  const save = () => fs.writeFileSync(receipt, JSON.stringify(report, null, 2) + "\n")
  const checkpoint = (name, details = {}) => {
    report.checks.push({ name, ...details })
    save()
    console.log(name)
  }
  const read = file => {
    try {
      return JSON.parse(fs.readFileSync(file, "utf8"))
    } catch (error) {
      if (error.code === "ENOENT" || error instanceof SyntaxError) return
      throw error
    }
  }
  const lines = file => {
    try {
      return fs.readFileSync(file, "utf8").split("\n").filter(Boolean).map(JSON.parse)
    } catch (error) {
      if (error.code === "ENOENT") return []
      throw error
    }
  }
  async function freePort() {
    const server = net.createServer()
    await new Promise((r, j) => {
      server.once("error", j)
      server.listen(0, "127.0.0.1", r)
    })
    const port = server.address().port
    await new Promise(r => server.close(r))
    return port
  }
  async function control(command) {
    const { token, port } = read(path.join(stateDir, "control.json")) || {}
    if (!token) return undefined
    return new Promise((resolve, reject) => {
      const socket = net.connect(port, "127.0.0.1")
      let data = ""
      socket.setTimeout(5000, () => socket.destroy(new Error("control timeout")))
      socket.once("error", reject)
      socket.once("connect", () => socket.write(JSON.stringify({ token, command }) + "\n"))
      socket.on("data", chunk => {
        data += chunk
        if (data.includes("\n")) {
          socket.end()
          try {
            resolve(JSON.parse(data.split("\n")[0]))
          } catch (error) {
            reject(error)
          }
        }
      })
    })
  }
  const observed = new Map()
  const capture = pid => {
    const rows = snapshot(pid)
    for (const row of rows) observed.set(`${row.pid}:${row.start}`, row)
    return rows
  }
  async function online(generation) {
    return until(
      async () => {
        let status
        try {
          status = await control("status")
        } catch (error) {
          if (["ENOENT", "ECONNREFUSED", "ECONNRESET"].includes(error.code)) return false
          throw error
        }
        if (status?.phase === "tripped") {
          capture(status.hostPid)
          throw new Error(`Guard tripped: ${status.trippedReason}`)
        }
        if (status?.phase !== "online" || status.generation < generation) return false
        capture(status.hostPid)
        return status
      },
      `JiuLi sandbox generation ${generation} did not become online`,
      120000,
    )
  }

  const parentNamespace = process.platform === "linux" ? fs.readlinkSync("/proc/self/ns/pid") : null
  function businessSource(id, other, modern) {
    return `import fs from "node:fs"
import path from "node:path"
import {fileURLToPath} from "node:url"
import {randomUUID} from "node:crypto"
${modern ? 'import {JiuLiPlugin,getBot,definePlugin,command} from "jiuli"\nimport {PluginsLoader} from "jiuli/core"' : ""}
import staticValue from "./static.mjs"
const dynamicValue=(await import("./dynamic.mjs?acceptance=1")).default
await Promise.resolve()
const own=path.dirname(fileURLToPath(import.meta.url))
const confined=process.platform==="linux"?fs.readlinkSync("/proc/self/ns/pid")!==${JSON.stringify(parentNamespace)}:process.env.YUNZAI_GUARD_SANDBOX==="appcontainer"
const instance=randomUUID()
const identity=()=>({instance,pid:process.pid,namespace:process.platform==="linux"?fs.readlinkSync("/proc/self/ns/pid"):null})
const put=(file,value)=>fs.appendFileSync(path.join(own,file),JSON.stringify({...identity(),...value})+"\\n")
const inherited=globalThis.__jiuliSandboxMarker??null
globalThis.__jiuliSandboxMarker=${JSON.stringify(id)}
put("imports.jsonl",{confined,inherited})
const attempt=callback=>{try{callback();return {blocked:false}}catch(error){return {blocked:true,code:error.code,message:error.message}}}
const pattern=new RegExp(${JSON.stringify(`^#${id}:([a-z]+)$`)})
pattern.test=function(text){put("regex.jsonl",{text});return RegExp.prototype.test.call(this,text)}
export class Business extends ${modern ? "JiuLiPlugin" : "plugin"}{
  constructor(e){super({name:${JSON.stringify(id)},event:"message",priority:-20000,rule:[{reg:pattern,fnc:"check"},{reg:${JSON.stringify(`^#${id}-wait-private$`)},fnc:"waitPrivate"},{reg:${JSON.stringify(`^#${id}-wait-group$`)},fnc:"waitGroup"},{reg:${JSON.stringify(`^#${id}-attack$`)},fnc:"attack"}${modern ? ',{reg:/^#jiuli-init:([a-z]+)$/,fnc:function(){throw new Error("Unexpected constructor callback")}}' : ""}],task:{name:${JSON.stringify(id + "-timer")},cron:"* * * * * *",log:false,fnc:()=>put("tasks.jsonl",{task:true})}});${modern ? "this.constructedEvent=e;this.constructedReply=e?.reply" : ""}}
  ${modern ? "onLoad" : "init"}(){
    ${modern ? 'this.rule.at(-1).fnc=function(e,match){this.replaced=match?.[1];return false};this.rule.push({reg:/^#jiuli-init:([a-z]+)$/,fnc:async function(e,match){await this.reply(JSON.stringify({kind:"init-rule",capture:match?.[1],replaced:this.replaced,current:this.e.msg,accepted:this.accepted,...identity()}));return true}})' : ""}
    const result={confined,inherited,staticValue,dynamicValue,marker:globalThis.__jiuliSandboxMarker}
    if(confined){
      result.core=attempt(()=>fs.appendFileSync(path.resolve("app.js"),"tamper"))
      result.peer=attempt(()=>fs.writeFileSync(path.resolve(${JSON.stringify("plugins/" + other + "/escape.txt")}),"tamper"))
      ${modern ? 'result.getBot=getBot()===Bot;result.backlinkCore=attempt(()=>fs.appendFileSync(path.join(own,"node_modules/jiuli/app.js"),"tamper"))' : ""}
      Bot.once("guard.jiuli.sandbox.once",()=>put("once.jsonl",{once:true}))
    }
    put("init.jsonl",result)
  }
  async accept(e){this.accepted=e.msg;await new Promise(resolve=>setTimeout(resolve,e.msg.endsWith("slow")?45:5));return false}
  async check(e,match){await new Promise(resolve=>setTimeout(resolve,e.msg.endsWith("slow")?45:5));put("messages.jsonl",{msg:e.msg,accepted:this.accepted,current:this.e.msg,capture:match?.[1]});await ${modern ? "this.constructedReply" : "this.reply"}(JSON.stringify({kind:"check",id:${JSON.stringify(id)},msg:e.msg,current:this.e.msg,accepted:this.accepted,capture:match?.[1],marker:globalThis.__jiuliSandboxMarker,${modern ? "constructorEvent:this.constructedEvent?.msg," : ""}...identity()}));return true}
  async waitPrivate(e){return this.waitInput(e,false)}
  async waitGroup(e){return this.waitInput(e,true)}
  async waitInput(e,isGroup){const waiting=this.awaitContext(isGroup,0);put("context-ready.jsonl",{msg:e.msg,isGroup,user:e.user_id,group:e.group_id});const next=await waiting;put("contexts.jsonl",{initial:e.msg,current:next.msg,isGroup});await this.reply(JSON.stringify({kind:"context",id:${JSON.stringify(id)},initial:e.msg,current:next.msg,isGroup,...identity()}));return true}
  attack(){const result={kind:${JSON.stringify(modern ? "hook" : "guard")}};${modern ? 'result.hook=attempt(()=>{Bot.sendGroupMsg=()=>"tamper"});result.facadeHook=attempt(()=>{PluginsLoader.priority=[]})' : 'result.guard=attempt(()=>fs.appendFileSync(path.join(own,"node_modules/jiuli/plugins/yunzai-guard/index.js"),"tamper"))'};put("attacks.jsonl",result);return true}
  onUnload(){if(confined)put("disposed.jsonl",{disposed:true})}
}
${modern ? `export default definePlugin({name:"jiuli-dsl-sample",priority:-19000,apps:[command(/^#jiuli-dsl:([a-z]+)$/,async function(e,match){await this.reply(JSON.stringify({kind:"dsl",capture:match?.[1],same:getBot()===Bot,...identity()}));return true})]})` : ""}
`
  }

  const driverSource = `import fs from "node:fs"
import path from "node:path"
import {PluginsLoader as loader} from "jiuli/core"
const ids=${JSON.stringify(ids)}
const sandboxIds=${JSON.stringify(sandboxIds)}
const ruleId=${JSON.stringify(ruleId)}
const delay=ms=>new Promise(resolve=>setTimeout(resolve,ms))
const lines=file=>{try{return fs.readFileSync(file,"utf8").split("\\n").filter(Boolean).map(JSON.parse)}catch{return[]}}
const wait=async(test,label)=>{const deadline=Date.now()+12000;while(Date.now()<deadline){const result=test();if(result)return result;await delay(20)}throw new Error(label)}
export class Driver extends plugin{
 constructor(){super({name:"Trusted JiuLi sandbox acceptance driver",event:"message",priority:90000,rule:[{reg:"^#jiuli-peer$",fnc:"peer"}]})}
 async peer(){return this.reply(JSON.stringify({kind:"peer",pid:process.pid,marker:globalThis.__jiuliSandboxMarker??null}))}
 init(){
  if(!globalThis[Symbol.for("yunzai.guard.context.v1")])return
  Bot.express.get("/guard-sandbox/status",(req,res)=>res.json({corePid:process.pid,marker:globalThis.__jiuliSandboxMarker??null,loaded:loader.priority.filter(row=>sandboxIds.includes(row.key)).map(row=>row.key)}))
  Bot.express.get("/guard-sandbox/run",async(req,res)=>{
   const replies=[],requests=[]
   let serial=0
   const send=async(text,user="sandbox-user",group)=>{const request=++serial;const trace={request,text,user,group,stage:"started"};requests.push(trace);const e={self_id:"mock",user_id:user,post_type:"message",message_type:group?"group":"private",sub_type:group?"normal":"friend",isPrivate:!group,isGroup:!!group,group_id:group,message_id:"guard-test-"+request,message:[{type:"text",text}],raw_message:text,sender:{user_id:user,nickname:"Guard fixture",role:"member"},reply:async value=>{replies.push({request,origin:text,value:JSON.parse(String(value))});return {message_id:"fixture"}}};try{await loader.deal(e);return request}finally{trace.stage="settled"}}
   try{
    if(req.query.phase==="attack"){
      for(const id of [...ids,ruleId]){try{await send("#"+id+"-attack")}catch(error){requests.push({stage:"attack-error",id,error:String(error.message)})}}
      await send("#jiuli-peer")
      res.json({corePid:process.pid,replies,requests});return
    }
    for(const id of ids)await send("#"+id+":first")
    const unmatchedBefore=replies.length
    await send("#unmatched-guard-sandbox")
    const unmatchedAfter=replies.length
    for(const id of ids)await Promise.all([send("#"+id+":slow",id+"-slow"),send("#"+id+":fast",id+"-fast")])
    for(const id of ids)for(const isGroup of [false,true]){
      const group=isGroup?"sandbox-group-"+id:undefined,user="context-user-"+id
      const command="#"+id+"-wait-"+(isGroup?"group":"private")
      const count=lines("plugins/"+id+"/context-ready.jsonl").length
      const pending=send(command,user,group)
      await wait(()=>lines("plugins/"+id+"/context-ready.jsonl").length>count,"context not registered")
      await send("answer-"+(isGroup?"group":"private"),isGroup?"second-user-"+id:user,group)
      await pending
      const before=replies.length
      await send("duplicate-context-answer",isGroup?"second-user-"+id:user,group)
      if(replies.length!==before)throw new Error("one-shot context reused")
    }
    await send("#jiuli-dsl:example")
    await send("#jiuli-init:example")
    await send("#jiuli-peer")
    Bot.emit("guard.jiuli.sandbox.once");Bot.emit("guard.jiuli.sandbox.once")
    await wait(()=>ids.every(id=>{const instance=lines("plugins/"+id+"/init.jsonl").at(-1)?.instance;return lines("plugins/"+id+"/once.jsonl").some(row=>row.instance===instance)}),"once bridge did not complete")
    await delay(100)
    res.json({corePid:process.pid,marker:globalThis.__jiuliSandboxMarker??null,unmatchedBefore,unmatchedAfter,replies,requests,loaded:loader.priority.filter(row=>ids.includes(row.key)).map(row=>({key:row.key,name:row.name}))})
   }catch(error){res.status(500).json({error:error.stack,replies,requests})}
  })
 }
}
`

  let redisServer,
    redisContainer,
    child,
    stopped = false,
    coreBase,
    heldPrivateRuntime
  try {
    const redisPort = await freePort(),
      corePort = await freePort(),
      panelPort = await freePort()
    coreBase = `http://127.0.0.1:${corePort}`
    if (process.platform === "win32") {
      redisContainer = `guard-jiuli-sandbox-${randomBytes(5).toString("hex")}`
      execFileSync(
        "docker",
        [
          "run",
          "--rm",
          "-d",
          "--name",
          redisContainer,
          "--label",
          `codex.guard.jiuli.sandbox=${path.basename(runRoot)}`,
          "-p",
          `127.0.0.1:${redisPort}:6379`,
          "redis:7.2-alpine",
        ],
        { stdio: "pipe", windowsHide: true, timeout: 30000 },
      )
    } else {
      redisServer = spawn(
        "redis-server",
        [
          "--bind",
          "127.0.0.1",
          "--port",
          String(redisPort),
          "--save",
          "",
          "--appendonly",
          "no",
          "--dir",
          runRoot,
        ],
        { stdio: ["ignore", "pipe", "pipe"] },
      )
      for (const stream of [redisServer.stdout, redisServer.stderr])
        stream.pipe(fs.createWriteStream(path.join(runRoot, "redis.log"), { flags: "a" }))
    }
    await until(
      () =>
        new Promise(resolve => {
          const socket = net.connect(redisPort, "127.0.0.1")
          socket.once("connect", () => {
            socket.destroy()
            resolve(true)
          })
          socket.once("error", () => resolve(false))
        }),
      "Redis not ready",
      10000,
    )
    fs.mkdirSync(path.join(root, "config/config"), { recursive: true })
    fs.writeFileSync(
      path.join(root, "config/config/server.yaml"),
      `port: ${corePort}\nurl: ${coreBase}\nauth: {}\n`,
    )
    fs.writeFileSync(
      path.join(root, "config/config/redis.yaml"),
      `host: 127.0.0.1\nport: ${redisPort}\ndb: 0\n`,
    )
    fs.writeFileSync(
      path.join(root, "config/config/bot.yaml"),
      "file_watch: true\nlog_level: debug\nplugin_load_timeout: 90\n",
    )
    fs.writeFileSync(
      path.join(root, "config/config/group.yaml"),
      "default:\n  groupCD: 0\n  singleCD: 0\n  onlyReplyAt: 0\n",
    )
    fs.writeFileSync(path.join(root, "config/config/other.yaml"), "master: []\n")
    fs.writeFileSync(
      path.join(stateDir, "settings.json"),
      JSON.stringify({
        startupTimeout: 150000,
        handshakeTimeout: 15000,
        shutdownTimeout: 15000,
        recovery: { maxRestarts: 0, windowMs: 60000, baseDelayMs: 50, maxDelayMs: 100 },
        audit: { maxEventsPerSecond: 3000 },
        pluginSandbox: {
          native: {
            plugins: sandboxIds.map(id => ({
              id,
              timeoutMs: 20000,
              hookAction: "deny",
              network: "none",
            })),
          },
        },
        rules: [ruleId].map(id => ({
          id: `${id}-deny-fetch`,
          plugin: id,
          kind: "network",
          operation: "fetch",
          action: "deny",
        })),
      }),
    )
    const { savePanelSettings } = await import(
      pathToFileURL(path.join(pluginDir, "dist/web/panel-settings.js"))
    )
    savePanelSettings(stateDir, { host: "127.0.0.1", port: panelPort })
    const businessHashes = {}
    for (const [index, id] of ids.entries()) {
      const own = path.join(root, "plugins", id)
      fs.mkdirSync(own)
      fs.mkdirSync(path.join(own, "node_modules"))
      fs.symlinkSync(
        process.platform === "win32" ? root : "../../..",
        path.join(own, "node_modules/jiuli"),
        process.platform === "win32" ? "junction" : "dir",
      )
      for (const [name, value] of Object.entries({
        "index.js": businessSource(id, ids[1 - index], index === 1),
        "static.mjs": 'export default "static-ok"\n',
        "dynamic.mjs": 'export default "dynamic-ok"\n',
      })) {
        fs.writeFileSync(path.join(own, name), value)
        businessHashes[path.join("plugins", id, name)] = hash(path.join(own, name))
      }
    }
    const ruleDirectory = path.join(root, "plugins", ruleId)
    fs.mkdirSync(ruleDirectory)
    fs.writeFileSync(
      path.join(ruleDirectory, "index.js"),
      `import fs from "node:fs";import path from "node:path";import {fileURLToPath} from "node:url";const own=path.dirname(fileURLToPath(import.meta.url));export class RuleProbe extends plugin{constructor(){super({name:${JSON.stringify(ruleId)},event:"message",priority:-18000,rule:[{reg:${JSON.stringify(`^#${ruleId}-attack$`)},fnc:"attack"}]})}async attack(){await fetch("data:text/plain,blocked");fs.writeFileSync(path.join(own,"network-escaped.txt"),"unexpected")}}`,
    )
    businessHashes[path.join("plugins", ruleId, "index.js")] = hash(
      path.join(ruleDirectory, "index.js"),
    )
    const driver = path.join(root, "plugins/jiuli-sandbox-driver")
    fs.mkdirSync(driver)
    fs.writeFileSync(path.join(driver, "index.js"), driverSource)
    const env = { ...process.env, JIULI_NO_AUTO_INSTALL: "1", NODE_OPTIONS: "" }
    for (const key of Object.keys(env))
      if (
        key.startsWith("YUNZAI_GUARD_") ||
        [
          "PM2_HOME",
          "PM_ID",
          "NODE_APP_INSTANCE",
          "APP_TYPE",
          "JIULI_CHILD",
          "JIULI_REDIS",
        ].includes(key.toUpperCase())
      )
        delete env[key]
    if (process.platform === "win32") env.YUNZAI_GUARD_PRIVATE_NODE = "1"
    child = spawn(process.execPath, ["app.js"], {
      cwd: root,
      env,
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    })
    for (const [name, stream] of [
      ["stdout", child.stdout],
      ["stderr", child.stderr],
    ])
      stream.pipe(fs.createWriteStream(path.join(runRoot, `${name}.log`)))
    capture(child.pid)
    async function inspect(status) {
      const response = await fetch(coreBase + "/guard-sandbox/run", {
        signal: AbortSignal.timeout(90000),
      })
      const result = await response.json()
      assert.equal(response.status, 200, JSON.stringify(result))
      assert.equal(result.marker, null, "Native source leaked into business core")
      assert.equal(result.corePid, status.workerPid)
      assert.equal(result.unmatchedAfter, result.unmatchedBefore)
      const native = []
      for (const [index, id] of ids.entries()) {
        const directory = path.join(root, "plugins", id)
        const init = lines(path.join(directory, "init.jsonl")).findLast(row => row.confined)
        assert.ok(init, `${id} did not initialize in OS sandbox`)
        assert.equal(init.inherited, null)
        assert.equal(init.staticValue, "static-ok")
        assert.equal(init.dynamicValue, "dynamic-ok")
        for (const name of ["core", "peer", ...(index ? ["backlinkCore"] : [])])
          assert.equal(init[name].blocked, true, `${id}: ${name} escaped`)
        if (index) assert.equal(init.getBot, true)
        const replies = result.replies.map(row => row.value).filter(row => row.id === id)
        const commands = replies.filter(row => row.kind === "check")
        assert.equal(commands.length, 3)
        for (const command of commands) {
          assert.equal(command.msg, command.current)
          assert.equal(command.accepted, command.msg)
          assert.equal(command.capture, command.msg.split(":")[1])
          assert.equal(command.marker, id)
          if (index) assert.equal(command.constructorEvent, command.msg)
        }
        const contexts = replies.filter(row => row.kind === "context")
        assert.deepEqual(
          contexts.map(row => [row.current, row.isGroup]),
          [
            ["answer-private", false],
            ["answer-group", true],
          ],
        )
        const once = lines(path.join(directory, "once.jsonl")).filter(
          row => row.instance === init.instance,
        )
        assert.equal(once.length, 1)
        assert.equal(
          lines(path.join(directory, "imports.jsonl")).some(row => row.pid === status.workerPid),
          false,
        )
        await until(
          () =>
            lines(path.join(directory, "tasks.jsonl")).some(row => row.instance === init.instance),
          "Task callback missing",
          5000,
        )
        native.push({ id, init })
      }
      assert.notEqual(
        `${native[0].init.pid}:${native[0].init.namespace}`,
        `${native[1].init.pid}:${native[1].init.namespace}`,
      )
      assert.equal(result.replies.find(row => row.value.kind === "dsl")?.value.capture, "example")
      assert.equal(result.replies.find(row => row.value.kind === "dsl")?.value.same, true)
      assert.equal(
        result.replies.find(row => row.value.kind === "peer")?.value.pid,
        status.workerPid,
      )
      const dynamicRules = result.replies.filter(row => row.value.kind === "init-rule")
      assert.equal(dynamicRules.length, 1)
      assert.equal(dynamicRules[0].value.capture, "example")
      assert.equal(dynamicRules[0].value.replaced, "example")
      assert.equal(dynamicRules[0].value.current, "#jiuli-init:example")
      assert.equal(dynamicRules[0].value.accepted, "#jiuli-init:example")
      const records = readAuditRecords(stateDir)
      const starts = records.filter(
        row =>
          row.generation === status.generation && row.event?.operation === "native.process-started",
      )
      assert.equal(starts.length, sandboxIds.length)
      for (const item of starts)
        assert.equal(
          item.event.target,
          process.platform === "win32" ? "appcontainer" : "bubblewrap",
        )
      capture(status.hostPid)
      report.generations.push({
        generation: status.generation,
        hostPid: status.hostPid,
        corePid: status.workerPid,
        native,
        result,
        starts,
      })
      save()
      return native
    }
    const first = await online(1)
    await until(() => child.exitCode !== null, "Original JiuLi supervisor did not exit", 15000)
    assert.equal(child.exitCode, 0)
    const firstNative = await inspect(first)
    checkpoint(
      "plain node app.js cold handoff creates independent functional and policy plugin OS sandboxes",
    )
    checkpoint(
      "ESM/TLA, legacy/class/DSL, regex captures, accept state and concurrent requests work",
    )
    checkpoint(
      "private/group contexts and once callbacks retain one-shot ownership; normal plugin unaffected",
    )
    checkpoint(
      "own-directory writes work; direct and workspace-backlink core writes and peer writes are denied",
    )
    const old = capture(first.workerPid)
    await control("restart")
    const second = await online(2)
    assert.equal(second.hostPid, first.hostPid)
    await waitScopeGone(old, { timeout: 30000 })
    await inspect(second)
    for (const { id, init } of firstNative)
      assert.equal(
        lines(path.join(root, "plugins", id, "disposed.jsonl")).filter(
          row => row.instance === init.instance,
        ).length,
        1,
        `${id}: cleanup did not run exactly once`,
      )
    checkpoint("controlled restart closes old plugin scopes and rebuilds one controlled core")
    const attackScope = report.generations
      .at(-1)
      .starts.flatMap(row => snapshot(row.event.runtime.pid))
    for (const row of attackScope) observed.set(`${row.pid}:${row.start}`, row)
    const attackResponse = await fetch(coreBase + "/guard-sandbox/run?phase=attack", {
      signal: AbortSignal.timeout(90000),
    })
    const attack = await attackResponse.json()
    assert.equal(attackResponse.status, 200, JSON.stringify(attack))
    assert.equal(attack.corePid, second.workerPid)
    assert.ok(
      attack.replies.some(row => row.value.kind === "peer" && row.value.pid === second.workerPid),
    )
    await until(
      () => {
        const events = readAuditRecords(stateDir)
        return (
          events.some(
            row =>
              row.generation === second.generation &&
              row.event?.plugin === ids[0] &&
              row.event.kind === "self-protection" &&
              row.event.action === "deny",
          ) &&
          events.some(
            row =>
              row.generation === second.generation &&
              row.event?.plugin === ids[1] &&
              row.event.operation === "native.hook" &&
              row.event.action === "deny",
          ) &&
          events.some(
            row =>
              row.generation === second.generation &&
              row.event?.plugin === ruleId &&
              row.event.operation === "fetch" &&
              row.event.action === "deny",
          )
        )
      },
      "Sandbox attack denials were not audited",
      15000,
    )
    await waitScopeGone(attackScope, { timeout: 30000 })
    const afterAttack = await control("status")
    assert.equal(afterAttack.phase, "online")
    assert.equal(afterAttack.hostPid, second.hostPid)
    assert.equal(afterAttack.workerPid, second.workerPid)
    assert.equal(fs.existsSync(path.join(ruleDirectory, "network-escaped.txt")), false)
    report.attack = attack
    checkpoint(
      "Guard write, core Hook and custom network rule attacks are denied and retire only the attacking plugins",
    )
    capture(second.hostPid)
    await control("stop")
    await waitScopeGone([...observed.values()], { timeout: 30000 })
    stopped = true
    if (privateRuntimeDir) {
      const held = path.join(runRoot, "held-private-runtime")
      assert.equal(fs.realpathSync.native(privateRuntimeDir), path.resolve(privateRuntimeDir))
      const relative = path.relative(root, privateRuntimeDir)
      assert.ok(
        relative &&
          relative !== ".." &&
          !relative.startsWith(`..${path.sep}`) &&
          !path.isAbsolute(relative),
      )
      assert.equal(path.dirname(held), fs.realpathSync.native(runRoot))
      const importsBefore = ids.map(
        id => lines(path.join(root, "plugins", id, "imports.jsonl")).length,
      )
      fs.renameSync(privateRuntimeDir, held)
      heldPrivateRuntime = { from: held, to: privateRuntimeDir }
      const log = fs.openSync(path.join(runRoot, "missing-runtime.log"), "a")
      stopped = false
      child = spawn(process.execPath, [path.join(pluginDir, "dist/launcher.js")], {
        cwd: root,
        env,
        windowsHide: true,
        stdio: ["ignore", log, log],
      })
      fs.closeSync(log)
      capture(child.pid)
      const refused = await online(1)
      const response = await fetch(coreBase + "/guard-sandbox/status", {
        signal: AbortSignal.timeout(10000),
      })
      assert.equal(response.status, 200)
      const state = await response.json()
      assert.equal(state.corePid, refused.workerPid)
      assert.equal(state.marker, null)
      assert.deepEqual(state.loaded, [])
      assert.deepEqual(
        ids.map(id => lines(path.join(root, "plugins", id, "imports.jsonl")).length),
        importsBefore,
      )
      capture(refused.hostPid)
      await control("stop")
      await waitScopeGone([...observed.values()], { timeout: 30000 })
      stopped = true
      fs.renameSync(heldPrivateRuntime.from, heldPrivateRuntime.to)
      heldPrivateRuntime = undefined
      checkpoint(
        "missing explicitly selected Windows runtime refuses sandbox plugins without a core fallback",
      )
    }
    for (const [file, expected] of Object.entries({ ...coreFiles, ...businessHashes }))
      assert.equal(hash(path.join(root, file)), expected, `Source changed: ${file}`)
    assert.ok(readAuditRecords(stateDir).some(row => row.type === "host-process-exit"))
    checkpoint(
      "shutdown recycles all owned processes, persists SQLite history and leaves core/plugin source unchanged",
      { coreFiles: Object.keys(coreFiles).length },
    )
    report.status = "passed"
  } catch (error) {
    report.status = "failed"
    report.error = error.stack || String(error)
    try {
      report.failureStatus = await control("status")
    } catch (failure) {
      report.failureStatusError = failure.message
    }
    report.failureLogs = {}
    for (const [label, file] of Object.entries({
      stdout: path.join(runRoot, "stdout.log"),
      stderr: path.join(runRoot, "stderr.log"),
      host: path.join(stateDir, "host.log"),
    })) {
      try {
        report.failureLogs[label] = fs.readFileSync(file, "utf8").slice(-16000)
      } catch {}
    }
    try {
      report.failureAudit = readAuditRecords(stateDir).slice(-25)
    } catch {}
    report.failureGuests = Object.fromEntries(
      ids.map(id => [
        id,
        Object.fromEntries(
          ["imports", "init", "messages", "context-ready", "contexts", "once", "disposed"].map(
            name => [name, lines(path.join(root, "plugins", id, `${name}.jsonl`)).slice(-12)],
          ),
        ),
      ]),
    )
  } finally {
    if (!stopped) {
      try {
        if (read(path.join(stateDir, "control.json"))) {
          const status = await control("status")
          if (status?.hostPid) capture(status.hostPid)
          await control("stop")
        }
        await waitScopeGone([...observed.values()], { timeout: 30000 })
        stopped = true
      } catch (error) {
        report.cleanupError = error.stack
      }
    }
    if (child && child.exitCode === null) child.kill("SIGTERM")
    if (heldPrivateRuntime) {
      try {
        fs.renameSync(heldPrivateRuntime.from, heldPrivateRuntime.to)
      } catch (error) {
        report.runtimeRestoreError = error.message
      }
    }
    if (redisContainer) {
      try {
        const labels = JSON.parse(
          execFileSync(
            "docker",
            ["inspect", redisContainer, "--format", "{{json .Config.Labels}}"],
            { encoding: "utf8", windowsHide: true },
          ),
        )
        assert.equal(labels["codex.guard.jiuli.sandbox"], path.basename(runRoot))
        execFileSync("docker", ["stop", "-t", "3", redisContainer], {
          stdio: "pipe",
          windowsHide: true,
          timeout: 15000,
        })
      } catch (error) {
        report.redisCleanupError = error.message
      }
    }
    if (redisServer && redisServer.exitCode === null) {
      const exited = new Promise(resolve => redisServer.once("exit", resolve))
      redisServer.kill("SIGTERM")
      await exited
    }
    report.observedScopes = [...observed.values()]
    report.cleanupConfirmed =
      stopped && !report.cleanupError && !report.redisCleanupError && !report.runtimeRestoreError
    save()
  }
  return { ...report, receipt }
}
