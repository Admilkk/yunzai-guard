import assert from "node:assert/strict"
import fs from "node:fs"
import net from "node:net"
import os from "node:os"
import path from "node:path"
import { spawn } from "node:child_process"
import { randomUUID } from "node:crypto"
import test from "node:test"
import { buildLinuxSandbox, linuxSeccompFilter } from "../dist/sandbox/linux.js"

const kernelTests = process.platform === "linux" && process.env.GUARD_TEST_LINUX_SANDBOX === "1"
const kernelSkip = kernelTests ? false : "requires Linux, bubblewrap and GUARD_TEST_LINUX_SANDBOX=1"
const pause = ms => new Promise(resolve => setTimeout(resolve, ms))
async function until(predicate, message) {
  const deadline = Date.now() + 10000
  while (Date.now() < deadline) {
    if (predicate()) return
    await pause(20)
  }
  throw new Error(message)
}

test("Linux seccomp filter rejects unsupported ABIs instead of disabling filtering", () => {
  const program = linuxSeccompFilter("x64")
  assert.equal(program.length % 8, 0)
  assert.equal(program.readUInt32LE(12), 0xc000003e)
  assert.ok(linuxSeccompFilter("arm64").length > 0)
  assert.throws(() => linuxSeccompFilter("ia32"), /沙箱不支持此系统调用架构/)
})

test(
  "Linux userInfo resolves only the current identity and its account files remain read-only",
  { skip: kernelSkip },
  async () => {
    const probe = await fixture("none")
    try {
      const code = `const fs=require('node:fs'),os=require('node:os');const result={user:os.userInfo(),passwd:fs.readFileSync('/etc/passwd','utf8'),group:fs.readFileSync('/etc/group','utf8')};for(const file of ['/etc/passwd','/etc/group']){try{fs.writeFileSync(file,'bad');result[file]='allowed'}catch(e){result[file]=e.code}}process.send(result)`
      const run = probe.launch(code)
      await until(
        () => run.messages.length || run.child.exitCode !== null,
        "User lookup did not finish",
      )
      assert.equal(run.messages.length, 1, run.output())
      const actual = run.messages[0],
        current = os.userInfo()
      assert.deepEqual(
        [actual.user.uid, actual.user.gid, actual.user.username],
        [current.uid, current.gid, current.username],
      )
      assert.equal(actual.user.homedir, "/home")
      assert.equal(actual.passwd.split("\n").filter(Boolean).length, 1)
      assert.equal(actual.group.split("\n").filter(Boolean).length, 1)
      assert.equal(actual["/etc/passwd"], "EROFS")
      assert.equal(actual["/etc/group"], "EROFS")
    } finally {
      await probe.cleanup()
    }
  },
)

test(
  "Linux maps only a canonical external executable without exposing its parent directory",
  {
    skip: kernelSkip,
  },
  async () => {
    const probe = await fixture("none")
    try {
      const externalDirectory = path.join(probe.runtime, "external")
      fs.mkdirSync(externalDirectory)
      const executable = path.join(externalDirectory, "printf")
      fs.copyFileSync("/usr/bin/printf", executable)
      fs.chmodSync(executable, 0o700)
      fs.writeFileSync(
        path.join(externalDirectory, "host-private.txt"),
        "must-not-expose-directory",
      )
      const run = probe.launch("", executable, ["external-runtime-ok"])
      await until(() => run.child.exitCode !== null, "External executable did not exit")
      assert.equal(run.child.exitCode, 0, run.output())
      assert.equal(run.output(), "external-runtime-ok")
      const argv = run.spec.args
      assert.ok(
        argv.some(
          (value, index) =>
            value === "--ro-bind" &&
            argv[index + 1] === executable &&
            argv[index + 2] === executable,
        ),
      )
      assert.equal(
        argv.some((value, index) => value === "--ro-bind" && argv[index + 1] === externalDirectory),
        false,
      )
    } finally {
      await probe.cleanup()
    }
  },
)

