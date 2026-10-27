import fs from "node:fs"
import path from "node:path"

const valid = row =>
  row &&
  Number.isSafeInteger(row.pid) &&
  row.pid > 1 &&
  typeof row.start === "string" &&
  /^\d+$/.test(row.start)

export const sameProcessIdentity = (left, right) =>
  valid(left) && valid(right) && left.pid === right.pid && left.start === right.start

/** 仅凭父 PID 不足以证明归属，旧孤儿可能指向后来复用的父 PID。 */
export function ownedProcessRows(rows, roots) {
  const live = new Map(rows.filter(valid).map(row => [row.pid, row]))
  const owned = new Map()
  for (const root of roots) {
    const current = live.get(root?.pid)
    if (sameProcessIdentity(current, root)) owned.set(current.pid, current)
  }
  let changed
  do {
    changed = false
    for (const row of live.values()) {
      const parent = owned.get(row.parent)
      if (!parent || owned.has(row.pid) || BigInt(row.start) < BigInt(parent.start)) continue
      owned.set(row.pid, row)
      changed = true
    }
  } while (changed)
  return rows.filter(row => sameProcessIdentity(row, owned.get(row.pid)))
}

/** 仅持久化测试证据，不授权终止 PID 或重放 ACL 日志。 */
export function writeProcessOwnershipSnapshot(filename, snapshot) {
  const rows = snapshot.observed
  if (
    !path.isAbsolute(snapshot.project) ||
    !valid(snapshot.owner) ||
    !Number.isSafeInteger(snapshot.owner.parent) ||
    snapshot.owner.parent < 0 ||
    !Array.isArray(rows) ||
    rows.length > 4096 ||
    rows.some(row => !valid(row) || !Number.isSafeInteger(row.parent) || row.parent < 0) ||
    new Set(rows.map(row => `${row.pid}:${row.start}`)).size !== rows.length ||
    (snapshot.remaining !== undefined &&
      (!Array.isArray(snapshot.remaining) ||
        snapshot.remaining.some(row => !rows.some(known => sameProcessIdentity(row, known))))) ||
    !["observing", "observed-processes-exited"].includes(snapshot.state) ||
    (snapshot.state === "observed-processes-exited" && snapshot.remaining?.length !== 0)
  )
    throw new TypeError("Invalid test process ownership snapshot")
  const identity = row => ({ pid: row.pid, parent: row.parent, start: row.start })
  const value = {
    schemaVersion: 1,
    project: snapshot.project,
    owner: identity(snapshot.owner),
    state: snapshot.state,
    observed: rows.map(identity),
    // 不复制进程记录中的命令、环境变量或令牌。
    ...(snapshot.remaining ? { remaining: snapshot.remaining.map(identity) } : {}),
    boundaryCleanupConfirmed: snapshot.boundaryCleanupConfirmed === true,
    updatedAt: new Date().toISOString(),
  }
  const temporary = `${filename}.pending-${process.pid}`
  fs.writeFileSync(temporary, JSON.stringify(value, null, 2) + "\n", { mode: 0o600 })
  fs.renameSync(temporary, filename)
  return value
}
