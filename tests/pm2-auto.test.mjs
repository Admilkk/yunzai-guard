import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { spawn, execFileSync } from "node:child_process"
import { once } from "node:events"
import test from "node:test"
import { fileURLToPath } from "node:url"
import { hasPm2Environment, pm2ApplicationId, assertPm2Registration } from "../dist/pm2/auto.js"
import {
  assertParentProof,
  parseParentRecord,
  parseWindowsListeners,
  parseInspectorReply,
  readParentProof,
  assertParentUnchanged,
  assertLoopbackInspectorArguments,
  safeRuntimeError,
  normalizeInspectorEndpoint,
  sameInspectorTarget,
} from "../dist/pm2/inspector.js"

const autoUrl = new URL("../dist/pm2/auto.js", import.meta.url).href
const inspectorUrl = new URL("../dist/pm2/inspector.js", import.meta.url).href
function fixture(context) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "guard-pm2-auto-"))
  const launcher = path.join(root, "launcher.js")
  fs.writeFileSync(launcher, "")
  context.after(() => {
    assert.match(path.basename(root), /^guard-pm2-auto-/)
    assert.equal(fs.realpathSync.native(path.dirname(root)), fs.realpathSync.native(os.tmpdir()))
    assert.equal(path.dirname(fs.realpathSync.native(root)), fs.realpathSync.native(os.tmpdir()))
    fs.rmSync(root, { recursive: true, force: true })
  })
  return { root, launcher }
}

test("automatic PM2 registration distinguishes ordinary IPC from actual PM2 environment clues", () => {
  assert.equal(hasPm2Environment({}), false)
  assert.equal(hasPm2Environment({ PM2_HOME: "unused" }), false)
  assert.equal(hasPm2Environment({ NODE_APP_INSTANCE: "0" }), false)
  assert.equal(hasPm2Environment({ pm_id: "0" }), true)
  assert.equal(hasPm2Environment({ PM2_HOME: "unused", NODE_APP_INSTANCE: "0" }), true)
  assert.equal(pm2ApplicationId("0"), 0)
  assert.equal(pm2ApplicationId("42"), 42)
  for (const value of [undefined, "", "guard-test", "-1", "01", "0.5", "9007199254740992"])
    assert.throws(() => pm2ApplicationId(value), /PM2 应用身份无效/)
})

test("automatic registration rejects another application, daemon, launcher or handoff mode", context => {
  const { launcher } = fixture(context)
  const expected = {
    pid: 123,
    pmId: 4,
    daemonPid: 99,
    launcherPath: launcher,
    requestRestart: false,
  }
  const valid = {
    status: "registered",
    pid: 123,
    pmId: 4,
    daemonPid: 99,
    launcherPath: launcher,
    requiresHandoff: false,
  }
  assert.doesNotThrow(() => assertPm2Registration(valid, expected))
  for (const patch of [
    { pid: 124 },
    { pmId: 5 },
    { daemonPid: 98 },
    { requiresHandoff: true },
    { status: "pending" },
    { launcherPath: fileURLToPath(import.meta.url) },
  ])
    assert.throws(
      () => assertPm2Registration({ ...valid, ...patch }, expected),
      /PM2 登记应答与本应用不符/,
    )
})

