import fs from "node:fs"
import path from "node:path"
import sqlite from "node:sqlite"

export function readAuditRecords(stateDir) {
  const file = path.join(stateDir, "events.sqlite")
  if (fs.existsSync(file)) {
    const database = new sqlite.DatabaseSync(file, { readOnly: true, allowExtension: false })
    try {
      database.exec("PRAGMA busy_timeout=1000; PRAGMA query_only=ON")
      return database
        .prepare("SELECT payload FROM events ORDER BY id")
        .all()
        .map(row => JSON.parse(String(row.payload)))
    } finally {
      database.close()
    }
  }
  const legacy = path.join(stateDir, "events.jsonl")
  if (!fs.existsSync(legacy)) return []
  return fs
    .readFileSync(legacy, "utf8")
    .split("\n")
    .slice(0, -1)
    .filter(Boolean)
    .map(line => JSON.parse(line))
}
