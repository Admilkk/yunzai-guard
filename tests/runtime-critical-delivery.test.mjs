import assert from "node:assert/strict"
import test from "node:test"
import { Worker, MessageChannel } from "node:worker_threads"
import { parseSettings } from "../dist/config/index.js"

test(
  "a naturally finishing Worker retains its violation port until the parent acknowledges delivery",
  { timeout: 10000 },
  async t => {
    const { port1, port2 } = new MessageChannel()
    const settings = parseSettings({
      protect: { enabled: false },
      rules: [{ id: "deny-exec", kind: "process", operation: "execFileSync", action: "restart" }],
    })
    const code = `
    const {workerData,parentPort,setEnvironmentData}=require('node:worker_threads');
    (async()=>{
      const {workerMetadataKey}=await import(${JSON.stringify(new URL("../dist/runtime/worker-monitor.js", import.meta.url).href)});
      setEnvironmentData(workerMetadataKey,{version:1,identity:{id:'delivery-test',kind:'thread',generation:1,pid:process.pid,originPlugin:'delivery-test',observability:'js-entrypoints'},settings:workerData.settings,port:workerData.port,auditChannelNonce:'${"a".repeat(48)}'});
      const {installInheritedRuntime}=await import(${JSON.stringify(new URL("../dist/runtime/index.js", import.meta.url).href)});
      installInheritedRuntime();
      let denied;try{require('node:child_process').execFileSync(process.execPath,['--version'])}catch(error){denied=error.code}
      parentPort.postMessage({denied,keptAlive:workerData.port.hasRef()});
    })().catch(error=>{throw error});`
    const worker = new Worker(code, {
      eval: true,
      execArgv: [],
      workerData: { port: port2, settings },
      transferList: [port2],
    })
    t.after(async () => {
      port1.close()
      await worker.terminate()
    })
    let didExit = false
    const exited = new Promise((resolve, reject) => {
      worker.once("exit", code => {
        didExit = true
        resolve(code)
      })
      worker.once("error", reject)
    })
    const business = new Promise(resolve => worker.once("message", resolve))
    const violation = new Promise(resolve =>
      port1.on("message", frame => {
        if (frame.type === "violation") resolve(frame)
        else if (frame.type === "audit")
          port1.postMessage({
            type: "audit-hop-ack",
            auditProtocol: 1,
            generation: 1,
            channelNonce: "a".repeat(48),
            auditSeq: frame.auditSeq,
            result: "received",
          })
      }),
    )
    const [result, frame] = await Promise.all([business, violation])
    assert.deepEqual(result, { denied: "GUARD_DENIED", keptAlive: true })
    assert.equal(frame.event.ruleId, "deny-exec")
    await new Promise(resolve => setTimeout(resolve, 100))
    assert.equal(
      didExit,
      false,
      "The application finished, but the violation has not been acknowledged",
    )
    port1.postMessage({
      type: "audit-hop-ack",
      auditProtocol: 1,
      generation: 1,
      channelNonce: "a".repeat(48),
      auditSeq: frame.auditSeq,
      result: "received",
    })
    assert.equal(await exited, 0)
  },
)
