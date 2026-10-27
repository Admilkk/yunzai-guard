import assert from "node:assert/strict"
import fs from "node:fs"
import path from "node:path"
import { spawn } from "node:child_process"
import test from "node:test"
import { createEnvironmentFixture, until } from "./environment-fixture.mjs"

const enabled =
  process.env.GUARD_TEST_STRICT_CORE === "1" && ["win32", "linux"].includes(process.platform)
for (const mode of ["managed", "os-sandbox"])
  test(
    `plugin sandboxes run through unchanged core, isolate files and recover violations (${mode})`,
    { skip: enabled ? false : "requires GUARD_TEST_STRICT_CORE=1", timeout: 120000 },
    async t => {
      const programs = {
        allowed:
          'onMessage=async e=>{await Promise.resolve();guard.writeText("state.json",JSON.stringify({message:e.message}));guard.reply("allowed")}',
        traversal: 'onMessage=()=>{guard.writeText("../outside.txt","bad");guard.reply("bad")}',
        escape:
          'onMessage=()=>{let p;try{p=guard.invoke.constructor("return process")()}catch{};if(p){p.getBuiltinModule("fs").writeFileSync("data/escaped.txt","bad")}guard.reply(p?"escaped":"contained")}',
        network:
          'onMessage=()=>{try{guard.invoke("fetch","http://127.0.0.1:1")}catch{};guard.writeText("bad.txt","bad")}',
        module:
          'onMessage=async()=>{try{await import("node:child_process")}catch{};guard.writeText("bad.txt","bad")}',
        timeout: 'onMessage=()=>{guard.writeText("bad.txt","bad");while(true){}}',
        audit: 'onMessage=()=>{try{Bot.em=()=>{}}catch{};guard.reply("audit-continued")}',
        deny: 'onMessage=()=>{try{Bot.em=()=>{}}catch{};guard.reply("must-not-send")}',
        restart: 'onMessage=()=>{guard.writeText("bad.txt","bad");guard.reply("restart")}',
      }
      const fixture = await createEnvironmentFixture({
        mode,
        label: "strict-core",
        settings: {
          pluginSandbox: {
            defaults: { timeoutMs: 200 },
            plugins: Object.keys(programs).map(id => ({
              id,
              match: `#strict-${id}`,
              capabilities: ["reply", "writeText"],
              hookAction: id === "audit" ? "audit" : "deny",
            })),
          },
          rules: [
            {
              id: "strict-restart",
              kind: "plugin-sandbox",
              plugin: "restart",
              operation: "sandbox.reply",
              action: "restart",
            },
          ],
        },
      })
      t.diagnostic(`Evidence: ${fixture.runRoot}`)
      const scripts = path.join(fixture.stateDir, "scripts")
      fs.mkdirSync(scripts)
      for (const [id, code] of Object.entries(programs))
        fs.writeFileSync(path.join(scripts, `${id}.js`), code)
      const probe = path.join(fixture.root, "plugins/strict-test-driver")
      fs.mkdirSync(probe)
      fs.writeFileSync(
        path.join(probe, "index.js"),
        `import fs from "node:fs"
import loader from "../../lib/plugins/loader.js"
export class Driver extends plugin {
  constructor(){super({name:"Sandbox driver",rule:[]})}
  init(){
    if(!globalThis[Symbol.for("yunzai.guard.context.v1")])return
    Bot.once("online",()=>setTimeout(async()=>{
      if(fs.existsSync("data/strict-sent.txt"))return
      fs.writeFileSync("data/strict-sent.txt","sent")
      try{
        for(const id of ${JSON.stringify(Object.keys(programs))}){
          const text="#strict-"+id
          await loader.deal({self_id:"test",user_id:"test-user",post_type:"message",message_type:"private",isPrivate:true,message:[{type:"text",text}],raw_message:text,
            reply:async value=>{fs.appendFileSync("data/strict-replies.jsonl",JSON.stringify({id,text:value})+"\\n");return {message_id:"test"}}
          })
        }
      }catch(error){fs.writeFileSync("data/strict-driver-error.txt",String(error.stack))}
    },200))
  }
}`,
      )
      const allowedSource = path.join(scripts, "allowed.js")
      fs.writeFileSync(
        allowedSource,
        'if(typeof process!=="undefined")process.getBuiltinModule("fs").writeFileSync("data/strict-source-ran-in-node.txt","bad");\n' +
          programs.allowed,
      )
      const output = fs.openSync(path.join(fixture.runRoot, "strict-core.log"), "w")
      const child = spawn(
        process.execPath,
        [mode === "managed" ? path.join(fixture.root, "app.js") : fixture.launcher],
        {
          cwd: fixture.root,
          env: { ...process.env, NODE_OPTIONS: "" },
          stdio: ["ignore", output, output],
          windowsHide: true,
        },
      )
      fs.closeSync(output)
      let failure, report
      try {
        await fixture.waitOnline()
        const current = await fixture.waitOnline(2)
        if (mode === "managed") {
          assert.notEqual(current.hostPid, child.pid)
          assert.equal(child.exitCode, 0)
        } else assert.equal(current.hostPid, child.pid)
        assert.equal(
          fs.existsSync(path.join(fixture.root, "data/strict-source-ran-in-node.txt")),
          false,
        )
        assert.equal(current.pluginSandbox.enabled, true)
        assert.equal(current.pluginSandbox.plugins.length, Object.keys(programs).length)
        const allowed = path.join(fixture.root, "data/yunzai-guard-strict/allowed/state.json")
        assert.deepEqual(JSON.parse(fs.readFileSync(allowed, "utf8")), {
          message: "#strict-allowed",
        })
        const replies = fs
          .readFileSync(path.join(fixture.root, "data/strict-replies.jsonl"), "utf8")
          .trim()
          .split("\n")
          .map(JSON.parse)
        assert.deepEqual(replies, [
          { id: "allowed", text: "allowed" },
          { id: "escape", text: "contained" },
          { id: "audit", text: "audit-continued" },
        ])
        for (const file of [
          "data/outside.txt",
          "data/yunzai-guard-strict/outside.txt",
          "data/escaped.txt",
          ...["network", "module", "timeout", "restart"].map(
            id => `data/yunzai-guard-strict/${id}/bad.txt`,
          ),
        ])
          assert.equal(fs.existsSync(path.join(fixture.root, file)), false, file)
        assert.equal(fs.existsSync(path.join(fixture.root, "data/strict-driver-error.txt")), false)
        const events = fixture.events().filter(row => row.event?.kind === "plugin-sandbox")
        for (const [id, action] of [
          ["audit", "audit"],
          ["deny", "deny"],
        ])
          assert.ok(
            events.some(
              row =>
                row.event.plugin === id &&
                row.event.operation === "sandbox.hook" &&
                row.event.action === action &&
                row.event.blocked === true,
            ),
          )
        for (const id of ["traversal", "network", "module", "timeout"])
          assert.ok(
            events.some(
              row => row.event.plugin === id && row.event.operation === "sandbox.violation",
            ),
            id,
          )
        assert.ok(events.some(row => row.event.ruleId === "strict-restart"))
        report = {
          platform: process.platform,
          mode,
          node: process.version,
          entry: mode === "managed" ? "node app.js automatic takeover" : "explicit launcher",
          generation: current.generation,
          checks: [
            "reply and own file",
            "path traversal",
            "constructor escape",
            "network capability",
            "Node module import",
            "timeout discards writes",
            "policy denial discards writes and restarts",
          ],
          ...fixture.verifyCoreHashes(),
        }
      } catch (error) {
        failure = error
      } finally {
        await fixture.finish()
        await until(
          () => child.exitCode !== null || child.signalCode !== null,
          "Launcher cleanup incomplete",
          10000,
        )
        fs.writeFileSync(
          path.join(fixture.runRoot, "strict-report.json"),
          JSON.stringify({ ...report, failure: failure?.stack, cleanup: true }, null, 2),
        )
      }
      if (failure) throw failure
    },
  )
