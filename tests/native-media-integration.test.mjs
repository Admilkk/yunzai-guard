import assert from "node:assert/strict"
import fs from "node:fs"
import path from "node:path"
import { createHash } from "node:crypto"
import { spawn, spawnSync } from "node:child_process"
import { performance } from "node:perf_hooks"
import test from "node:test"
import { createEnvironmentFixture } from "./environment-fixture.mjs"

const enabled =
  process.env.GUARD_TEST_NATIVE_MEDIA === "1" && ["win32", "linux"].includes(process.platform)
const pause = ms => new Promise(resolve => setTimeout(resolve, ms))
const pngBase64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a3ioAAAAASUVORK5CYII="
const png = Buffer.from(pngBase64, "base64")
const sha = value => createHash("sha256").update(value).digest("hex")
const readJson = file => {
  if (!fs.existsSync(file)) return undefined
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"))
  } catch (error) {
    if (error instanceof SyntaxError) return undefined
    throw error
  }
}
async function waitFor(predicate, description, timeout = 90000) {
  const deadline = performance.now() + timeout
  while (performance.now() < deadline) {
    const result = await predicate()
    if (result) return result
    await pause(40)
  }
  throw new Error(description)
}

const businessSource = `import fs from "node:fs"
import path from "node:path"
import {fileURLToPath,pathToFileURL} from "node:url"
const own=path.dirname(fileURLToPath(import.meta.url))
const bytes=Buffer.from(${JSON.stringify(pngBase64)},"base64")
const identity=()=>({pid:process.pid,pidNamespace:process.platform==="linux"?fs.readlinkSync("/proc/self/ns/pid"):null})
const record=(file,value)=>fs.writeFileSync(path.join(own,file),JSON.stringify({...identity(),...value}))
export class MediaBusiness extends plugin {
  constructor(){super({name:"Native media business",event:"message",priority:100,rule:[{reg:"^#native-media-(buffer|file|invalid|url)$",fnc:"sendImage"}]})}
  init(){
    fs.writeFileSync(path.join(own,"private-image.png"),bytes)
    record("initialized.json",{initialized:true})
    this.addCleanup(()=>record("disposed.json",{disposed:true}))
  }
  async sendImage(e){
    const kind=e.msg.slice("#native-media-".length)
    const source=kind==="buffer"?bytes:kind==="file"?path.join(own,"private-image.png"):kind==="url"?"http://198.51.100.1:8080/guest-only.png":pathToFileURL(path.join(own,"missing-image.png")).href
    try {
      const result=await this.reply(["before:"+kind,{type:"image",file:source},"after:"+kind])
      record(kind+".json",{kind,ok:true,result})
    }catch(error){record(kind+".json",{kind,ok:false,error:{code:error.code??null,message:String(error.message).slice(0,500)}})}
    return true
  }
}
`

const adapterSource = `import fs from "node:fs"
import path from "node:path"
import {createHash} from "node:crypto"
import {fileURLToPath} from "node:url"
const own=path.dirname(fileURLToPath(import.meta.url))
const identity=()=>({pid:process.pid,pidNamespace:process.platform==="linux"?fs.readlinkSync("/proc/self/ns/pid"):null})
const record=(file,value)=>fs.writeFileSync(path.join(own,file),JSON.stringify({...identity(),...value}))
let loaded=false, sends=0
const sdk={secret:"stays-in-adapter-guest",async sendMsg(message){
  if(!Array.isArray(message)||message.length!==3||message[1]?.type!=="image"||!Buffer.isBuffer(message[1].file))throw new Error("SDK requires original Buffer image arguments")
  sends++
  record("sdk-"+sends+".json",{sends,segments:[message[0],{type:"image",buffer:true,size:message[1].file.length,sha256:createHash("sha256").update(message[1].file).digest("hex")},message[2]]})
  return {message_id:"native-media-"+sends}
}}
const adapter={id:"native-media-adapter",name:"Native media fixture adapter",version:"fixture",async load(){
  if(loaded)return true
  loaded=true
  Bot.native_media_account={adapter:this,uin:"native_media_account",nickname:"Media account",sdk,fl:new Map([["media-user",{user_id:"media-user",nickname:"Media user"}]]),gl:new Map(),gml:new Map(),
    pickFriend:user=>({user_id:user,sendMsg:sdk.sendMsg.bind(sdk),recallMsg:async()=>true}),
    async logout(){record("logout.json",{logout:true,sends,sdkLookup:Bot.native_media_account.sdk.secret===sdk.secret});Bot.em("disconnect.native_media_account",{self_id:"native_media_account"})}}
  record("initialized.json",{initialized:true})
  Bot.em("connect.native_media_account",{self_id:"native_media_account"})
  return true
}}
Bot.adapter.push(adapter)
export class MediaAdapterSettings extends plugin {constructor(){super({name:"Native media adapter settings",rule:[]})}}
`

