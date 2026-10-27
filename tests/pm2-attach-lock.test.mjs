import test from "node:test"
import assert from "node:assert/strict"
import { fork } from "node:child_process"
import { once } from "node:events"
import { acquirePm2AttachLock } from "../dist/pm2/attach-lock.js"

test("initial attachments serialize and a killed owner releases its kernel lease", async () => {
  const parent = { pid: process.pid, created: String(Date.now()) }
  const module = new URL("../dist/pm2/attach-lock.js", import.meta.url).href
  const child = fork(new URL("../dist/pm2/attach-lock.js", import.meta.url), [], {
    execArgv: [
      "--input-type=module",
      "-e",
      `const {acquirePm2AttachLock}=await import(${JSON.stringify(module)});await acquirePm2AttachLock(${JSON.stringify(parent)});process.send('locked');`,
    ],
    stdio: ["ignore", "ignore", "pipe", "ipc"],
  })
  let release
  try {
    await Promise.race([
      once(child, "message"),
      once(child, "exit").then(() => {
        throw new Error("Lease owner failed")
      }),
    ])
    let acquired = false
    const next = acquirePm2AttachLock(parent).then(value => {
      acquired = true
      return value
    })
    await new Promise(resolve => setTimeout(resolve, 120))
    assert.equal(acquired, false)
    const exited = once(child, "exit")
    child.kill("SIGKILL")
    await exited
    release = await next
    assert.equal(acquired, true)
    await release()
    release = await acquirePm2AttachLock(parent)
  } finally {
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL")
    await release?.()
  }
})