test("a PM2_HOME pid file alone never authorizes opening a parent's Inspector", context => {
  const { root } = fixture(context)
  fs.writeFileSync(path.join(root, "pm2.pid"), String(process.ppid))
  const proof = { pid: process.ppid, created: "1", commandLine: "ordinary-node-parent" }
  assert.throws(() => assertParentProof(proof, root), /直接父进程不是受支持版本的 PM2 守护进程/)
  fs.writeFileSync(path.join(root, "pm2.pid"), String(process.pid))
  assert.throws(
    () => assertParentProof({ ...proof, commandLine: "PM2 v6.0.14: God Daemon (test)" }, root),
    /PM2_HOME 与当前直接父进程不符/,
  )
  const pm2Root = path.join(root, "package with spaces")
  fs.mkdirSync(path.join(pm2Root, "lib"), { recursive: true })
  fs.writeFileSync(
    path.join(pm2Root, "package.json"),
    JSON.stringify({ name: "pm2", version: "6.0.14" }),
  )
  fs.writeFileSync(path.join(root, "pm2.pid"), String(process.ppid))
  assert.doesNotThrow(() =>
    assertParentProof(
      {
        ...proof,
        commandLine: "PM2 v6.0.14: God Daemon (/tmp/yunzai-guard-pm2-title-probe/long-e",
      },
      root,
    ),
  )
  assert.throws(
    () =>
      assertParentProof({ ...proof, commandLine: "PM2 v4.5.0: God Daemon (/tmp/truncated" }, root),
    /直接父进程不是受支持版本的 PM2 守护进程/,
  )
  assert.throws(
    () => assertParentProof({ ...proof, commandLine: "PM2 v6.0.14: God Daemon (" }, root),
    /直接父进程不是受支持版本的 PM2 守护进程/,
  )
  assert.doesNotThrow(() =>
    assertParentProof(
      {
        ...proof,
        commandLine: `"${process.execPath}" --inspect-port=0 "${path.join(pm2Root, "lib/Daemon.js")}"`,
      },
      root,
    ),
  )
  assert.doesNotThrow(() =>
    assertParentProof({ ...proof, commandLine: "PM2 v7.0.3: God Daemon (/tmp/truncated" }, root),
  )
  fs.writeFileSync(
    path.join(pm2Root, "package.json"),
    JSON.stringify({ name: "pm2", version: "7.0.3" }),
  )
  assert.doesNotThrow(() =>
    assertParentProof(
      {
        ...proof,
        commandLine: `"${process.execPath}" --inspect-port=0 "${path.join(pm2Root, "lib/Daemon.js")}"`,
      },
      root,
    ),
  )
})

test("native listener records retain only the selected PID's loopback and wildcard listening sockets", () => {
  const text = `\n TCP 127.0.0.1:9229 0.0.0.0:0 LISTENING 123\n TCP [::1]:9230 [::]:0 LISTENING 123\n TCP 127.0.0.1:9229 0.0.0.0:0 LISTENING 124\n TCP 0.0.0.0:9229 0.0.0.0:0 LISTENING 123\n TCP 127.0.0.1:9229 127.0.0.1:11 ESTABLISHED 123\n UDP 127.0.0.1:1 *:* LISTENING 123\n TCP 127.0.0.1:99999 0.0.0.0:0 LISTENING 123\n`
  assert.deepEqual(parseWindowsListeners(text, 123), [
    { host: "127.0.0.1", port: 9229 },
    { host: "::1", port: 9230 },
    { host: "0.0.0.0", port: 9229 },
  ])
  assert.throws(
    () => parseWindowsListeners("x".repeat(4 * 1024 * 1024 + 1), 123),
    /Windows 监听端口清单超限/,
  )
})

test("wildcard Inspector advertisements are normalized to owned loopback connections for cleanup only", () => {
  assert.deepEqual(
    normalizeInspectorEndpoint("ws://0.0.0.0:9229/owned", { host: "0.0.0.0", port: 9229 }),
    { url: "ws://0.0.0.0:9229/owned", connectUrl: "ws://127.0.0.1:9229/owned", wildcard: true },
  )
  assert.deepEqual(normalizeInspectorEndpoint("ws://[::]:9230/owned", { host: "::", port: 9230 }), {
    url: "ws://[::]:9230/owned",
    connectUrl: "ws://[::1]:9230/owned",
    wildcard: true,
  })
  assert.equal(
    normalizeInspectorEndpoint("ws://remote.example:9229/id", { host: "0.0.0.0", port: 9229 }),
    null,
  )
  assert.equal(
    normalizeInspectorEndpoint("ws://127.0.0.1:9228/id", { host: "127.0.0.1", port: 9229 }),
    null,
  )
  assert.equal(
    normalizeInspectorEndpoint("ws://user:secret@127.0.0.1:9229/id", {
      host: "127.0.0.1",
      port: 9229,
    }),
    null,
  )
  assert.equal(
    sameInspectorTarget("ws://127.0.0.1:9229/owned", "ws://0.0.0.0:9229/owned", true),
    true,
  )
  assert.equal(sameInspectorTarget("ws://[::1]:9229/owned", "ws://[::]:9229/owned", true), true)
  assert.equal(
    sameInspectorTarget("ws://127.0.0.1:9229/owned", "ws://localhost:9229/owned", false),
    true,
  )
  assert.equal(
    sameInspectorTarget("ws://127.0.0.1:9229/owned", "ws://0.0.0.0:9229/owned", false),
    false,
  )
  assert.equal(
    sameInspectorTarget("ws://127.0.0.1:9229/owned", "ws://0.0.0.0:9229/other", true),
    false,
  )
})

