import assert from "node:assert/strict"
import path from "node:path"
import { pathToFileURL } from "node:url"
import { spawn } from "node:child_process"
import { once } from "node:events"
import inspector from "node:inspector"

const role = process.argv[2]
if (role === "tree-root") {
  const child = spawn(
    process.execPath,
    ["-e", "setInterval(()=>{},1000)", "guard-own-grandchild"],
    {
      windowsHide: true,
      stdio: "ignore",
    },
  )
  let closing = false
  const close = async () => {
    if (closing) return
    closing = true
    if (child.exitCode !== null || child.signalCode !== null) process.exit(0)
    const exited = once(child, "exit")
    child.kill()
    await exited
    process.exit(0)
  }
  child.once("spawn", () => process.send({ type: "ready", grandchild: child.pid }))
  process.on("message", message => {
    if (message === "exit-with-child") {
      closing = true
      process.exit(0)
    } else void close()
  })
  process.once("disconnect", () => {
    if (!closing) void close()
  })
  setInterval(() => {}, 1000)
} else if (role === "inspector-app") {
  const { createNativeIdentityAdapter } = await import(
    pathToFileURL(path.join(process.argv[4], "native-process/index.js")).href
  )
  let session, socket
  try {
    session = await createNativeIdentityAdapter({
      bundleRoot: process.argv[3],
    }).openInspectorParent({ remainingBudgetMs: 15000 })
    assert.equal(session.parent.pid, process.ppid)
    assert.equal(session.activationAvailable, true)
    const activation = await session.activateOnce()
    assert.equal(activation.result, "native-action-completed")
    process.send({ type: "endpoint" })
    const [message] = await once(process, "message")
    socket = new WebSocket(message.url)
    await once(socket, "open")
    const confirmation = await session.confirmAfterWebSocket(1)
    assert.equal(confirmation.originalLive, true)
    await assert.rejects(
      session.confirmAfterWebSocket(1),
      error => error.code === "STATE_OR_REQUEST_INVALID",
    )
    await assert.rejects(
      session.activateOnce(),
      error => error.code === "ACTIVATION_ALREADY_ATTEMPTED",
    )
    const disconnected = once(socket, "close")
    socket.close()
    await disconnected
    await session.close()
    session = undefined
    process.send({
      type: "result",
      status: "passed",
      parent: confirmation.parent,
      activationProfile: activation.originalParent,
      confirmationSerial: confirmation.connectionSerial,
      duplicateActionRefused: true,
      duplicateConfirmationRefused: true,
    })
  } catch (error) {
    process.send({ type: "result", status: "failed", message: String(error) })
    process.exitCode = 1
  } finally {
    socket?.close()
    await session?.close().catch(() => {})
    process.disconnect()
  }
} else if (role === "inspector-daemon") {
  const child = spawn(
    process.execPath,
    [process.argv[1], "inspector-app", ...process.argv.slice(3)],
    {
      windowsHide: true,
      stdio: ["ignore", "inherit", "inherit", "ipc"],
    },
  )
  let finished = false
  process.once("disconnect", () => {
    if (!finished) {
      child.kill()
      inspector.close()
      process.exit(1)
    }
  })
  let result
  child.on("message", async message => {
    if (message.type === "endpoint") {
      for (let index = 0; index < 40 && !inspector.url(); index++)
        await new Promise(resolve => setTimeout(resolve, 25))
      child.send({ url: inspector.url() })
    } else if (message.type === "result") result = message
  })
  const [code, signal] = await once(child, "exit")
  finished = true
  inspector.close()
  process.send({ ...result, code, signal, inspectorClosed: !inspector.url() })
  process.exitCode = code || Number(signal !== null) || Number(result?.status !== "passed")
  process.disconnect()
} else throw new Error("Unknown own-process qualification role")
