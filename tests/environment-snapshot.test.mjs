import assert from "node:assert/strict"
import { fork } from "node:child_process"
import { fileURLToPath, pathToFileURL } from "node:url"
import path from "node:path"
import test from "node:test"

const self = fileURLToPath(import.meta.url)
const helper = process.argv[2]

function nativeExit(child) {
  return new Promise((resolve, reject) => {
    child.once("error", reject)
    child.once("exit", (code, signal) => resolve({ code, signal }))
  })
}

function message(child, type, timeout = 15000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => finish(new Error(`Self-authored ${type} IPC timed out`)),
      timeout,
    )
    const listener = value => {
      if (value?.type === type) finish(null, value)
    }
    const exit = (code, signal) =>
      finish(new Error(`Self-authored process exited before ${type}: ${code}/${signal}`))
    function finish(error, value) {
      clearTimeout(timer)
      child.off("message", listener)
      child.off("close", exit)
      if (error) reject(error)
      else resolve(value)
    }
    child.on("message", listener)
    // 原生退出和排队中的 IPC 相互独立；close 才表示子进程不能再送达已发送的消息。
    child.once("close", exit)
  })
}

function send(child, value) {
  return new Promise((resolve, reject) =>
    child.send(value, error => (error ? reject(error) : resolve())),
  )
}

