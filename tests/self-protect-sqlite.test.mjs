import assert from "node:assert/strict"
import { execFileSync } from "node:child_process"
import { mkdtempSync, mkdirSync, rmSync } from "node:fs"
import os from "node:os"
import path from "node:path"
import test from "node:test"

const moduleUrl = new URL("../dist/protect/sqlite.js", import.meta.url).href
const databaseUrl = new URL("../dist/audit/database.js", import.meta.url).href
const storeUrl = new URL("../dist/audit/store.js", import.meta.url).href

function probe(legacy) {
  const root = mkdtempSync(path.join(os.tmpdir(), "guard-sqlite-"))
  for (const folder of ["guard", "state", "business"]) mkdirSync(path.join(root, folder))
  try {
    const output = execFileSync(
      process.execPath,
      [
        "--input-type=module",
        "-e",
        `
          import assert from "node:assert/strict"
          import sqlite from "node:sqlite"
          import fs from "node:fs"
          import path from "node:path"
          import { pathToFileURL } from "node:url"
          const root = ${JSON.stringify(root)}
          const protectedRoot = path.join(root, "guard")
          const stateRoot = path.join(root, "state")
          const business = path.join(root, "business")
          const guarded = path.join(protectedRoot, "database.sqlite")
          const secret = path.join(stateRoot, "secret.sqlite")
          const quote = value => "'" + value.replaceAll("'", "''") + "'"
          for (const filename of [guarded, secret]) {
            const original = new sqlite.DatabaseSync(filename)
            original.exec("CREATE TABLE data (value TEXT); INSERT INTO data VALUES ('unchanged')")
            original.close()
          }
          if (${legacy}) delete sqlite.DatabaseSync.prototype.setAuthorizer
          const { installSqliteGuard } = await import(${JSON.stringify(moduleUrl)})
          const { openAuditDatabase } = await import(${JSON.stringify(databaseUrl)})
          const { SqliteAuditSink } = await import(${JSON.stringify(storeUrl)})
          const coverage = []
          installSqliteGuard({
            roots: [protectedRoot, stateRoot],
            readRoots: [stateRoot],
            emit: event => coverage.push(event),
            deny: (operation, target) => {
              throw Object.assign(new Error(operation + ": " + target), { code: "GUARD_DENIED" })
            },
            seal: (object, key, value) => Object.defineProperty(object, key, {
              value, writable: false, configurable: false,
            }),
          })
          let leaked = false
          assert.throws(() => installSqliteGuard({ roots: [], deny: () => {}, seal: () => { leaked = true } }), { code: "ERR_GUARD_SELF_PROTECTION" })
          assert.equal(leaked, false)
          for (const target of [guarded, Buffer.from(guarded), pathToFileURL(guarded), pathToFileURL(guarded).href])
            assert.throws(() => new sqlite.DatabaseSync(target), { code: "GUARD_DENIED" })
          assert.throws(() => new sqlite.DatabaseSync(secret, { readOnly: true }), { code: "GUARD_DENIED" })
          assert.throws(() => openAuditDatabase(secret, true), { code: "GUARD_DENIED" })
          assert.throws(() => new SqliteAuditSink({ filePath: guarded, maxBytes: 4096, maxFiles: 1 }), { code: "GUARD_DENIED" })
          let calls = 0
          const immutableOptions = { get readOnly() { return calls++ === 0 } }
          const readable = new sqlite.DatabaseSync(guarded, immutableOptions)
          assert.equal(readable.prepare("SELECT value FROM data").get().value, "unchanged")
          assert.throws(() => readable.exec("INSERT INTO data VALUES ('changed')"))
          readable.close()
          assert.equal(calls, 1)
          const db = new sqlite.DatabaseSync(path.join(business, "main.sqlite"), { open: false })
          const memoryFile = path.join(business, "uri-memory.sqlite")
          const memory = new sqlite.DatabaseSync(pathToFileURL(memoryFile).href + "?mode=memory&cache=shared")
          memory.exec("CREATE TABLE temporary(value)")
          memory.close()
          assert.equal(fs.existsSync(memoryFile), false)
          const sharedMemory = new sqlite.DatabaseSync("file::memory:?cache=shared")
          sharedMemory.exec("CREATE TABLE shared(value)")
          sharedMemory.close()
          db.open()
          db.exec("CREATE TABLE data(value TEXT); BEGIN")
          db.prepare("INSERT INTO data VALUES (?)").run("business")
          db.exec("COMMIT")
          assert.equal(db.prepare("SELECT value FROM data").get().value, "business")
          assert.throws(() => new db.constructor(guarded), { code: "GUARD_DENIED" })
          assert.throws(() => sqlite.backup(db, guarded), { code: "GUARD_DENIED" })
          assert.throws(() => sqlite.backup(db, path.join(business, "invalid.sqlite"), undefined), { code: "ERR_INVALID_ARG_TYPE" })
          await sqlite.backup(db, path.join(business, "backup.sqlite"))
          const backup = new sqlite.DatabaseSync(path.join(business, "backup.sqlite"))
          assert.equal(backup.prepare("SELECT value FROM data").get().value, "business")
          backup.close()
          if (!${legacy}) {
            const check = () => {
              for (const filename of [guarded, pathToFileURL(guarded).href])
                assert.throws(() => db.exec("ATTACH DATABASE " + quote(filename) + " AS bad"), { code: "GUARD_DENIED" })
              assert.throws(() => db.prepare("VACUUM INTO ?").run(path.join(protectedRoot, "vacuum.sqlite")), { code: "GUARD_DENIED" })
            }
            check()
            db.setAuthorizer(null)
            check()
            db.setAuthorizer(() => sqlite.constants.SQLITE_OK)
            check()
            db.setAuthorizer(action => action === sqlite.constants.SQLITE_SELECT ? sqlite.constants.SQLITE_DENY : sqlite.constants.SQLITE_OK)
            assert.throws(() => db.prepare("SELECT 1"))
            db.close()
            db.open()
            assert.equal(db.prepare("SELECT value FROM data").get().value, "business")
            check()
            db.exec("ATTACH DATABASE " + quote(path.join(business, "attached.sqlite")) + " AS ordinary")
            db.exec("CREATE TABLE ordinary.data(value); DETACH DATABASE ordinary")
            for (let i = 0; i < 2; i++) {
              db.prepare("ATTACH DATABASE ? AS dynamic").run(path.join(business, "dynamic.sqlite"))
              db.exec("DETACH DATABASE dynamic")
            }
            assert.equal(coverage.filter(event => event.target === "dynamic-attach").length, 1)
            assert.equal(coverage.some(event => event.target === "unavailable"), false)
          } else {
            assert.equal(coverage.filter(event => event.target === "unavailable").length, 1)
            db.prepare("ATTACH DATABASE ? AS dynamic").run(path.join(business, "dynamic.sqlite"))
            db.exec("DETACH DATABASE dynamic")
          }
          db.close()
          const original = new sqlite.DatabaseSync(guarded, { readOnly: true })
          assert.deepEqual(original.prepare("SELECT value FROM data").all().map(row => row.value), ["unchanged"])
          original.close()
          assert.equal(fs.existsSync(path.join(protectedRoot, "vacuum.sqlite")), false)
          console.log("ok")
        `,
      ],
      { encoding: "utf8" },
    )
    assert.match(output, /ok/)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
}

test("SQLite 自保护覆盖文件入口并保留业务查询、绑定、附库和备份", () => probe(false))
test("SQLite 缺少 authorizer 时保留业务功能并明确报告覆盖不足", () => probe(true))