test("visible wildcard or remote Inspector arguments are refused before debugger activation", () => {
  for (const argument of [
    "",
    "--inspect",
    "--inspect=0",
    "--inspect-port=0",
    "--inspect-port 9229",
    "--inspect=127.0.0.1:9229",
    "--inspect-port=[::1]:0",
    "--inspect=localhost:9230",
    "--inspect-publish-uid=stderr,http",
  ])
    assert.doesNotThrow(() =>
      assertLoopbackInspectorArguments(`node ${argument} C:/pm2/lib/Daemon.js`),
    )
  for (const argument of [
    "--inspect=0.0.0.0:9229",
    "--inspect-port=0.0.0.0:0",
    "--inspect-brk=[::]:9230",
    "--inspect-port remote.example:9229",
    "--inspect=192.168.1.5:0",
    "--inspect=127.0.0.1:65536",
  ])
    assert.throws(
      () => assertLoopbackInspectorArguments(`node ${argument} C:/pm2/lib/Daemon.js`),
      /自动登记拒绝非回环 Inspector 参数/,
    )
})

test("malformed Inspector and native process records are rejected without uncaught parsing errors", () => {
  for (const value of ["{", "null", "42", '"text"', "x".repeat(1024 * 1024 + 1)])
    assert.equal(parseInspectorReply(value), null)
  assert.deepEqual(parseInspectorReply('{"id":1,"result":{"result":{"value":true}}}'), {
    id: 1,
    result: { result: { value: true } },
  })
  const valid = { pid: 123, created: "123456", commandLine: "node test.js" }
  assert.deepEqual(parseParentRecord(valid, 123), valid)
  for (const value of [
    null,
    {},
    { ...valid, pid: 124 },
    { ...valid, created: 123 },
    { ...valid, commandLine: null },
  ])
    assert.throws(() => parseParentRecord(value, 123), /直接父进程记录格式异常/)
})

test("Runtime failure reasons redact credentials and omit stack or evaluation source", () => {
  const message = safeRuntimeError({
    exception: {
      description:
        'Error: invalid token="token value" password=pass-secret nonce:nonce-secret Authorization: Bearer bearer-secret\n at hidden-stack',
    },
    expression: "never-include-evaluation-source",
  })
  for (const secret of [
    "token value",
    "pass-secret",
    "nonce-secret",
    "bearer-secret",
    "hidden-stack",
    "never-include-evaluation-source",
  ])
    assert.equal(message.includes(secret), false)
  assert.match(message, /invalid/)
  assert.match(message, /REDACTED/)
  assert.ok(
    safeRuntimeError({ exception: { description: "x".repeat(1000) } }).length <=
      "PM2 daemon registration Runtime operation failed: ".length + 240,
  )
  assert.equal(
    safeRuntimeError({ expression: "secret-source" }),
    "PM2 daemon registration Runtime operation failed",
  )
  assert.equal(
    safeRuntimeError({
      exception: {
        description: 'Error: password="first private second private ' + "x".repeat(10000) + '"',
      },
    }).includes("private"),
    false,
  )
})

test(
  "the native parent reader returns the actual direct parent without contacting any PM2 endpoint",
  { skip: !["win32", "linux"].includes(process.platform) },
  () => {
    const record = readParentProof()
    assert.equal(record.pid, process.ppid)
    assert.match(record.created, /^\d+$/)
    assert.ok(record.commandLine.length > 0)
    assert.doesNotThrow(() => assertParentUnchanged(record))
    assert.throws(
      () => assertParentUnchanged({ ...record, created: "0" }),
      /PM2 直接父进程创建身份已变化/,
    )
  },
)

test(
  "Windows parent command lines preserve Chinese text across native PowerShell stdout",
  { skip: process.platform !== "win32" },
  context => {
    const { root } = fixture(context)
    const child = path.join(root, "unicode-child.mjs")
    const parent = path.join(root, "unicode-parent.mjs")
    fs.writeFileSync(
      child,
      `import {readParentProof} from ${JSON.stringify(inspectorUrl)};const value=readParentProof();process.stdout.write(JSON.stringify({keptChinese:value.commandLine.includes(process.argv[2]),directParent:value.pid===process.ppid}));`,
    )
    fs.writeFileSync(
      parent,
      `import {spawnSync} from 'node:child_process';const child=spawnSync(process.execPath,[${JSON.stringify(child)},process.argv[2]],{encoding:'utf8',windowsHide:true,env:{...process.env,NODE_OPTIONS:''}});if(child.status!==0)process.exit(1);process.stdout.write(child.stdout);`,
    )
    const result = execFileSync(process.execPath, [parent, "中文 用户目录 空格路径"], {
      encoding: "utf8",
      windowsHide: true,
      timeout: 15000,
      env: { ...process.env, NODE_OPTIONS: "" },
    })
    assert.deepEqual(JSON.parse(result), { keptChinese: true, directParent: true })
  },
)

