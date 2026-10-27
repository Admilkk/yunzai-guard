import fs from "node:fs"
import assert from "node:assert/strict"
import { spawn } from "node:child_process"
import { randomBytes, createHash } from "node:crypto"
const [helper, output] = process.argv.slice(2)
const hash = file => createHash("sha256").update(fs.readFileSync(file)).digest("hex")
const bootId = fs.readFileSync("/proc/sys/kernel/random/boot_id", "utf8").trim()
const ns = fs.statSync("/proc/self/ns/pid", { bigint: true })
const pidNamespace = `${ns.dev}:${ns.ino}`
const child = spawn(process.execPath, ["-e", "setInterval(()=>{},1000)"], { stdio: "ignore" })
const childExit = new Promise(resolve =>
  child.once("exit", (code, signal) => resolve({ code, signal })),
)
const stat = fs.readFileSync(`/proc/${child.pid}/stat`, "utf8")
const fields = stat
  .slice(stat.lastIndexOf(")") + 2)
  .trim()
  .split(/\s+/)
const birth = { pid: child.pid, parentPid: Number(fields[1]), startTicks: fields[19], pidNamespace }
assert.equal(birth.parentPid, process.pid)
async function run(records) {
  const request = {
    protocol: 1,
    nonce: randomBytes(24).toString("hex"),
    bootId,
    budgetMs: 15000,
    records,
  }
  const worker = spawn(helper, [], { stdio: ["pipe", "pipe", "pipe"] })
  const stdout = [],
    stderr = []
  worker.stdout.on("data", chunk => stdout.push(chunk))
  worker.stderr.on("data", chunk => stderr.push(chunk))
  const exited = new Promise((resolve, reject) => {
    worker.once("error", reject)
    worker.once("close", (code, signal) => resolve({ code, signal }))
  })
  worker.stdin.end(JSON.stringify(request) + "\n")
  const native = await exited
  assert.deepEqual(native, { code: 0, signal: null })
  assert.equal(Buffer.concat(stderr).length, 0)
  const reply = JSON.parse(Buffer.concat(stdout).toString("utf8"))
  assert.equal(reply.nonce, request.nonce)
  assert.equal(reply.scopeObservationComplete, false)
  return { request, native, reply }
}
try {
  const eligibility = await run([])
  assert.equal(eligibility.reply.nativeEligibility, "pidfd-self-open-send0-poll")
  assert.deepEqual(eligibility.reply.results, [])
  const mismatch = await run([
    { pid: birth.pid, startTicks: String(BigInt(birth.startTicks) + 1n), pidNamespace },
  ])
  assert.equal(mismatch.reply.results[0].result, "identity-mismatch-or-unknown")
  assert.equal(child.exitCode, null)
  assert.equal(child.signalCode, null)
  const same = fs.readFileSync(`/proc/${child.pid}/stat`, "utf8")
  assert.equal(
    same
      .slice(same.lastIndexOf(")") + 2)
      .trim()
      .split(/\s+/)[19],
    birth.startTicks,
  )
  const matched = await run([{ pid: birth.pid, startTicks: birth.startTicks, pidNamespace }])
  assert.equal(matched.reply.results[0].result, "terminated-and-exited")
  const targetNative = await childExit
  assert.deepEqual(targetNative, { code: null, signal: "SIGKILL" })
  const result = {
    schemaVersion: 1,
    helperSha256: hash(helper),
    nodeSha256: hash(process.execPath),
    uid: process.getuid(),
    birth,
    eligibility,
    mismatch,
    matched,
    targetNative,
    onlyFixedPidfdSigkill: true,
    scopeObservationComplete: false,
  }
  fs.writeFileSync(output, JSON.stringify(result, null, 2) + "\n", { flag: "wx" })
  console.log(JSON.stringify({ passed: true, targetNative, helperSha256: hash(helper) }))
} finally {
  if (child.exitCode === null && child.signalCode === null) {
    child.kill()
    await childExit
  }
}
