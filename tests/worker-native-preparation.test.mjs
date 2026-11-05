import assert from "node:assert/strict"
import { spawn } from "node:child_process"
import { once } from "node:events"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import test from "node:test"

const preload = new URL("../dist/worker-preload.js", import.meta.url).href
const windowsModule = new URL("../dist/sandbox/windows.js", import.meta.url).href

for (const enabled of [undefined, false, true])
  test(`worker prepares Windows native broker before script restrictions (enabled=${enabled})`, async () => {
    const temporaryRoot = fs.realpathSync(os.tmpdir())
    const directory = fs.mkdtempSync(path.join(temporaryRoot, "guard-worker-preparation-"))
    const main = path.join(directory, "main.mjs")
    // 代替修改真实 broker 缓存的 PowerShell：执行无副作用的 Node 脚本，并保留同样的进程私有缓存。
    const broker = `
      import {spawnSync} from "node:child_process";
      let cached, count=0, preparedAfterRuntime=false;
      export function compileWindowsSandbox() {
        if(cached) return cached;
        preparedAfterRuntime=Object.hasOwn(globalThis,Symbol.for("yunzai.guard.runtime.v1"));
        const result=spawnSync(process.execPath,["-p","'fixture-broker'"],{encoding:"utf8",windowsHide:true});
        if(result.status!==0) throw result.error ?? new Error(result.stderr);
        count++;
        return cached=result.stdout.trim();
      }
      export function preparationState(){return {count,preparedAfterRuntime};}
      export function spawnWindowsSandbox(){throw new Error("Unexpected real sandbox launch");}
    `
    fs.writeFileSync(
      main,
      `
        import assert from "node:assert/strict";
        import {registerHooks} from "node:module";
        import {execFileSync} from "node:child_process";
        registerHooks({load(url,context,next){return url===${JSON.stringify(windowsModule)}
          ? {format:"module",source:${JSON.stringify(broker)},shortCircuit:true}
          : next(url,context);}});
        await import(${JSON.stringify(preload)});
        const broker=await import(${JSON.stringify(windowsModule)});
        const prepared=${enabled === true} && process.platform==="win32";
        assert.equal(broker.preparationState().count,prepared?1:0);
        assert.equal(broker.compileWindowsSandbox(),"fixture-broker");
        assert.equal(execFileSync(process.execPath,["-p","'business-script'"],{encoding:"utf8"}).trim(),"business-script");
        assert.equal(execFileSync(process.execPath,["--version"],{encoding:"utf8",windowsHide:true}).trim(),process.version);
        process.send({type:"preparation-result",...broker.preparationState()},()=>process.exit(0));
      `,
    )
    const child = spawn(process.execPath, [main], {
      cwd: directory,
      env: { ...process.env, NODE_OPTIONS: "" },
      stdio: ["ignore", "ignore", "pipe", "ipc"],
      windowsHide: true,
    })
    const watchdog = setTimeout(() => child.kill("SIGKILL"), 15000)
    let result
    let stderr = ""
    child.stderr.on("data", chunk => {
      stderr += chunk
    })
    child.on("message", message => {
      if (message.type === "preload-hello")
        child.send({
          type: "worker-handshake",
          nonce: message.nonce,
          projectId: message.projectId,
          generation: 1,
          controlKey: "a".repeat(64),
          settings: {
            protect: { enabled: false },
            pluginSandbox: {
              native: { plugins: enabled === undefined ? [] : [{ id: "probe", enabled }] },
            },
          },
        })
      if (message.type === "preparation-result") result = message
    })
    try {
      const [code] = await once(child, "exit")
      assert.equal(code, 0, stderr)
      assert.ok(result, "worker reaches business code after installing runtime")
      assert.equal(result.count, 1)
      assert.equal(result.preparedAfterRuntime, !(enabled === true && process.platform === "win32"))
    } finally {
      clearTimeout(watchdog)
      if (child.exitCode === null && child.signalCode === null) {
        child.kill("SIGKILL")
        await once(child, "exit")
      }
      const absolute = fs.realpathSync(directory)
      assert.equal(path.dirname(absolute), temporaryRoot)
      assert.ok(path.basename(absolute).startsWith("guard-worker-preparation-"))
      fs.rmSync(absolute, { recursive: true, force: true })
    }
  })