async function ticketChild(context, accept) {
  const { root, launcher } = fixture(context)
  const script = path.join(root, "child.mjs")
  fs.writeFileSync(
    script,
    `
import {registerCurrentPm2Application} from ${JSON.stringify(autoUrl)};
try{const value=await registerCurrentPm2Application({root:${JSON.stringify(root)},launcherPath:${JSON.stringify(launcher)},shutdownTimeout:1000,startupTimeout:1000,requestRestart:false});process.stdout.write(JSON.stringify({type:'result',status:value.status,ticketRemoved:process.env.YUNZAI_GUARD_PM2_TICKET===undefined}));if(process.connected)process.disconnect()}catch(error){process.stdout.write(JSON.stringify({type:'failure',message:error.message}));if(process.connected)process.disconnect()}
`,
  )
  const child = spawn(process.execPath, [script], {
    windowsHide: true,
    stdio: ["ignore", "pipe", "pipe", "ipc"],
    env: {
      ...process.env,
      NODE_OPTIONS: "",
      pm_id: "0",
      PM2_HOME: root,
      YUNZAI_GUARD_PM2_TICKET: "a".repeat(64),
    },
  })
  let stderr = "",
    stdout = ""
  child.stdout.on("data", chunk => {
    stdout += chunk
  })
  child.stderr.on("data", chunk => {
    stderr += chunk
  })
  child.on("message", message => {
    if (message.type === "yunzai-guard-pm2-check") {
      child.send(
        {
          type: "yunzai-guard-pm2-registered",
          nonce: accept ? message.nonce : "b".repeat(64),
          pid: child.pid,
          pmId: 0,
          daemonPid: process.pid,
          launcherPath: launcher,
        },
        () => {
          if (!accept)
            child.send({
              type: "yunzai-guard-pm2-registered",
              nonce: message.nonce,
              pid: child.pid + 1,
              pmId: 0,
              daemonPid: process.pid,
              launcherPath: launcher,
            })
        },
      )
    }
  })
  const [code] = await once(child, "close")
  assert.equal(code, 0, stderr)
  return JSON.parse(stdout)
}

test("each registered PM2 generation authenticates over its existing IPC and removes its ticket", async context => {
  const result = await ticketChild(context, true)
  assert.deepEqual(result, { type: "result", status: "registered", ticketRemoved: true })
})

test("a mismatched generation ticket cannot fall back to opening any Inspector", async context => {
  const result = await ticketChild(context, false)
  assert.equal(result.type, "failure")
  assert.match(result.message, /PM2 登记应答与本应用不符/)
})

async function inspectorCloseChild(context, valid) {
  const { root } = fixture(context)
  const script = path.join(root, "close-child.mjs")
  fs.writeFileSync(
    script,
    `import {closePm2InspectorOverIpc} from ${JSON.stringify(autoUrl)};try{await closePm2InspectorOverIpc({nonce:'a'.repeat(64),url:'ws://127.0.0.1:9229/test',pmId:0,daemonPid:process.ppid});process.stdout.write(JSON.stringify({closed:true}))}catch(error){process.stdout.write(JSON.stringify({error:error.message}))}if(process.connected)process.disconnect();`,
  )
  const child = spawn(process.execPath, [script], {
    windowsHide: true,
    stdio: ["ignore", "pipe", "pipe", "ipc"],
    env: { ...process.env, NODE_OPTIONS: "" },
  })
  let stdout = "",
    stderr = ""
  child.stdout.on("data", chunk => {
    stdout += chunk
  })
  child.stderr.on("data", chunk => {
    stderr += chunk
  })
  child.on("message", message => {
    assert.equal(message.type, "yunzai-guard-pm2-inspector-close")
    child.send({
      type: "yunzai-guard-pm2-inspector-closed",
      nonce: message.nonce,
      url: message.url,
      pmId: 0,
      pid: valid ? child.pid : child.pid + 1,
      daemonPid: process.pid,
    })
  })
  const [code] = await once(child, "close")
  assert.equal(code, 0, stderr)
  return JSON.parse(stdout)
}

test("temporary Inspector cleanup requires an authenticated ordinary IPC acknowledgement", async context => {
  assert.deepEqual(await inspectorCloseChild(context, true), { closed: true })
})

test("a cleanup acknowledgement for another process cannot authorize handoff", async context => {
  assert.match((await inspectorCloseChild(context, false)).error, /PM2 Inspector 清理确认身份不符/)
})