if (helper === "--snapshot-leaf") {
  const timer = setTimeout(() => {
    process.exitCode = 1
    if (process.connected) process.disconnect()
  }, 20000)
  process.once("disconnect", () => clearTimeout(timer))
  process.on("message", value => {
    if (value?.type !== "stop") return
    clearTimeout(timer)
    if (process.connected) process.disconnect()
  })
  process.send({ type: "leaf-ready", pid: process.pid })
} else if (helper === "--snapshot-parent") {
  const leaf = fork(self, ["--snapshot-leaf"], {
    execArgv: [],
    stdio: ["ignore", "ignore", "ignore", "ipc"],
    windowsHide: true,
  })
  const exited = nativeExit(leaf)
  void exited.catch(() => {})
  let stopping = false
  let forced = false
  let force
  const stop = async reason => {
    if (stopping) return
    stopping = true
    clearTimeout(watchdog)
    force = setTimeout(() => {
      forced = true
      // 只操作本夹具创建的 ChildProcess 句柄，不使用从 CIM 或 /proc 选出的 PID。
      if (leaf.exitCode === null && leaf.signalCode === null) leaf.kill("SIGTERM")
    }, 5000)
    try {
      if (leaf.connected) await send(leaf, { type: "stop" })
      const exit = await exited
      clearTimeout(force)
      if (reason !== "requested" || forced || exit.code !== 0 || exit.signal !== null)
        process.exitCode = 1
      if (process.connected)
        process.send(
          { type: "parent-stopped", leafPid: leaf.pid, leafNativeExit: exit, forced, reason },
          () => process.disconnect(),
        )
    } catch {
      clearTimeout(force)
      process.exitCode = 1
      if (process.connected) process.disconnect()
    }
  }
  const watchdog = setTimeout(() => void stop("watchdog"), 20000)
  process.once("disconnect", () => void stop("parent-disconnected"))
  process.on("message", value => {
    if (value?.type === "stop") void stop("requested")
  })
  try {
    const ready = await message(leaf, "leaf-ready")
    assert.equal(ready.pid, leaf.pid)
    process.send({ type: "parent-ready", pid: process.pid, leafPid: leaf.pid })
  } catch {
    await stop("startup-failed")
  }
} else {
  const fixtureFile = process.env.GUARD_TEST_SNAPSHOT_FIXTURE
    ? pathToFileURL(path.resolve(process.env.GUARD_TEST_SNAPSHOT_FIXTURE)).href
    : new URL("./environment-fixture.mjs", import.meta.url).href
  const {
    processBirth,
    processIdentity,
    inspectBirthBoundScope,
    selectBirthBoundScope,
    snapshot,
    readLinuxProcessRow,
    readWindowsProcessRows,
  } = await import(fixtureFile)

  function procStat(
    pid,
    { parent = "1", start = "100", state = "S", comm = "probe (with space)" } = {},
  ) {
    const fields = Array(20).fill("0")
    fields[0] = state
    fields[1] = parent
    fields[19] = start
    return `${pid} (${comm}) ${fields.join(" ")}\n`
  }

  function unknownProcRow(value, pid) {
    assert.equal(value.pid, pid)
    assert.equal(value.parent, null)
    assert.equal(value.start, null)
    assert.equal(typeof value.error, "string")
    assert.ok(value.error.length > 0 && value.error.length <= 64)
    assert.equal(processBirth(value), null)
    assert.deepEqual(selectBirthBoundScope([value], pid), [])
  }

  function incompleteScope(rows, rootPid, unresolvedPid) {
    const result = inspectBirthBoundScope(rows, rootPid)
    assert.ok(Array.isArray(result.rows))
    assert.ok(Array.isArray(result.unresolved))
    assert.ok(result.unresolved.some(row => row.pid === unresolvedPid))
    for (const row of result.unresolved) {
      assert.equal(typeof row.reason, "string")
      assert.ok(row.reason.length > 0 && row.reason.length <= 128)
    }
    assert.throws(
      () => snapshot(rootPid, rows),
      error => {
        assert.equal(error.code, "GUARD_FIXTURE_SCOPE_UNKNOWN")
        assert.ok(error.scopeDiagnostics)
        return true
      },
    )
    return result
  }

  test("birth-bound selection excludes the captured reused-parent CIM branch before any old-row admission", context => {
    // 保留的 CIM 元数据来自 tests/runs/windows-pm2-cached-r28-firstcase-diagnosis-20261025/report.final.json 的 realCimObservation.rows；历史 PID 仅作测试数据。
    const rows = [
      { pid: 58464, parent: 32868, start: "20261024160356780" },
      { pid: 15228, parent: 58464, start: "20261024160507301" },
      { pid: 49564, parent: 15228, start: "20261024160507416" },
      { pid: 1228, parent: 49564, start: "20261024113013592" },
      { pid: 1244, parent: 1228, start: "20261022000742768" },
    ]
    const original = structuredClone(rows)
    const selected = selectBirthBoundScope(rows, 15228)
    assert.deepEqual(
      selected.map(row => row.pid),
      [15228, 49564],
    )
    const oldSentinels = new Set([1228, 1244])
    let nativeHandleCallback = 0
    const ledger = []
    for (const row of selected)
      if (oldSentinels.has(row.pid)) {
        nativeHandleCallback++
        ledger.push(row)
      }
    assert.equal(nativeHandleCallback, 0)
    assert.deepEqual(ledger, [])
    assert.deepEqual(rows, original)
    assert.notEqual(selected, rows)
    assert.equal(selected[0], rows[1])
    assert.equal(selected[1], rows[2])
    context.diagnostic(
      JSON.stringify({
        selectedPids: selected.map(row => row.pid),
        historicalProtectedPids: [...oldSentinels],
        oldRowNativeHandleCallback: nativeHandleCallback,
        oldRowLedgerEntries: ledger.length,
        historicalRowsAreDataOnly: true,
      }),
    )
  })

  test("birth-bound selection rejects missing unknown malformed or conflicting roots without admission", () => {
    const root = { pid: 10, parent: 0, start: "50" }
    for (const rows of [
      [],
      [{ ...root, start: null }],
      [{ ...root, start: "unknown" }],
      [{ ...root, start: "0" }],
      [{ ...root, parent: -1 }],
      [root, { ...root, start: "51" }],
    ])
      assert.deepEqual(selectBirthBoundScope(rows, 10), [])
    assert.deepEqual(selectBirthBoundScope([root], 11), [])
    assert.deepEqual(selectBirthBoundScope([root], 0), [])
    assert.deepEqual(selectBirthBoundScope([root], Number.NaN), [])
  })

  test("unknown or child-before-parent birth prunes its whole branch while preserving an independent valid branch", () => {
    const rows = [
      { pid: 1, parent: 0, start: "100" },
      { pid: 2, parent: 1, start: "99" },
      { pid: 3, parent: 2, start: "101" },
      { pid: 4, parent: 1, start: "unknown" },
      { pid: 5, parent: 4, start: "102" },
      { pid: 6, parent: 1, start: "100" },
      { pid: 7, parent: 6, start: "100" },
      { pid: 8, parent: 6, start: "99" },
      { pid: 9, parent: 8, start: "103" },
    ]
    assert.deepEqual(
      selectBirthBoundScope(rows, 1).map(row => row.pid),
      [1, 6, 7],
    )
  })

  test("BigInt birth ordering does not round adjacent values beyond Number safe precision", () => {
    const rows = [
      { pid: 10, parent: 0, start: "9007199254740993" },
      { pid: 11, parent: 10, start: "9007199254740992" },
      { pid: 12, parent: 10, start: "9007199254740993" },
      { pid: 13, parent: 12, start: "9007199254740994" },
      { pid: 14, parent: 13, start: "9007199254740993" },
    ]
    assert.equal(processBirth(rows[0]), 9007199254740993n)
    assert.deepEqual(
      selectBirthBoundScope(rows, 10).map(row => row.pid),
      [10, 12, 13],
    )
  })

  test("equal coarse births are valid and a frozen input keeps its row references and order", () => {
    const rows = Object.freeze([
      Object.freeze({ pid: 21, parent: 20, start: "20261024160507416" }),
      Object.freeze({ pid: 20, parent: 0, start: "20261024160507416" }),
      Object.freeze({ pid: 22, parent: 21, start: "20261024160507416" }),
    ])
    const selected = selectBirthBoundScope(rows, 20)
    assert.notEqual(selected, rows)
    assert.deepEqual(selected, rows)
    for (let i = 0; i < rows.length; i++) assert.equal(selected[i], rows[i])
  })

  test("a root-parent cycle cannot provide a trusted scope", () => {
    assert.deepEqual(
      selectBirthBoundScope(
        [
          { pid: 30, parent: 31, start: "100" },
          { pid: 31, parent: 30, start: "100" },
        ],
        30,
      ),
      [],
    )
    assert.deepEqual(selectBirthBoundScope([{ pid: 30, parent: 30, start: "100" }], 30), [])
  })

  test("processBirth accepts only positive decimal string births", () => {
    assert.equal(processBirth({ start: "00042" }), 42n)
    for (const start of [
      undefined,
      null,
      0,
      42,
      42n,
      "",
      "0",
      "000",
      "-1",
      "+1",
      "1.2",
      " 1",
      "1 ",
      "NaN",
    ])
      assert.equal(processBirth({ start }), null)
    assert.equal(processBirth(undefined), null)
  })

  test("injected Linux stat parsing preserves exact PID parent and BigInt birth without reading the machine", () => {
    let calls = 0
    const row = readLinuxProcessRow(101, file => {
      calls++
      assert.equal(file, "/proc/101/stat")
      return procStat(101, { parent: "100", start: "9007199254740993" })
    })
    assert.equal(calls, 1)
    assert.deepEqual(row, { pid: 101, parent: 100, start: "9007199254740993" })
    assert.equal(processBirth(row), 9007199254740993n)
  })

  test("only ENOENT and ESRCH stat errors mean disappeared while permission IO and unclassified errors remain unknown", () => {
    for (const code of ["ENOENT", "ESRCH"])
      assert.equal(
        readLinuxProcessRow(101, () => {
          throw Object.assign(new Error("fixture"), { code })
        }),
        undefined,
      )
    for (const code of ["EACCES", "EIO", "E".repeat(200)]) {
      const row = readLinuxProcessRow(101, () => {
        throw Object.assign(new Error("fixture"), { code })
      })
      unknownProcRow(row, 101)
      if (code.length < 64) assert.equal(row.error, code)
    }
    unknownProcRow(
      readLinuxProcessRow(101, () => {
        throw new Error("fixture without a code")
      }),
      101,
    )
    const root = { pid: 100, parent: 0, start: "1" }
    const unknown = readLinuxProcessRow(101, () => {
      throw Object.assign(new Error("fixture"), { code: "EACCES" })
    })
    assert.deepEqual(
      selectBirthBoundScope([root, unknown, { pid: 102, parent: 101, start: "200" }], 100),
      [root],
    )
  })

  test("only fully parsed zombie or dead Linux stat rows are treated as exited", () => {
    for (const state of ["Z", "X", "x"])
      assert.equal(
        readLinuxProcessRow(101, () => procStat(101, { state })),
        undefined,
      )
    unknownProcRow(
      readLinuxProcessRow(101, () => procStat(101, { state: "Z", start: "unknown" })),
      101,
    )
    unknownProcRow(
      readLinuxProcessRow(101, () => "101 (fixture) Z 1"),
      101,
    )
  })

  test("malformed Linux stat identity fields remain unknown instead of falsely proving a process exit", () => {
    const malformed = [
      procStat(102),
      procStat(101, { parent: "-1" }),
      procStat(101, { parent: "9007199254740992" }),
      procStat(101, { parent: "invalid" }),
      procStat(101, { start: "0" }),
      procStat(101, { start: "1.5" }),
      procStat(101, { state: "SS" }),
      procStat(101, { state: "?" }),
      "101 fixture without the comm delimiters",
      "101 (fixture) S 1",
    ]
    for (const stat of malformed)
      unknownProcRow(
        readLinuxProcessRow(101, () => stat),
        101,
      )
  })

  test("raw identity lookup exposes replacement births and unknown metadata while rejecting ambiguous tables", () => {
    const original = { pid: 101, parent: 100, start: "50" }
    const replacement = { pid: 101, parent: 100, start: "51" }
    assert.equal(processIdentity(101, [replacement]), replacement)
    assert.notEqual(processBirth(processIdentity(101, [replacement])), processBirth(original))
    assert.equal(processIdentity(101, []), undefined)
    unknownProcRow(
      processIdentity(101, [{ pid: 101, parent: 100, start: null, error: "EIO" }]),
      101,
    )
    unknownProcRow(processIdentity(101, [{ pid: 101, parent: null, start: "50" }]), 101)
    assert.throws(() => processIdentity(101, [original, replacement]), /Conflicting/)
    assert.throws(() => processIdentity(101, [original, null]), /Invalid/)
    assert.throws(() => processIdentity(101, [original, { pid: -1 }]), /Invalid/)
    assert.throws(() => processIdentity(101, {}), /metadata table/)
  })

  test("scope inspection preserves related unknown birth as incomplete instead of treating a filtered subset as a full census", () => {
    const rows = [
      { pid: 100, parent: 0, start: "100" },
      { pid: 101, parent: 100, start: null },
      { pid: 102, parent: 100, start: "101" },
      { pid: 103, parent: 101, start: "102" },
    ]
    const original = structuredClone(rows)
    const inspected = incompleteScope(rows, 100, 101)
    assert.equal(
      inspected.rows.some(row => row.pid === 101 || row.pid === 103),
      false,
    )
    assert.deepEqual(selectBirthBoundScope(rows, 100), inspected.rows)
    assert.deepEqual(rows, original)
  })

  test("strict snapshots reject missing unknown duplicate and cyclic roots without querying real PIDs", () => {
    const root = { pid: 100, parent: 0, start: "100" }
    for (const rows of [
      [],
      [{ ...root, start: null }],
      [{ ...root, parent: null }],
      [root, { ...root, start: "101" }],
      [{ ...root, parent: 100 }],
    ])
      incompleteScope(rows, 100, 100)
  })

  test("a related duplicate child is unresolved and cannot be admitted by a strict snapshot", () => {
    const rows = [
      { pid: 100, parent: 0, start: "100" },
      { pid: 101, parent: 100, start: "101" },
      { pid: 101, parent: 100, start: "102" },
      { pid: 102, parent: 100, start: "103" },
    ]
    const inspected = incompleteScope(rows, 100, 101)
    assert.equal(
      inspected.rows.some(row => row.pid === 101),
      false,
    )
  })

  test("known older branches and unrelated unknown or duplicate metadata do not contaminate a complete current scope", () => {
    const rows = [
      { pid: 100, parent: 0, start: "100" },
      { pid: 101, parent: 100, start: "99" },
      { pid: 103, parent: 101, start: null },
      { pid: 102, parent: 100, start: "101" },
      { pid: 999, parent: 888, start: null },
      { pid: 999, parent: 888, start: "1" },
    ]
    const inspected = inspectBirthBoundScope(rows, 100)
    assert.deepEqual(inspected.unresolved, [])
    assert.deepEqual(
      inspected.rows.map(row => row.pid),
      [100, 102],
    )
    assert.deepEqual(snapshot(100, rows), inspected.rows)
  })

  test("the injectable Windows reader fixes UTF8 execution timeout and output bytes without launching a real helper", () => {
    const expected = [{ pid: 100, parent: 0, start: "100" }]
    let calls = 0
    const execute = output => (executable, args, options) => {
      calls++
      assert.equal(path.win32.basename(executable).toLowerCase(), "powershell.exe")
      assert.deepEqual(args.slice(0, 3), ["-NoProfile", "-NonInteractive", "-Command"])
      assert.equal(args.length, 4)
      assert.match(args[3], /UTF8Encoding/i)
      assert.match(args[3], /OutputEncoding/)
      assert.equal(options.timeout, 10000)
      assert.equal(options.maxBuffer, 4 * 1024 * 1024)
      assert.equal(options.encoding, "utf8")
      assert.equal(options.windowsHide, true)
      return output
    }
    assert.deepEqual(readWindowsProcessRows(execute(JSON.stringify(expected))), expected)
    assert.deepEqual(readWindowsProcessRows(execute(JSON.stringify(expected[0]))), expected)
    assert.deepEqual(readWindowsProcessRows(execute("[]")), [])
    assert.equal(calls, 3)
  })

  test("Windows helper timeout permission and nonzero-exit errors remain errors rather than absent process tables", () => {
    const failures = [
      Object.assign(new Error("fixture timeout"), {
        code: "ETIMEDOUT",
        signal: "SIGTERM",
        status: null,
      }),
      Object.assign(new Error("fixture permission"), { code: "EACCES" }),
      Object.assign(new Error("fixture native nonzero exit"), {
        status: 1,
        signal: null,
        stdout: "[]",
      }),
    ]
    for (const failure of failures) {
      let calls = 0
      assert.throws(
        () =>
          readWindowsProcessRows(() => {
            calls++
            throw failure
          }),
        error => error === failure,
      )
      assert.equal(calls, 1)
    }
  })

  test("Windows empty malformed or invalid metadata output cannot masquerade as an empty successful census", () => {
    for (const output of [
      "",
      "  ",
      "{bad",
      "null",
      "1",
      "false",
      '["bad"]',
      '[{"pid":-1,"parent":0,"start":"1"}]',
    ])
      assert.throws(() => readWindowsProcessRows(() => output))
  })

  test(
    "a real self-authored IPC parent and child are selected and exit through their held ChildProcess handles",
    { timeout: 30000 },
    async context => {
      assert.ok(["win32", "linux"].includes(process.platform))
      const env = { ...process.env }
      delete env.NODE_OPTIONS
      delete env.PM2_NODE_OPTIONS
      const parent = fork(self, ["--snapshot-parent"], {
        execArgv: [],
        env,
        stdio: ["ignore", "ignore", "ignore", "ipc"],
        windowsHide: true,
      })
      const exited = nativeExit(parent)
      void exited.catch(() => {})
      let normalStop = false
      try {
        const ready = await message(parent, "parent-ready")
        assert.equal(ready.pid, parent.pid)
        const rows = snapshot(parent.pid)
        const root = rows.find(row => row.pid === parent.pid)
        const child = rows.find(row => row.pid === ready.leafPid)
        assert.ok(root, "Own live parent birth must be readable")
        assert.ok(child, "Own live direct child must be retained")
        assert.equal(child.parent, root.pid)
        assert.notEqual(processBirth(root), null)
        assert.notEqual(processBirth(child), null)
        assert.ok(processBirth(child) >= processBirth(root))
        const stopped = message(parent, "parent-stopped")
        await send(parent, { type: "stop" })
        const receipt = await stopped
        assert.equal(receipt.leafPid, child.pid)
        assert.deepEqual(receipt.leafNativeExit, { code: 0, signal: null })
        assert.equal(receipt.forced, false)
        assert.equal(receipt.reason, "requested")
        assert.deepEqual(await exited, { code: 0, signal: null })
        assert.equal(parent.exitCode, 0)
        assert.equal(parent.signalCode, null)
        context.diagnostic(
          JSON.stringify({
            platform: process.platform,
            parentIdentity: root,
            childIdentity: child,
            childNativeExit: receipt.leafNativeExit,
            parentNativeExit: { code: parent.exitCode, signal: parent.signalCode },
            forced: receipt.forced,
          }),
        )
        normalStop = true
      } finally {
        if (!normalStop && parent.exitCode === null && parent.signalCode === null) {
          if (parent.connected) await send(parent, { type: "stop" }).catch(() => {})
          const settled = await Promise.race([
            exited.then(() => true),
            new Promise(resolve => setTimeout(() => resolve(false), 6000)),
          ])
          if (!settled) {
            // 失败清理仅限上方创建的 ChildProcess。
            parent.kill("SIGTERM")
            await exited
          }
        }
      }
    },
  )
}
