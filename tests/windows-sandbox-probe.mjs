import assert from "node:assert/strict"
import fs from "node:fs"
import path from "node:path"
import net from "node:net"
import { spawn, execFileSync } from "node:child_process"
import { fileURLToPath } from "node:url"
import { windowsSandboxSourceNames } from "../dist/sandbox/windows.js"

if (process.platform !== "win32") {
  console.log("Windows AppContainer probe skipped on this platform")
  process.exit(0)
}
const repository = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
const runRoot = path.join(repository, "tests", "runs", `native-windows-${Date.now()}`)
const sandbox = path.join(runRoot, "sandbox")
const writable = path.join(sandbox, "writable")
fs.mkdirSync(writable, { recursive: true })
const marker = path.join(runRoot, "host-secret.txt")
fs.writeFileSync(marker, "host-owned-marker")
const exe = path.join(sandbox, "node.exe")
fs.copyFileSync(process.execPath, exe)
const helper = path.join(runRoot, "GuardSandbox.exe")
execFileSync(
  path.join(process.env.SystemRoot || "C:/Windows", "Microsoft.NET/Framework64/v4.0.30319/csc.exe"),
  [
    "/nologo",
    "/target:exe",
    "/reference:System.Web.Extensions.dll",
    `/out:${helper}`,
    ...windowsSandboxSourceNames.map(name => path.join(repository, "native/windows", name)),
  ],
  { windowsHide: true, stdio: "inherit" },
)
let accepted = 0
const server = net.createServer(socket => {
  accepted++
  socket.end()
})
await new Promise(resolve => server.listen(0, "127.0.0.1", resolve))
const tcpPort = server.address().port
await new Promise((resolve, reject) => {
  const socket = net.connect({ host: "127.0.0.1", port: tcpPort })
  socket.once("connect", () => {
    socket.destroy()
    resolve()
  })
  socket.once("error", reject)
})
const baselineAccepted = accepted
const operations = `
  import fs from 'node:fs'; import net from 'node:net';
  const marker=${JSON.stringify(marker)}, writable=${JSON.stringify(writable)};
  function denied(fn) { try { fn();return 'ALLOWED' } catch(error) {return error.code} }
  async function checks(name) {
    const read=denied(()=>fs.readFileSync(marker));
    const write=denied(()=>fs.writeFileSync(marker,'tamper'));
    const own=denied(()=>fs.writeFileSync(writable+'/'+name+'.txt','allowed'));
    const network=await new Promise(resolve=>{ const socket=net.connect({host:'127.0.0.1',port:${tcpPort}});const finish=value=>{socket.destroy();resolve(value)};socket.once('connect',()=>finish('ALLOWED'));socket.once('error',error=>finish(error.code));socket.setTimeout(2000,()=>finish('TIMEOUT')); });
    return {name,read,write,own,network,pid:process.pid};
  }
`
const childCode =
  operations +
  `fs.writeFileSync(writable+'/external-report.json',JSON.stringify(await checks('external')));setInterval(()=>{},1000);`
const workerCode =
  operations +
  `import {parentPort} from 'node:worker_threads';parentPort.postMessage(await checks('worker'));`