async function fixture(network) {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "guard-linux-test-"))
  const root = path.join(base, "project")
  const state = path.join(root, "data/yunzai-guard")
  const runtime = path.join(base, "runtime")
  fs.mkdirSync(state, { recursive: true })
  fs.mkdirSync(runtime)
  fs.writeFileSync(path.join(root, "app.js"), "original-core")
  fs.writeFileSync(path.join(state, "control.json"), "host-only-test-secret")
  fs.writeFileSync(path.join(runtime, "manifest.json"), JSON.stringify({ testOnly: true }))
  const broker = net.createServer(socket => {
    socket.once("data", () => socket.end("broker-ok"))
  })
  await new Promise((resolve, reject) => {
    broker.once("error", reject)
    broker.listen(path.join(runtime, "broker.sock"), resolve)
  })
  const children = []
  function launch(code, executable = process.execPath, args = ["-e", code], grants = {}) {
    const spec = buildLinuxSandbox(
      root,
      {
        sandbox: {
          network,
          writablePaths: ["data", "temp", "logs", "config/config"],
          ...grants,
        },
      },
      {
        executable,
        args,
        env: process.env,
        runtimeManifest: path.join(runtime, "manifest.json"),
      },
    )
    const stdio = ["ignore", "pipe", "pipe", "ipc"]
    for (const extra of spec.extraStdio) stdio[extra.fd] = extra.source
    stdio[spec.statusFd] = "pipe"
    let child
    try {
      child = spawn(spec.executable, spec.args, {
        cwd: spec.cwd,
        env: spec.env,
        stdio,
        detached: true,
      })
      spec.observe(child)
    } finally {
      spec.dispose()
    }
    let output = ""
    child.stdout.on("data", data => {
      output += data
    })
    child.stderr.on("data", data => {
      output += data
    })
    const messages = []
    child.on("message", message => messages.push(message))
    children.push({ child, spec })
    return { child, spec, messages, output: () => output }
  }
  async function cleanup() {
    for (const { child, spec } of children) {
      if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL")
      await until(
        () => child.exitCode !== null || child.signalCode !== null,
        "Sandbox did not exit",
      )
      await spec.waitForExit(child)
    }
    await new Promise(resolve => broker.close(resolve))
    fs.rmSync(base, { recursive: true, force: true })
  }
  return { root, state, runtime, launch, cleanup }
}

test(
  "missing Linux sandbox dependencies reject before application execution",
  {
    skip: process.platform !== "linux",
  },
  () => {
    const base = fs.mkdtempSync(path.join(os.tmpdir(), "guard-no-bwrap-"))
    try {
      assert.throws(
        () =>
          buildLinuxSandbox(
            base,
            {
              sandbox: {
                network: "none",
                writablePaths: [],
                bwrapPath: path.join(base, "not-installed"),
              },
            },
            { executable: process.execPath, args: [], env: {}, runtimeManifest: "not-used" },
          ),
        /requires bubblewrap/,
      )
      assert.equal(fs.existsSync(path.join(base, "data")), false)
    } finally {
      fs.rmSync(base, { recursive: true, force: true })
    }
  },
)

test(
  "Linux exact file grants preserve original data paths and deny sibling changes",
  { skip: kernelSkip },
  async () => {
    const probe = await fixture("none")
    try {
      const directory = path.join(probe.root, "config")
      fs.mkdirSync(directory, { recursive: true })
      const target = path.join(directory, "business.yaml"),
        peer = path.join(directory, "peer.yaml")
      fs.writeFileSync(target, "before")
      fs.writeFileSync(peer, "peer-original")
      const code = `const fs=require("node:fs");const result={};fs.writeFileSync("config/business.yaml","after");for(const file of ["config/peer.yaml","config/new.yaml"]){try{fs.writeFileSync(file,"bad");result[file]="allowed"}catch(e){result[file]=e.code}}process.send(result);setInterval(()=>{},1000)`
      const run = probe.launch(code, process.execPath, ["-e", code], {
        writablePaths: [],
        writableFiles: ["config/business.yaml"],
      })
      await until(
        () => run.messages.length || run.child.exitCode !== null,
        "File grant probe did not respond",
      )
      assert.ok(run.messages.length, run.output())
      assert.equal(run.messages[0]["config/peer.yaml"], "EROFS")
      assert.equal(run.messages[0]["config/new.yaml"], "EROFS")
      assert.equal(fs.readFileSync(target, "utf8"), "after")
      assert.equal(fs.readFileSync(peer, "utf8"), "peer-original")
      run.child.kill("SIGKILL")
      await run.spec.waitForExit(run.child)
      // 移除 Guard 无需导出；更新后的业务文件仍位于原路径，原插件可直接使用。
      fs.appendFileSync(target, "-ordinary")
      assert.equal(fs.readFileSync(target, "utf8"), "after-ordinary")
      assert.throws(
        () =>
          probe.launch("", process.execPath, ["-e", ""], {
            writablePaths: [],
            writableFiles: ["config/missing.yaml"],
          }),
        /ENOENT/,
      )
      fs.linkSync(peer, path.join(directory, "hardlink.yaml"))
      assert.throws(
        () =>
          probe.launch("", process.execPath, ["-e", ""], {
            writablePaths: [],
            writableFiles: ["config/hardlink.yaml"],
          }),
        /非链接普通文件/,
      )
      fs.mkdirSync(path.join(directory, "default_config"), { recursive: true })
      fs.writeFileSync(path.join(directory, "default_config/future.yaml"), "core-default")
      for (const file of [
        "app.js",
        "lib/core.js",
        "config/bot.yaml",
        "config/config/redis.yaml",
        "config/future.yaml",
        "data/yunzai-guard/control.json",
      ])
        assert.throws(
          () =>
            probe.launch("", process.execPath, ["-e", ""], {
              writablePaths: [],
              writableFiles: [file],
            }),
          /explicit|protected|Guard/,
        )
    } finally {
      await probe.cleanup()
    }
  },
)

