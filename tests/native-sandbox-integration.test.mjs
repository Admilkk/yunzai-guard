import assert from "node:assert/strict"
import fs from "node:fs"
import path from "node:path"
import { createHash } from "node:crypto"
import { spawn, spawnSync } from "node:child_process"
import { performance } from "node:perf_hooks"
import test from "node:test"
import { createEnvironmentFixture } from "./environment-fixture.mjs"

const enabled =
  process.env.GUARD_TEST_NATIVE_CORE === "1" && ["win32", "linux"].includes(process.platform)
const pause = ms => new Promise(resolve => setTimeout(resolve, ms))
const digest = file => createHash("sha256").update(fs.readFileSync(file)).digest("hex")
const readJson = file => {
  if (!fs.existsSync(file)) return undefined
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"))
  } catch (error) {
    if (error instanceof SyntaxError) return undefined
    throw error
  }
}
const write = (file, value) => fs.writeFileSync(file, value, "utf8")

async function waitFor(predicate, description, timeout = 60000) {
  const deadline = performance.now() + timeout
  while (performance.now() < deadline) {
    const value = await predicate()
    if (value) return value
    await pause(40)
  }
  throw new Error(description)
}

function businessSource(id, other) {
  return `import fs from "node:fs"
import path from "node:path"
import {fileURLToPath} from "node:url"
import staticValue from "./static.mjs"
const dynamicValue=(await import("./dynamic.mjs?fixture=1")).default
await Promise.resolve()
const own=path.dirname(fileURLToPath(import.meta.url))
const root=path.resolve(own,"../..")
const inheritedMarker=globalThis.__nativeIntegrationMarker??null
globalThis.__nativeIntegrationMarker=${JSON.stringify(id)}
globalThis.__nativeIntegrationRegexCalls=0
const identity=()=>({pid:process.pid,pidNamespace:process.platform==="linux"?fs.readlinkSync("/proc/self/ns/pid"):null})
const put=(name,value)=>fs.writeFileSync(path.join(own,name),JSON.stringify(value))
let eventCalls=0,onceCalls=0,exitCalls=0
const eventListener=async function(e){
  await e.reply(${JSON.stringify(`event:${id}:`)}+e.msg)
  put("event.json",{...identity(),calls:++eventCalls,msg:e.msg,receiver:this===Bot})
  return Bot
}
const attempt=file=>{try{fs.appendFileSync(file,"\\nforbidden integration write");return {blocked:false}}catch(error){return {blocked:true,code:error.code}}}
const matcher=new RegExp(${JSON.stringify(`^#${id}$`)})
matcher.test=function(text){globalThis.__nativeIntegrationRegexCalls++;put("regex.json",{...identity(),calls:globalThis.__nativeIntegrationRegexCalls,text});return RegExp.prototype.test.call(this,text)}
export class BusinessPlugin extends plugin {
  constructor(){super({name:${JSON.stringify(id)},event:"message",priority:100,rule:[{reg:matcher,fnc:"replyCommand"},{reg:${JSON.stringify(`^#${id}-wait$`)},fnc:"waitForInput"},{reg:${JSON.stringify(`^#${id}-off$`)},fnc:"stopEvents"}],task:{name:${JSON.stringify(`${id}-task`)},cron:"* * * * * *",log:false,fnc:async function(){await Promise.resolve();this.taskRuns=(this.taskRuns??0)+1;put("task.json",{...identity(),runs:this.taskRuns,name:this.name})}}})}
  init(){
    Bot.on("guard.native-test",eventListener)
    Bot.once("guard.native-once",()=>put("once.json",{...identity(),calls:++onceCalls}))
    Bot.on("exit",async reason=>{await Promise.resolve();put("exit.json",{...identity(),calls:++exitCalls,reason})})
    this.addCleanup(async()=>{await Promise.resolve();put("disposed.json",{...identity(),name:this.name})})
    const crossWrite=attempt(path.join(root,"plugins",${JSON.stringify(other)},${JSON.stringify(`${id}-escape.txt`)}))
    const coreWrite=attempt(path.join(root,"app.js"))
    put("init.json",{...identity(),inheritedMarker,marker:globalThis.__nativeIntegrationMarker,staticValue,dynamicValue,crossWrite,coreWrite})
  }
  stopEvents(){Bot.off("guard.native-test",eventListener);return true}
  async replyCommand(e){
    put("message.json",{...identity(),msg:e.msg,isMaster:e.isMaster,marker:globalThis.__nativeIntegrationMarker,regexCalls:globalThis.__nativeIntegrationRegexCalls})
    await this.reply(${JSON.stringify(`${id}:`)}+staticValue+":"+dynamicValue)
    return true
  }
  async waitForInput(e){
    const waiting=this.awaitContext(false,0)
    put("context-ready.json",{...identity(),msg:e.msg})
    const answer=await waiting
    put("context.json",{...identity(),previous:e.msg,current:answer.msg})
    await this.reply("context:"+answer.msg)
    return true
  }
}
`
}

test(
  "two unchanged ESM business plugins use separate OS sandboxes through the real core loader",
  {
    skip: enabled
      ? false
      : "requires GUARD_TEST_NATIVE_CORE=1 and working Windows AppContainer/Linux bubblewrap",
    timeout: 180000,
  },
  async t => {
    const ids = ["native-alpha", "native-beta"]
    const fixture = await createEnvironmentFixture({
      mode: "managed",
      label: "native-plugin-core",
      settings: {
        recovery: { maxRestarts: 0, windowMs: 60000, baseDelayMs: 50, maxDelayMs: 100 },
        pluginSandbox: {
          native: { plugins: ids.map(id => ({ id, timeoutMs: 15000, network: "none" })) },
        },
      },
    })
    t.diagnostic(`Evidence: ${fixture.runRoot}`)
    const expectedSources = {}
    for (const [index, id] of ids.entries()) {
      const directory = path.join(fixture.root, "plugins", id)
      fs.mkdirSync(directory)
      for (const [name, source] of Object.entries({
        "index.js": businessSource(id, ids[1 - index]),
        "static.mjs": 'export default "static-import"\n',
        "dynamic.mjs": 'export default "dynamic-import"\n',
      })) {
        const file = path.join(directory, name)
        const syntax = spawnSync(process.execPath, ["--check", "--input-type=module"], {
          input: source,
          encoding: "utf8",
        })
        assert.equal(syntax.status, 0, syntax.stderr)
        write(file, source)
        expectedSources[path.relative(fixture.root, file)] = digest(file)
      }
    }
    const driver = path.join(fixture.root, "plugins/native-integration-driver")
    fs.mkdirSync(driver)
    write(
      path.join(driver, "index.js"),
      `import fs from "node:fs"
import loader from "../../lib/plugins/loader.js"
const record=value=>fs.writeFileSync("data/native-integration-driver.json",JSON.stringify(value))
export class Driver extends plugin {
  constructor(){super({name:"Trusted native integration driver",rule:[]})}
  init(){Bot.once("online",()=>setTimeout(async()=>{
    const result={corePid:process.pid,marker:globalThis.__nativeIntegrationMarker??null,regexCalls:globalThis.__nativeIntegrationRegexCalls??null,
      loaded:loader.priority.filter(row=>${JSON.stringify(ids)}.includes(row.key)).map(row=>({key:row.key,name:row.name})),replies:[],contextReplies:[],eventReplies:[],coreEvents:0}
    try {
      for(const id of ${JSON.stringify(ids)}){
        const text="#"+id
        await loader.deal({self_id:"test",user_id:"test-user",post_type:"message",message_type:"private",isPrivate:true,message:[{type:"text",text}],raw_message:text,
          reply:async value=>{result.replies.push({id,text:value});return {message_id:"native-test"}}
        })
      }
      for(const id of ${JSON.stringify(ids)}){
        const makeEvent=text=>({self_id:"test",user_id:"context-user-"+id,post_type:"message",message_type:"private",isPrivate:true,message:[{type:"text",text}],raw_message:text,
          reply:async value=>{result.contextReplies.push({id,text:value});return {message_id:"context-test"}}})
        const first=loader.deal(makeEvent("#"+id+"-wait"))
        const deadline=performance.now()+5000
        while(!fs.existsSync("plugins/"+id+"/context-ready.json")){
          if(performance.now()>deadline)throw new Error("Context did not become ready: "+id)
          await new Promise(resolve=>setTimeout(resolve,20))
        }
        await loader.deal(makeEvent("answer-"+id))
        await first
      }
      const eventName="guard.native-test",coreListener=()=>result.coreEvents++
      Bot.bot.on(eventName,coreListener)
      const emit=msg=>Bot.bot.emit(eventName,{msg,reply:async text=>{result.eventReplies.push(text);return {message_id:"event-test"}}})
      const waitEvents=async counts=>{
        const deadline=performance.now()+5000
        while(!${JSON.stringify(ids)}.every((id,index)=>{
          try{return JSON.parse(fs.readFileSync("plugins/"+id+"/event.json","utf8")).calls===counts[index]}catch{return false}
        })){if(performance.now()>deadline)throw new Error("Bot event bridge did not finish");await new Promise(resolve=>setTimeout(resolve,20))}
      }
      try{
        emit("first");await waitEvents([1,1])
        await loader.deal({self_id:"test",user_id:"test-user",post_type:"message",message_type:"private",isPrivate:true,
          message:[{type:"text",text:${JSON.stringify(`#${ids[0]}-off`)}}],raw_message:${JSON.stringify(`#${ids[0]}-off`)},reply:async()=>({message_id:"off-test"})})
        emit("second");await waitEvents([1,2])
        result.coreListenerPreserved=Bot.bot.listeners(eventName).includes(coreListener)
      }finally{Bot.bot.off(eventName,coreListener)}
      Bot.bot.emit("guard.native-once");Bot.bot.emit("guard.native-once")
      const onceDeadline=performance.now()+5000
      while(!${JSON.stringify(ids)}.every(id=>fs.existsSync("plugins/"+id+"/once.json"))){
        if(performance.now()>onceDeadline)throw new Error("Bot.once bridge did not finish");await new Promise(resolve=>setTimeout(resolve,20))
      }
      result.markerAfter=globalThis.__nativeIntegrationMarker??null
      result.regexCallsAfter=globalThis.__nativeIntegrationRegexCalls??null
    }catch(error){result.error=String(error.stack)}
    record(result)
  },200))}
}
`,
    )
    const log = fs.openSync(path.join(fixture.runRoot, "native-integration.log"), "w")
    const child = spawn(process.execPath, [fixture.launcher], {
      cwd: fixture.root,
      env: { ...process.env, NODE_OPTIONS: "" },
      stdio: ["ignore", log, log],
      windowsHide: true,
    })
    fs.closeSync(log)
    let failure
    let cleanupError
    const report = {
      platform: process.platform,
      node: process.version,
      entry: "explicit Guard launcher with managed core and per-plugin OS sandboxes",
      redis: fixture.redisFixture,
      coverage: "Two generated ESM plugins only; no claim of full ecosystem compatibility",
      sourceHashesBefore: expectedSources,
    }
    try {
      const status = await fixture.waitOnline()
      report.generation = status.generation
      assert.equal(status.generation, 1, "Sandbox startup must not fall back through a restart")
      const result = await waitFor(
        () => readJson(path.join(fixture.root, "data/native-integration-driver.json")),
        "Trusted core driver did not finish; inspect native-integration.log",
      )
      report.driver = result
      assert.equal(result.error, undefined)
      assert.equal(result.marker, null)
      assert.equal(result.markerAfter, null)
      assert.equal(result.regexCalls, null)
      assert.equal(result.regexCallsAfter, null)
      assert.deepEqual(result.loaded.map(row => row.key).sort(), ids)
      assert.deepEqual(
        result.replies,
        ids.map(id => ({ id, text: `${id}:static-import:dynamic-import` })),
      )
      assert.deepEqual(
        result.contextReplies,
        ids.map(id => ({ id, text: `context:answer-${id}` })),
      )
      assert.deepEqual(
        result.eventReplies.sort(),
        [`event:${ids[0]}:first`, `event:${ids[1]}:first`, `event:${ids[1]}:second`].sort(),
      )
      assert.equal(result.coreEvents, 2)
      assert.equal(result.coreListenerPreserved, true)
      const guestEvidence = {}
      const taskDeadline = performance.now() + 5000
      for (const [index, id] of ids.entries()) {
        const directory = path.join(fixture.root, "plugins", id)
        const init = readJson(path.join(directory, "init.json"))
        const regex = readJson(path.join(directory, "regex.json"))
        const message = readJson(path.join(directory, "message.json"))
        const context = readJson(path.join(directory, "context.json"))
        const event = readJson(path.join(directory, "event.json"))
        const once = readJson(path.join(directory, "once.json"))
        assert.ok(init && regex && message, `${id}: expected guest file evidence is missing`)
        assert.notEqual(init.pid, result.corePid, `${id}: plugin executed in core`)
        assert.equal(init.marker, id)
        assert.equal(init.inheritedMarker, null, `${id}: another plugin's global leaked`)
        assert.equal(init.staticValue, "static-import")
        assert.equal(init.dynamicValue, "dynamic-import")
        for (const denial of [init.crossWrite, init.coreWrite]) {
          assert.equal(denial.blocked, true, `${id}: write escaped plugin directory`)
          assert.ok(
            ["EACCES", "EPERM", "EROFS"].includes(denial.code),
            `${id}: unexpected OS refusal ${denial.code}`,
          )
        }
        assert.equal(
          fs.existsSync(path.join(fixture.root, "plugins", ids[1 - index], `${id}-escape.txt`)),
          false,
        )
        assert.equal(regex.pid, init.pid)
        assert.ok(regex.calls >= 1)
        assert.equal(message.pid, init.pid)
        assert.ok(message.regexCalls >= 1)
        assert.equal(message.marker, id)
        assert.equal(message.msg, `#${id}`)
        assert.equal(message.isMaster, false)
        assert.deepEqual(context, {
          pid: init.pid,
          pidNamespace: init.pidNamespace,
          previous: `#${id}-wait`,
          current: `answer-${id}`,
        })
        assert.equal(event.pid, init.pid)
        assert.equal(event.receiver, true)
        assert.equal(event.calls, index === 0 ? 1 : 2)
        assert.equal(once.pid, init.pid)
        assert.equal(once.calls, 1)
        const task = await waitFor(
          () => readJson(path.join(directory, "task.json")),
          `${id}: function-valued task did not run within the 5-second observation window`,
          Math.max(0, taskDeadline - performance.now()),
        )
        assert.equal(task.pid, init.pid)
        assert.equal(task.name, id)
        assert.ok(task.runs >= 1)
        guestEvidence[id] = { init, regex, message, context, task, event, once }
      }
      report.guests = guestEvidence
      assert.notEqual(
        `${guestEvidence[ids[0]].init.pid}:${guestEvidence[ids[0]].init.pidNamespace}`,
        `${guestEvidence[ids[1]].init.pid}:${guestEvidence[ids[1]].init.pidNamespace}`,
        "The two plugin processes must have distinct PID identities",
      )
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
          "Guard launcher did not stop",
          10000,
        )
        report.cleanup = true
      } catch (error) {
        cleanupError = error
        report.status = "failed"
        report.cleanup = false
        report.cleanupError = String(error.stack)
      }
      report.sourceHashesAfter = Object.fromEntries(
        Object.keys(expectedSources).map(file => [file, digest(path.join(fixture.root, file))]),
      )
      try {
        assert.deepEqual(report.sourceHashesAfter, expectedSources)
        if (report.guests) {
          report.disposed = {}
          for (const id of ids) {
            const disposed = readJson(path.join(fixture.root, "plugins", id, "disposed.json"))
            assert.ok(disposed, `${id}: registered cleanup did not run before OS shutdown`)
            assert.equal(disposed.pid, report.guests[id].init.pid)
            assert.equal(disposed.name, id)
            report.disposed[id] = disposed
            const exit = readJson(path.join(fixture.root, "plugins", id, "exit.json"))
            assert.ok(exit, `${id}: original Bot exit callback did not run`)
            assert.equal(exit.pid, report.guests[id].init.pid)
            assert.equal(exit.calls, 1, `${id}: host and guest exit duplicated cleanup`)
            report.disposed[id].exit = exit
          }
        }
        report.shutdownSchedulerClean = !fs
          .readFileSync(path.join(fixture.runRoot, "native-integration.log"), "utf8")
          .includes("独立沙箱已关闭")
        assert.equal(
          report.shutdownSchedulerClean,
          true,
          "Core scheduled work ran after its native plugin sandbox closed",
        )
      } catch (error) {
        failure ??= error
        report.failure = String(error.stack)
        report.status = "failed"
      }
      write(
        path.join(fixture.runRoot, "native-integration-report.json"),
        JSON.stringify(report, null, 2) + "\n",
      )
    }
    if (failure) throw failure
    if (cleanupError) throw cleanupError
  },
)