const driverSource = `import fs from "node:fs"
import loader from "../../lib/plugins/loader.js"
export class Driver extends plugin {
  constructor(){super({name:"Trusted native media driver",rule:[]})}
  init(){Bot.once("online",()=>setTimeout(async()=>{
    const result={corePid:process.pid,loaded:loader.priority.filter(row=>["native-media-business","native-media-adapter"].includes(row.key)).map(row=>row.key),commands:[]}
    try{
      const adapter=Bot.adapter.find(row=>row.id==="native-media-adapter")
      if(!adapter)throw new Error("Native adapter facade missing")
      await adapter.load()
      await adapter.load()
      const account=Bot.native_media_account
      if(!account)throw new Error("Native account facade missing")
      result.sdkHidden=account.sdk===undefined
      result.nativeFacade=adapter.path.startsWith("native:native-media-adapter:")
      result.ids=[...Bot.uin]
      for(const kind of ["buffer","file","invalid","url"]){
        const text="#native-media-"+kind
        const event={self_id:"native_media_account",user_id:"media-user",post_type:"message",message_type:"private",message:[{type:"text",text}],raw_message:text}
        Bot.prepareEvent(event)
        await loader.deal(event)
        result.commands.push(kind)
      }
    }catch(error){result.error=String(error.stack)}
    fs.writeFileSync("data/native-media-driver.json",JSON.stringify(result))
  },200))}
}
`