test(
  "Linux namespace sandbox preserves FD3 and broker, hides host state, blocks core writes and further namespaces",
  {
    skip: kernelSkip,
  },
  async () => {
    const probe = await fixture("none")
    try {
      const code = `
      const fs=require("node:fs"),cp=require("node:child_process"),net=require("node:net");
      const result={pid:process.pid,ipc:typeof process.send,
        hidden:!fs.existsSync(${JSON.stringify(path.join(probe.state, "control.json"))}),
        manifest:JSON.parse(fs.readFileSync(${JSON.stringify(path.join(probe.runtime, "manifest.json"))},"utf8")),
        flags:fs.readFileSync("/proc/self/status","utf8")};
      try{fs.writeFileSync(${JSON.stringify(path.join(probe.root, "app.js"))},"bad");result.coreWrite="allowed"}catch(e){result.coreWrite=e.code}
      try{fs.writeFileSync(${JSON.stringify(path.join(probe.runtime, "manifest.json"))},"bad");result.manifestWrite="allowed"}catch(e){result.manifestWrite=e.code}
      try{fs.linkSync(${JSON.stringify(path.join(probe.root, "app.js"))},${JSON.stringify(path.join(probe.root, "data/core-alias.js"))});result.newHardlink="allowed"}catch(e){result.newHardlink=e.code}
      fs.writeFileSync(${JSON.stringify(path.join(probe.root, "data/allowed.txt"))},"ok");
      const unshare=cp.spawnSync("/usr/bin/unshare",["-Ur","/bin/true"],{encoding:"utf8"});
      result.unshareStatus=unshare.status;result.unshareError=unshare.stderr;
      const worker=new (require("node:worker_threads").Worker)('require("node:worker_threads").parentPort.postMessage("worker-ok")',{eval:true});
      worker.on("message",message=>{result.worker=message;
        const socket=net.createConnection(${JSON.stringify(path.join(probe.runtime, "broker.sock"))});
        socket.on("connect",()=>socket.write("hello"));
        socket.on("data",data=>{result.broker=data.toString();process.send(result)});
      });
      process.on("message",message=>{if(message==="ping")process.send({pong:true})});
      setInterval(()=>{},1000);
    `
      const run = probe.launch(code)
      await until(
        () => run.messages.length > 0 || run.child.exitCode !== null,
        "No sandbox IPC response",
      )
      assert.ok(run.messages.length, run.output())
      const first = run.messages[0]
      assert.equal(first.ipc, "function")
      assert.notEqual(first.pid, run.child.pid)
      assert.equal(first.hidden, true)
      assert.deepEqual(first.manifest, { testOnly: true })
      assert.equal(first.coreWrite, "EROFS")
      assert.equal(first.manifestWrite, "EROFS")
      assert.equal(first.newHardlink, "EXDEV")
      assert.equal(first.broker, "broker-ok")
      assert.equal(first.worker, "worker-ok")
      assert.match(first.flags, /^NoNewPrivs:\s+1$/m)
      assert.match(first.flags, /^CapEff:\s+0+$/m)
      assert.match(first.flags, /^Seccomp:\s+2$/m)
      assert.notEqual(first.unshareStatus, 0)
      assert.match(first.unshareError, /[Pp]ermitted|[Pp]ermission/)
      assert.equal(fs.readFileSync(path.join(probe.root, "app.js"), "utf8"), "original-core")
      assert.equal(
        fs.readFileSync(path.join(probe.state, "control.json"), "utf8"),
        "host-only-test-secret",
      )
      assert.equal(fs.readFileSync(path.join(probe.root, "data/allowed.txt"), "utf8"), "ok")
      run.child.send("ping")
      await until(() => run.messages.some(message => message.pong), "IPC reply did not cross FD3")
    } finally {
      await probe.cleanup()
    }
  },
)

