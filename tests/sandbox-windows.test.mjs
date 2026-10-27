import assert from "node:assert/strict"
import fs from "node:fs"
import path from "node:path"
import { test } from "node:test"
import { execFileSync } from "node:child_process"
import { fileURLToPath } from "node:url"
import { spawnWindowsSandbox } from "../dist/sandbox/windows.js"

const supported = process.platform === "win32"
const repository = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
const wait = async (predicate, timeout = 15000) => {
  const deadline = Date.now() + timeout
  while (Date.now() < deadline) {
    if (await predicate()) return
    await new Promise(r => setTimeout(r, 25))
  }
  throw new Error("Windows sandbox probe timed out")
}

test(
  "AppContainer enforces file/network restrictions for main, Worker, external process and contains detached child",
  {
    skip: !supported,
    timeout: 40000,
  },
  () => {
    execFileSync(process.execPath, [path.join(repository, "tests/windows-sandbox-probe.mjs")], {
      windowsHide: true,
      stdio: "pipe",
      timeout: 35000,
    })
  },
)

function fixture() {
  const directory = fs.mkdtempSync(path.join(repository, "tests/runs/windows-adapter-"))
  for (const name of ["data/yunzai-guard", "temp", "logs", "config/config"])
    fs.mkdirSync(path.join(directory, name), { recursive: true })
  return directory
}

function dacl(directory) {
  const encoded = Buffer.from(directory, "utf8").toString("base64")
  return execFileSync(
    "powershell.exe",
    [
      "-NoProfile",
      "-NonInteractive",
      "-Command",
      `$guardTarget=[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${encoded}')); [IO.Directory]::GetAccessControl($guardTarget).GetSecurityDescriptorSddlForm([Security.AccessControl.AccessControlSections]::Access)`,
    ],
    { encoding: "utf8", windowsHide: true },
  ).trim()
}

test(
  "native adapter routes verified multi-client IPC and restores ACL/profile after normal or forced helper exit",
  {
    skip: !supported,
    timeout: 60000,
  },
  async () => {
    const directory = fixture()
    const program = path.join(directory, "probe.cjs")
    const runtimeCode = `
    const net=require('node:net'),{parentPort}=require('node:worker_threads');
    const socket=net.connect(process.env.YUNZAI_GUARD_PIPE);
    const role=parentPort?'thread':'external';
    socket.on('connect',()=>socket.write(JSON.stringify({type:'runtime-hello',role,pid:process.pid})+'\\n'));
    socket.once('data',()=>{socket.write(JSON.stringify({type:'runtime-ack',role,pid:process.pid})+'\\n');if(parentPort){socket.end();parentPort.postMessage('done')}else setInterval(()=>{},1000)});
  `
    fs.writeFileSync(
      program,
      `
    const net=require('node:net'),{spawn}=require('node:child_process'),{Worker}=require('node:worker_threads');
    const socket=net.connect(process.env.YUNZAI_GUARD_PIPE);
    socket.on('connect',()=>socket.write(JSON.stringify({type:'preload-hello',pid:process.pid})+'\\n'));
    socket.once('data',()=>{new Worker(${JSON.stringify(runtimeCode)},{eval:true});const child=spawn(process.execPath,['-e',${JSON.stringify(runtimeCode)}],{stdio:'ignore',detached:true,windowsHide:true});socket.write(JSON.stringify({type:'spawned',pid:child.pid})+'\\n')});
    setInterval(()=>{},1000);
  `,
    )
    const original = dacl(directory)
    for (const force of [false, true]) {
      // 即使环境已脱敏，AppContainer CreateProcess 仍需要此非敏感路径。
      const env = force
        ? Object.fromEntries(
            ["PATH", "SystemRoot", "WINDIR", "LANG", "TZ", "LOCALAPPDATA"].map(key => [
              key,
              process.env[key],
            ]),
          )
        : { ...process.env }
      const child = spawnWindowsSandbox(
        directory,
        { shutdownTimeout: 1000, sandbox: { network: "none" } },
        {
          executable: process.execPath,
          args: [program],
          env,
          forwardOutput: false,
        },
      )
      const runtime = [],
        closed = [],
        errors = []
      let externalPid, profile
      child.on("error", error => errors.push(error.message))
      child.on("sandbox-ready", frame => {
        profile = frame.profile
      })
      child.on("message", message => {
        if (message.type === "preload-hello") child.send({ type: "ack" })
        if (message.type === "spawned") externalPid = message.pid
      })
      child.on("runtime-message", peer => {
        runtime.push(peer)
        if (peer.message.type === "runtime-hello") child.runtimeSend(peer.clientId, { type: "ack" })
      })
      child.on("runtime-close", peer => closed.push(peer))
      try {
        await wait(
          () =>
            runtime.filter(peer => peer.message.type === "runtime-ack").length === 2 && externalPid,
        )
        await wait(() =>
          closed.some(
            peer => peer.pid === child.sandboxPid && peer.clientId !== child.sandboxClientId,
          ),
        )
        assert.equal(child.exitCode, null, "a Worker pipe close must not kill root")
        assert.ok(
          runtime.some(peer => peer.pid === child.sandboxPid),
          "same-PID Worker stays on runtime channel",
        )
        assert.ok(
          runtime.some(peer => peer.pid === externalPid),
          "external process PID verified by native broker",
        )
        assert.equal(errors.length, 0, errors.join("\n"))
        if (force) {
          child.kill("SIGKILL")
          await child.sandboxCleanup
        } else await child.sandboxDispose()
        assert.equal(fs.existsSync(child.sandboxSession), false)
        assert.equal(
          fs.existsSync(path.join(directory, "data/yunzai-guard/windows-sandbox-active.json")),
          false,
        )
        assert.equal(dacl(directory), original, "original project DACL restored")
        assert.equal(
          fs.existsSync(path.join(process.env.LOCALAPPDATA, "Packages", profile)),
          false,
          "temporary AppContainer profile removed",
        )
        const count = execFileSync(
          "powershell.exe",
          [
            "-NoProfile",
            "-NonInteractive",
            "-Command",
            `@(Get-CimInstance Win32_Process -Filter 'ProcessId=${externalPid}' -ErrorAction SilentlyContinue).Count`,
          ],
          { encoding: "utf8", windowsHide: true },
        )
        assert.equal(Number(count.trim()), 0, "detached descendant gone before cleanup completion")
      } finally {
        if (child.exitCode === null) await child.sandboxDispose().catch(() => child.kill("SIGKILL"))
      }
    }
  },
)

test(
  "Windows sandbox rejects writable hard-link aliases before changing ACLs",
  {
    skip: !supported,
    timeout: 20000,
  },
  async () => {
    const directory = fixture(),
      original = dacl(directory)
    const source = path.join(directory, "core.cjs")
    fs.writeFileSync(source, "setInterval(()=>{},1000)")
    fs.linkSync(source, path.join(directory, "data/alias.cjs"))
    const child = spawnWindowsSandbox(
      directory,
      { shutdownTimeout: 1000 },
      {
        executable: process.execPath,
        args: [source],
        env: { ...process.env },
        forwardOutput: false,
      },
    )
    const errors = []
    child.on("error", error => errors.push(error.message))
    await child.sandboxCleanup
    assert.ok(
      errors.some(message => message.includes("hard-linked")),
      errors.join("\n"),
    )
    assert.equal(
      child.sandboxPid,
      undefined,
      "no restricted worker created on unsafe writable tree",
    )
    assert.equal(dacl(directory), original)
  },
)
