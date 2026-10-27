import path from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"

export function auditModule(name) {
  const directory =
    process.env.GUARD_TEST_AUDIT_BUILD ?? fileURLToPath(new URL("../dist", import.meta.url))
  return import(pathToFileURL(path.join(directory, `${name}.js`)).href)
}
export function memoryIO() {
  const files = new Map()
  return {
    files,
    exists: name => files.has(name),
    size: name => Buffer.byteLength(files.get(name) ?? ""),
    rename(from, to) {
      files.set(to, files.get(from))
      files.delete(from)
    },
    truncate(name) {
      files.set(name, "")
    },
    append(name, text) {
      files.set(name, (files.get(name) ?? "") + text)
    },
  }
}
export function clock() {
  let now = 0
  let serial = 0
  const jobs = new Map()
  return {
    now: () => now,
    setTimer(callback, delay) {
      const id = ++serial
      jobs.set(id, { callback, time: now + delay })
      return id
    },
    clearTimer: id => jobs.delete(id),
    advance(ms) {
      now += ms
      let limit = 20000
      while (limit--) {
        const next = [...jobs]
          .filter(([, job]) => job.time <= now)
          .sort((a, b) => a[1].time - b[1].time)[0]
        if (!next) return
        jobs.delete(next[0])
        next[1].callback()
      }
      throw new Error("Audit clock did not quiesce")
    },
    jobs: () => jobs.size,
  }
}
export const channelNonce = "a".repeat(48)
export const closeNonce = "b".repeat(48)
export const event = (action = "audit", target = "target") => ({
  kind: "process",
  operation: "exec",
  target,
  action,
})