test("PM2 registration preserves the original failure when temporary Inspector cleanup also fails", context => {
  const { root, launcher } = fixture(context)
  const source = `
import assert from 'node:assert/strict';
import {registerHooks} from 'node:module';
const state=globalThis.guardRegistrationTest={failed:false,cleanupFailed:false,closes:0,releases:0,
  original:new Error('application identity mismatch'),cleanup:new Error('cleanup acknowledgement timeout')};
registerHooks({resolve(specifier,context,next){
  if(context.parentURL===${JSON.stringify(autoUrl)} && specifier==='./inspector.js')
    return {url:'guard-test:inspector',shortCircuit:true};
  if(context.parentURL===${JSON.stringify(autoUrl)} && specifier==='./attach-lock.js')
    return {url:'guard-test:lock',shortCircuit:true};
  return next(specifier,context);
},load(url,context,next){
  if(url==='guard-test:lock')return {format:'module',shortCircuit:true,source:
    'export async function acquirePm2AttachLock(){return async()=>{globalThis.guardRegistrationTest.releases++}}'};
  if(url==='guard-test:inspector')return {format:'module',shortCircuit:true,source:
    \`const state=globalThis.guardRegistrationTest;
      export const readParentProof=()=>({pid:process.ppid});
      export const assertParentProof=()=>{},assertParentUnchanged=()=>{};
      export const inspectorDeadline=()=>({remainingMs:()=>1000});
      export const ParentInspector={async connect(){let evaluations=0;return {
        opened:true,url:'ws://127.0.0.1:42222/own',wildcard:false,
        async identity(){return {pm2Root:'fixture'}},async verifyParent(){},
        async evaluate(){if(++evaluations===1)return;if(state.failed)throw state.original;
          return {status:'registered',pid:process.pid,pmId:0,daemonPid:process.ppid,
            launcherPath:process.argv[2],requiresHandoff:false}},
        async close(cleanup){assertCleanup(cleanup);state.closes++;if(state.cleanupFailed)throw state.cleanup}
      }}};
      function assertCleanup(value){if(typeof value!=='function')throw Error('Missing owned cleanup')}
    \`};
  return next(url,context);
}});
Object.defineProperty(process,'connected',{value:true});process.send=()=>true;
process.env.pm_id='0';delete process.env.YUNZAI_GUARD_PM2_TICKET;
const {registerCurrentPm2Application}=await import(${JSON.stringify(autoUrl)});
for(const [failed,cleanupFailed] of [[true,true],[true,false],[false,true],[false,false]]){
  Object.assign(state,{failed,cleanupFailed});
  try{
    const result=await registerCurrentPm2Application({root:process.argv[1],launcherPath:process.argv[2],
      startupTimeout:1000,shutdownTimeout:1000,requestRestart:false});
    assert.equal(failed||cleanupFailed,false);assert.equal(result.status,'registered');
  }catch(error){
    assert.ok(failed||cleanupFailed);
    if(failed&&cleanupFailed){assert.ok(error instanceof AggregateError);assert.deepEqual(error.errors,[state.original,state.cleanup])}
    else assert.equal(error,failed?state.original:state.cleanup);
  }
}
assert.equal(state.closes,4);assert.equal(state.releases,4);
process.stdout.write('registration and cleanup errors retained');
`
  assert.equal(
    execFileSync(process.execPath, ["--input-type=module", "-e", source, root, launcher], {
      encoding: "utf8",
      windowsHide: true,
      timeout: 10000,
      env: { ...process.env, NODE_OPTIONS: "" },
    }),
    "registration and cleanup errors retained",
  )
})

test("cold PM2 receipt requires an explicit resource-barrier protocol attestation", t => {
  const { launcher } = fixture(t)
  const expected = {
    pid: 123,
    pmId: 4,
    daemonPid: 99,
    launcherPath: launcher,
    requestRestart: true,
  }
  const reply = {
    status: "registered",
    pid: 123,
    pmId: 4,
    daemonPid: 99,
    launcherPath: launcher,
    requiresHandoff: true,
  }
  assert.throws(() => assertPm2Registration(reply, expected), /PM2 登记应答与本应用不符/)
  assert.throws(
    () => assertPm2Registration({ ...reply, bootstrapExitBarrier: 2 }, expected),
    /PM2 登记应答与本应用不符/,
  )
  assert.doesNotThrow(() => assertPm2Registration({ ...reply, bootstrapExitBarrier: 1 }, expected))
})
