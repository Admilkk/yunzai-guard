import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import net from "node:net"
import assert from "node:assert/strict"
import test from "node:test"
import { execFile } from "node:child_process"
import { promisify } from "node:util"
import { fileURLToPath } from "node:url"

test("invalid future settings do not disable management of the live host", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "yunzai-guard-control-"))
  const state = path.join(root, "data", "yunzai-guard")
  fs.mkdirSync(state, { recursive: true })
  fs.writeFileSync(path.join(state, "settings.json"), "{invalid-json")
  const server = net.createServer(socket => {
    socket.once("data", data => {
      assert.equal(JSON.parse(data).token, "test-only-token")
      socket.end(JSON.stringify({ phase: "online", hostPid: process.pid }) + "\n")
    })
  })
  try {
    await new Promise(resolve => server.listen(0, "127.0.0.1", resolve))
    fs.writeFileSync(
      path.join(state, "control.json"),
      JSON.stringify({ port: server.address().port, token: "test-only-token" }),
    )
    const cli = fileURLToPath(new URL("../dist/cli.js", import.meta.url))
    const { stdout } = await promisify(execFile)(process.execPath, [cli, "status"], {
      cwd: root,
      timeout: 5000,
    })
    assert.equal(JSON.parse(stdout).phase, "online")
  } finally {
    await new Promise(resolve => server.close(resolve))
    assert.equal(path.dirname(root), fs.realpathSync(os.tmpdir()))
    assert.ok(path.basename(root).startsWith("yunzai-guard-control-"))
    fs.rmSync(root, { recursive: true, force: true })
  }
})