test(
  "real core transports images between independent business and adapter OS sandboxes",
  {
    skip: enabled
      ? false
      : "requires GUARD_TEST_NATIVE_MEDIA=1 and Windows AppContainer/Linux bubblewrap",
    timeout: 240000,
  },
  async t => {
    const ids = ["native-media-business", "native-media-adapter"]
    const fixture = await createEnvironmentFixture({
      mode: "managed",
      label: "native-media-core",
      probe: false,
      settings: {
        shutdownTimeout: 10000,
        recovery: { maxRestarts: 0, windowMs: 60000, baseDelayMs: 50, maxDelayMs: 100 },
        pluginSandbox: {
          native: {
            plugins: ids.map(id => ({
              id,
              timeoutMs: 15000,
              network: "none",
              adapters: id === "native-media-adapter",
            })),
          },
        },
      },
    })
    t.diagnostic(`Evidence: ${fixture.runRoot}`)
    const sources = {
      "native-media-business": businessSource,
      "native-media-adapter": adapterSource,
      "native-media-driver": driverSource,
    }
    const sourceHashesBefore = {}
    for (const [id, source] of Object.entries(sources)) {
      const directory = path.join(fixture.root, "plugins", id)
      fs.mkdirSync(directory)
      const syntax = spawnSync(process.execPath, ["--check", "--input-type=module"], {
        input: source,
        encoding: "utf8",
      })
      assert.equal(syntax.status, 0, syntax.stderr)
      const file = path.join(directory, "index.js")
      fs.writeFileSync(file, source, "utf8")
      sourceHashesBefore[path.relative(fixture.root, file)] = sha(source)
    }
    const guardBuild = Object.fromEntries(
      ["dist", "native"]
        .flatMap(directory =>
          fs
            .readdirSync(path.join(fixture.pluginDir, directory), {
              recursive: true,
              withFileTypes: true,
            })
            .filter(entry => entry.isFile())
            .map(entry => {
              const file = path.join(entry.parentPath, entry.name)
              return [
                path.relative(fixture.pluginDir, file).replaceAll("\\", "/"),
                sha(fs.readFileSync(file)),
              ]
            }),
        )
        .sort(([a], [b]) => a.localeCompare(b)),
    )
    const buildManifest = JSON.stringify(guardBuild, null, 2) + "\n"
    fs.writeFileSync(path.join(fixture.runRoot, "guard-build-manifest.json"), buildManifest, "utf8")
    const report = {
      platform: process.platform,
      node: process.version,
      scope:
        "Generated unchanged original plugin/adapter APIs through 47-file real core; not external accounts or ecosystem qualification",
      redis: fixture.redisFixture,
      network: "none for both native processes",
      sourceHashesBefore,
      guardBuild: {
        files: Object.keys(guardBuild).length,
        sha256: sha(buildManifest),
        manifest: "guard-build-manifest.json",
      },
      media: {
        bytes: png.length,
        sha256: sha(png),
        transport: "business guest -> host bounded bytes -> separate adapter guest SDK",
      },
    }
    const logPath = path.join(fixture.runRoot, "native-media.log")
    const log = fs.openSync(logPath, "w")
    const child = spawn(process.execPath, [fixture.launcher], {
      cwd: fixture.root,
      env: { ...process.env, NODE_OPTIONS: "" },
      stdio: ["ignore", log, log],
      windowsHide: true,
    })
    fs.closeSync(log)
    let failure
    try {
      const status = await fixture.waitOnline()
      report.generation = status.generation
      assert.equal(status.generation, 1)
      const driver = await waitFor(
        () => readJson(path.join(fixture.root, "data/native-media-driver.json")),
        "Real core media driver did not finish; inspect native-media.log",
      )
      report.driver = driver
      assert.equal(driver.error, undefined)
      assert.deepEqual(driver.loaded.sort(), [...ids].sort())
      assert.equal(driver.sdkHidden, true)
      assert.equal(driver.nativeFacade, true)
      assert.ok(driver.ids.includes("native_media_account"))
      assert.deepEqual(driver.commands, ["buffer", "file", "invalid", "url"])
      const business = path.join(fixture.root, "plugins", ids[0]),
        adapter = path.join(fixture.root, "plugins", ids[1])
      const businessIdentity = readJson(path.join(business, "initialized.json")),
        adapterIdentity = readJson(path.join(adapter, "initialized.json"))
      assert.ok(businessIdentity && adapterIdentity)
      for (const identity of [businessIdentity, adapterIdentity])
        assert.notEqual(identity.pid, driver.corePid)
      assert.notEqual(
        `${businessIdentity.pid}:${businessIdentity.pidNamespace}`,
        `${adapterIdentity.pid}:${adapterIdentity.pidNamespace}`,
      )
      report.guests = { business: businessIdentity, adapter: adapterIdentity }
      report.results = {}
      for (const [index, kind] of ["buffer", "file"].entries()) {
        const sent = readJson(path.join(adapter, `sdk-${index + 1}.json`)),
          result = readJson(path.join(business, `${kind}.json`))
        assert.deepEqual(sent, {
          pid: adapterIdentity.pid,
          pidNamespace: adapterIdentity.pidNamespace,
          sends: index + 1,
          segments: [
            `before:${kind}`,
            { type: "image", buffer: true, size: png.length, sha256: sha(png) },
            `after:${kind}`,
          ],
        })
        assert.equal(result.ok, true)
        assert.equal(result.result.message_id, `native-media-${index + 1}`)
        report.results[kind] = { sent, result }
      }
      for (const kind of ["invalid", "url"]) {
        const result = readJson(path.join(business, `${kind}.json`))
        assert.equal(result.ok, false, `${kind}: source unexpectedly reached an original SDK`)
        report.results[kind] = result
      }
      assert.equal(fs.existsSync(path.join(adapter, "sdk-3.json")), false)
      assert.equal(sha(fs.readFileSync(path.join(business, "private-image.png"))), sha(png))
      report.status = "passed"
    } catch (error) {
      failure = error
      report.status = "failed"
      report.failure = String(error.stack)
    } finally {
      try {
        Object.assign(report, await fixture.finish())
        await waitFor(
          () => child.exitCode !== null || child.signalCode !== null,
          "Media fixture launcher did not exit",
          15000,
        )
        report.cleanup = true
        report.events = fixture
          .events()
          .filter(row => row.type === "audit" && ids.includes(row.event?.plugin))
          .map(row => row.event)
        for (const id of ids) {
          assert.equal(
            report.events.filter(
              row => row.plugin === id && row.operation === "native.process-started",
            ).length,
            1,
          )
          assert.equal(
            report.events.filter(
              row => row.plugin === id && row.operation === "native.process-closed",
            ).length,
            1,
          )
        }
        report.activeJournals = fs
          .readdirSync(fixture.stateDir)
          .filter(name => /^windows-sandbox.*-active\.json$/.test(name))
        assert.deepEqual(report.activeJournals, [])
        if (report.guests) {
          report.disposed = readJson(path.join(fixture.root, "plugins", ids[0], "disposed.json"))
          report.logout = readJson(path.join(fixture.root, "plugins", ids[1], "logout.json"))
          assert.equal(report.disposed.disposed, true)
          assert.equal(report.logout.logout, true)
          assert.equal(report.logout.sdkLookup, true)
          assert.equal(report.logout.sends, 2)
        }
      } catch (error) {
        failure ??= error
        report.status = "failed"
        report.cleanup = false
        report.cleanupError = String(error.stack)
      }
      report.sourceHashesAfter = Object.fromEntries(
        Object.keys(sourceHashesBefore).map(file => [
          file,
          sha(fs.readFileSync(path.join(fixture.root, file))),
        ]),
      )
      try {
        assert.deepEqual(report.sourceHashesAfter, sourceHashesBefore)
        Object.assign(report, fixture.verifyCoreHashes())
      } catch (error) {
        failure ??= error
        report.status = "failed"
        report.verificationError = String(error.stack)
      }
      fs.writeFileSync(
        path.join(fixture.runRoot, "native-media-report.json"),
        JSON.stringify(report, null, 2) + "\n",
        "utf8",
      )
    }
    if (failure) throw failure
  },
)