test(
  "Linux network none blocks an external child executable, host mode explicitly permits loopback",
  {
    skip: kernelSkip,
  },
  async () => {
    let connections = 0
    const receiver = net.createServer(socket => {
      connections++
      socket.end("ok")
    })
    await new Promise(resolve => receiver.listen(0, "127.0.0.1", resolve))
    const port = receiver.address().port
    try {
      for (const network of ["none", "host"]) {
        const probe = await fixture(network)
        try {
          const nativeChild = `const net=require("node:net");const s=net.connect(${port},"127.0.0.1");s.setTimeout(500);s.on("connect",()=>{console.log("connected");s.end()});s.on("error",e=>{console.log(e.code)});s.on("timeout",()=>s.destroy())`
          const code = `const cp=require("node:child_process");const r=cp.spawnSync(process.execPath,["-e",${JSON.stringify(nativeChild)}],{encoding:"utf8"});process.send({status:r.status,output:r.stdout,error:r.stderr});setInterval(()=>{},1000)`
          const run = probe.launch(code)
          await until(
            () => run.messages.length || run.child.exitCode !== null,
            "Network sandbox produced no result",
          )
          assert.ok(run.messages.length, run.output())
          assert.equal(run.messages[0].status, 0)
          if (network === "none") {
            assert.equal(connections, 0)
            assert.doesNotMatch(run.messages[0].output, /connected/)
          } else {
            assert.match(run.messages[0].output, /connected/)
            assert.equal(connections, 1)
          }
        } finally {
          await probe.cleanup()
        }
      }
    } finally {
      await new Promise(resolve => receiver.close(resolve))
    }
  },
)

test(
  "Linux PID namespace tears down descendants after setsid even when the sandbox launcher is killed",
  {
    skip: kernelSkip,
  },
  async () => {
    const probe = await fixture("none")
    const marker = `guard-detached-${randomUUID()}`
    const matches = () =>
      fs
        .readdirSync("/proc")
        .filter(value => /^\d+$/.test(value))
        .filter(pid => {
          try {
            return fs.readFileSync(`/proc/${pid}/cmdline`, "utf8").startsWith(marker)
          } catch {
            return false
          }
        })
    try {
      const escapedCode = `process.title=${JSON.stringify(marker)};setInterval(()=>{},1000)`
      const code = `const cp=require("node:child_process");const child=cp.spawn(process.execPath,["-e",${JSON.stringify(escapedCode)}],{detached:true,stdio:"ignore"});child.unref();process.send({spawned:true});setInterval(()=>{},1000)`
      const run = probe.launch(code)
      await until(
        () => run.messages.length || run.child.exitCode !== null,
        "Sandbox did not spawn descendant",
      )
      assert.ok(run.messages.length, run.output())
      await until(() => matches().length === 1, "Detached child never started")
      run.child.kill("SIGKILL")
      await run.spec.waitForExit(run.child)
      assert.equal(
        matches().length,
        0,
        "Cleanup confirmation preceded detached descendant teardown",
      )
    } finally {
      await probe.cleanup()
    }
  },
)

test(
  "Linux refuses writable symlink directories and hard-link aliases of protected host state or core",
  {
    skip: kernelSkip,
  },
  async () => {
    const probe = await fixture("none")
    const launch = {
      executable: process.execPath,
      args: ["-e", "process.exit(99)"],
      env: process.env,
      runtimeManifest: path.join(probe.runtime, "manifest.json"),
    }
    try {
      const outside = path.join(probe.runtime, "outside")
      fs.mkdirSync(outside)
      fs.symlinkSync(outside, path.join(probe.root, "temp"))
      assert.throws(
        () =>
          buildLinuxSandbox(
            probe.root,
            {
              sandbox: { network: "none", writablePaths: ["temp/nested"] },
            },
            launch,
          ),
        /不能经过符号链接/,
      )
      assert.deepEqual(fs.readdirSync(outside), [])
      fs.linkSync(
        path.join(probe.state, "control.json"),
        path.join(probe.root, "data/aliased-control.json"),
      )
      assert.throws(
        () =>
          buildLinuxSandbox(
            probe.root,
            {
              sandbox: { network: "none", writablePaths: ["data"] },
            },
            launch,
          ),
        /硬链接文件/,
      )
      fs.unlinkSync(path.join(probe.root, "data/aliased-control.json"))
      fs.linkSync(path.join(probe.root, "app.js"), path.join(probe.root, "data/aliased-core.js"))
      assert.throws(
        () =>
          buildLinuxSandbox(
            probe.root,
            {
              sandbox: { network: "none", writablePaths: ["data"] },
            },
            launch,
          ),
        /沙箱可写目录含硬链接文件/,
      )
    } finally {
      await probe.cleanup()
    }
  },
)