const script =
  operations +
  `
  import {spawn} from 'node:child_process'; import {Worker} from 'node:worker_threads';
  const channel=net.connect(process.env.YUNZAI_GUARD_PIPE);
  let receivedAck=false;
  channel.on('connect',()=>channel.write(JSON.stringify({type:'hello',pid:process.pid})+'\\n'));
  channel.on('data',chunk=>{if(chunk.toString().includes('probe-ack'))receivedAck=true});
  const own=await checks('main');
  const worker=await new Promise((resolve,reject)=>{const task=new Worker(${JSON.stringify(workerCode)},{eval:true,type:'module'});task.once('message',resolve);task.once('error',reject)});
  const external=spawn(process.execPath,['--input-type=module','-e',${JSON.stringify(childCode)}],{stdio:'ignore',detached:true,windowsHide:true});
  const deadline=Date.now()+8000;while(!fs.existsSync(writable+'/external-report.json')&&Date.now()<deadline)await new Promise(r=>setTimeout(r,20));
  const externalReport=JSON.parse(fs.readFileSync(writable+'/external-report.json','utf8'));
  while(!receivedAck&&Date.now()<deadline)await new Promise(r=>setTimeout(r,20));
  channel.write(JSON.stringify({type:'probe-report',own,worker,external:externalReport,externalPid:external.pid,receivedAck})+'\\n');
  setInterval(()=>{},1000);
`
const scriptPath = path.join(sandbox, "probe.mjs")
fs.writeFileSync(scriptPath, script)
const child = spawn(
  helper,
  [
    "--root",
    sandbox,
    "--journal",
    path.join(runRoot, "journal.json"),
    "--write",
    writable,
    "--",
    exe,
    "--preserve-symlinks",
    "--preserve-symlinks-main",
    scriptPath,
  ],
  {
    windowsHide: true,
    stdio: ["pipe", "pipe", "pipe"],
  },
)
const frames = []
let output = "",
  stderr = "",
  report
child.stderr.on("data", chunk => (stderr += chunk.toString()))
child.stdout.on("data", chunk => {
  output += chunk.toString()
  while (output.includes("\n")) {
    const index = output.indexOf("\n"),
      line = output.slice(0, index).trim()
    output = output.slice(index + 1)
    if (!line) continue
    const frame = JSON.parse(line)
    frames.push(frame)
    if (frame.type === "ipc" && frame.message?.type === "hello")
      child.stdin.write(JSON.stringify({ type: "ipc", message: { type: "probe-ack" } }) + "\n")
    if (frame.type === "ipc" && frame.message?.type === "probe-report") report = frame.message
  }
})
let failure
try {
  const deadline = Date.now() + 20000
  while (!report && child.exitCode === null && Date.now() < deadline)
    await new Promise(r => setTimeout(r, 30))
  assert.ok(report, JSON.stringify({ frames, stderr }, null, 2))
  assert.equal(report.receivedAck, true, "AppContainer named pipe broker roundtrip")
  for (const row of [report.own, report.worker, report.external]) {
    assert.notEqual(row.read, "ALLOWED", `${row.name} read host marker`)
    assert.notEqual(row.write, "ALLOWED", `${row.name} write host marker`)
    assert.equal(row.own, "ALLOWED", `${row.name} own writable directory`)
    assert.ok(
      ["EACCES", "EPERM", "ETIMEDOUT"].includes(row.network),
      `${row.name} network error: ${row.network}`,
    )
  }
  assert.equal(fs.readFileSync(marker, "utf8"), "host-owned-marker")
  assert.equal(
    accepted,
    baselineAccepted,
    "OS-isolated clients never reach otherwise reachable host server",
  )
  child.stdin.write('{"type":"stop"}\n')
  await new Promise(resolve => child.once("exit", resolve))
  // Job 未启用 breakaway 标志时，detached:true 也不能逃离它。
  const inventory = execFileSync(
    "powershell.exe",
    [
      "-NoProfile",
      "-NonInteractive",
      "-Command",
      `@(Get-CimInstance Win32_Process -Filter 'ProcessId=${report.externalPid}' -ErrorAction SilentlyContinue).Count`,
    ],
    { encoding: "utf8", windowsHide: true },
  )
  assert.equal(Number(inventory.trim()), 0, "Job closes detached external child")
  console.log(
    "PASS AppContainer: host files denied; private writable directory allowed; network denied; Worker and external process inherit restrictions; named pipe IPC roundtrip; Job kills detached descendant",
  )
} catch (error) {
  failure = error
  throw error
} finally {
  if (child.exitCode === null) {
    child.stdin.end()
    await new Promise(r => setTimeout(r, 1000))
    if (child.exitCode === null) child.kill()
  }
  server.close()
  fs.writeFileSync(
    path.join(runRoot, "report.json"),
    JSON.stringify({ frames, report, stderr, error: failure?.stack }, null, 2),
  )
  console.log(`Evidence: ${runRoot}`)
}
