import fs from "node:fs"
import path from "node:path"
import { spawn } from "node:child_process"
import { createHash, randomBytes } from "node:crypto"
import { fileURLToPath } from "node:url"
import { createRequire } from "node:module"
import { performance } from "node:perf_hooks"

const tests = path.dirname(fileURLToPath(import.meta.url))
const hashes = {
  linux: "569128f3066ac7be59b10b9a0adef708def642ee37cbf9d560a9bdb68f872108",
  win32: "d702daa815eabbff763c7d3808e235cf031cf2ca70211b56847bc72f51e240e5",
}
const sha = file => createHash("sha256").update(fs.readFileSync(file)).digest("hex")
const errorData = error => ({
  name: String(error?.name ?? "Error"),
  code: typeof error?.code === "string" ? error.code : undefined,
  message: String(error?.message ?? error).slice(0, 4096),
})
const check = (condition, message) => {
  if (!condition) throw new Error(message)
}
const exact = (value, fields) =>
  check(
    value &&
      typeof value === "object" &&
      !Array.isArray(value) &&
      Object.keys(value).length === fields.length &&
      fields.every(field => Object.hasOwn(value, field)),
    "Unexpected native prerequisite reply",
  )
const sameStat = (a, b) =>
  a.dev === b.dev &&
  a.ino === b.ino &&
  a.size === b.size &&
  a.mtimeMs === b.mtimeMs &&
  a.ctimeMs === b.ctimeMs

/** 固定调用方选择的测试 helper，并拒绝路径中任何链接。 */
export function inspectReclaimHelper(file, expectedSha256) {
  check(
    typeof file === "string" && path.isAbsolute(file),
    "GUARD_TEST_LINUX_RECLAIM_HELPER must be absolute",
  )
  check(
    typeof expectedSha256 === "string" && /^[a-f0-9]{64}$/.test(expectedSha256),
    "GUARD_TEST_LINUX_RECLAIM_HELPER_SHA256 must be explicit",
  )
  const parsed = path.parse(file)
  let cursor = parsed.root
  for (const part of file.slice(parsed.root.length).split(path.sep)) {
    check(part && part !== "." && part !== "..", "Invalid helper route")
    cursor = path.join(cursor, part)
    check(!fs.lstatSync(cursor).isSymbolicLink(), "Linked native test helper route")
  }
  const before = fs.lstatSync(file)
  check(before.isFile(), "Native test helper is not a regular file")
  const bytes = fs.readFileSync(file)
  check(
    createHash("sha256").update(bytes).digest("hex") === expectedSha256,
    "Native test helper hash mismatch",
  )
  check(
    bytes.length >= 64 &&
      bytes.subarray(0, 4).equals(Buffer.from([127, 69, 76, 70])) &&
      bytes[4] === 2 &&
      bytes[5] === 1 &&
      bytes.readUInt16LE(18) === 62,
    "Native test helper must be Linux x86_64 ELF",
  )
  const offset = Number(bytes.readBigUInt64LE(32)),
    size = bytes.readUInt16LE(54),
    count = bytes.readUInt16LE(56)
  check(
    Number.isSafeInteger(offset) &&
      size >= 56 &&
      count > 0 &&
      count < 256 &&
      offset + size * count <= bytes.length,
    "Invalid ELF headers",
  )
  for (let i = 0; i < count; i++)
    check(
      bytes.readUInt32LE(offset + i * size) !== 3,
      "Native test helper must be static (no PT_INTERP)",
    )
  fs.accessSync(file, fs.constants.R_OK | fs.constants.X_OK)
  check(sameStat(before, fs.lstatSync(file)), "Native test helper changed during inspection")
  return {
    file,
    sha256: expectedSha256,
    bytes: bytes.length,
    mode: before.mode & 0o7777,
    uid: before.uid,
    gid: before.gid,
    format: "elf64-x86_64-static",
  }
}

/** 仅使用私有标准输入输出；超时断开探针，不向 PID 发送信号。 */
export function runPrerequisiteProgram(
  executable,
  args,
  { input, timeout = 15000, maximumBytes = 65536 } = {},
) {
  return new Promise((resolve, reject) => {
    const child = spawn(executable, args, { windowsHide: true, stdio: ["pipe", "pipe", "pipe"] })
    const stdout = [],
      stderr = []
    let out = 0,
      err = 0,
      settled = false
    const fail = error => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      child.stdin.destroy()
      child.stdout.destroy()
      child.stderr.destroy()
      child.unref()
      reject(error)
    }
    const timer = setTimeout(
      () => fail(new Error("Prerequisite program timeout; native exit unconfirmed")),
      timeout,
    )
    child.once("error", fail)
    child.stdin.on("error", fail)
    child.stdout.on("data", bytes => {
      out += bytes.length
      if (out > maximumBytes) fail(new Error("Prerequisite stdout limit"))
      else stdout.push(bytes)
    })
    child.stderr.on("data", bytes => {
      err += bytes.length
      if (err > maximumBytes) fail(new Error("Prerequisite stderr limit"))
      else stderr.push(bytes)
    })
    child.once("close", (code, signal) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      const result = {
        native: { code, signal },
        stdout: Buffer.concat(stdout).toString("utf8"),
        stderr: Buffer.concat(stderr).toString("utf8"),
      }
      if (code !== 0 || signal !== null) {
        const failure = new Error(`Prerequisite native exit ${code ?? signal}`)
        failure.receipt = result
        reject(failure)
      } else resolve(result)
    })
    child.stdin.end(input)
  })
}

export function readCurrentBootId() {
  const bootId = fs.readFileSync("/proc/sys/kernel/random/boot_id", "utf8").trim()
  check(/^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/.test(bootId), "Unknown Linux boot ID")
  return bootId
}

/** 仅采用此前确认的归属记录，当前 PPID 不构成归属证明。 */
export function prepareLinuxReclaimRequest(
  identities,
  admitted,
  { readBirth, readNamespace, readBootId = readCurrentBootId },
) {
  check(
    Array.isArray(identities) && identities.length <= 256 && admitted instanceof Map,
    "Invalid admitted reclaim ledger",
  )
  const bootId = readBootId(),
    records = [],
    skipped = [],
    seen = new Set()
  for (const requested of identities) {
    check(
      Number.isSafeInteger(requested?.pid) &&
        requested.pid > 1 &&
        typeof requested.start === "string" &&
        /^[1-9][0-9]*$/.test(requested.start),
      "Unknown requested reclaim identity",
    )
    const key = `${requested.pid}:${requested.start}`,
      original = admitted.get(key)
    check(
      original?.pid === requested.pid && original.start === requested.start && !seen.has(key),
      "Reclaim target was not atomically admitted",
    )
    seen.add(key)
    const before = readBirth(original.pid)
    if (!before || before.start !== original.start) {
      skipped.push({
        pid: original.pid,
        start: original.start,
        result: before?.start ? "original-identity-absent" : "absent-or-unknown-no-action",
      })
      continue
    }
    check(before.pid === original.pid, "Reclaim lookup changed PID")
    const pidNamespace = readNamespace(original.pid)
    check(
      typeof pidNamespace === "string" && /^[0-9]{1,20}:[0-9]{1,20}$/.test(pidNamespace),
      "Unknown reclaim PID namespace",
    )
    const after = readBirth(original.pid)
    check(
      after?.pid === original.pid && after.start === original.start,
      "Reclaim birth changed across namespace lookup",
    )
    records.push({ pid: original.pid, startTicks: original.start, pidNamespace })
  }
  check(readBootId() === bootId, "Linux boot changed across reclaim ledger")
  return {
    request: {
      protocol: 1,
      nonce: randomBytes(24).toString("hex"),
      bootId,
      budgetMs: 15000,
      records,
    },
    skipped,
  }
}

export async function executeLinuxReclaim(
  helper,
  request,
  run = runPrerequisiteProgram,
  { deadline = performance.now() + 15000 } = {},
) {
  check(
    Number.isSafeInteger(request.budgetMs) && request.budgetMs > 0 && request.budgetMs <= 15000,
    "Invalid native reclaim budget",
  )
  const fixedDeadline = Math.min(deadline, performance.now() + request.budgetMs)
  inspectReclaimHelper(helper.file, helper.sha256)
  const remaining = Math.floor(fixedDeadline - performance.now())
  check(remaining > 0, "Native reclaim deadline before dispatch")
  const wireRequest = { ...request, budgetMs: remaining }
  const result = await run(helper.file, [], {
    input: JSON.stringify(wireRequest) + "\n",
    timeout: remaining,
  })
  inspectReclaimHelper(helper.file, helper.sha256)
  check(
    result.native?.code === 0 && result.native?.signal === null && result.stderr === "",
    "Native reclaim helper exit or stderr is unconfirmed",
  )
  const reply = JSON.parse(result.stdout)
  exact(
    reply,
    request.records.length
      ? ["protocol", "nonce", "scopeObservationComplete", "results"]
      : ["protocol", "nonce", "nativeEligibility", "scopeObservationComplete", "results"],
  )
  check(
    reply.protocol === 1 &&
      reply.nonce === request.nonce &&
      reply.scopeObservationComplete === false &&
      Array.isArray(reply.results) &&
      reply.results.length === request.records.length,
    "Native reclaim reply is not bound to the request",
  )
  if (!request.records.length)
    check(
      reply.nativeEligibility === "pidfd-self-open-send0-poll",
      "Native reclaim self preflight unavailable",
    )
  const seen = new Set()
  for (const row of reply.results) {
    const original = request.records.find(
      item => item.pid === row?.pid && item.startTicks === row.startTicks,
    )
    const fields =
      row.systemCode === undefined
        ? ["pid", "startTicks", "result"]
        : ["pid", "startTicks", "result", "systemCode"]
    exact(row, fields)
    check(
      original &&
        !seen.has(row.pid) &&
        [
          "terminated-and-exited",
          "identity-mismatch-or-unknown",
          "already-gone-unconfirmed",
          "sent-exit-unconfirmed",
          "deadline",
          "unknown",
        ].includes(row.result) &&
        (row.systemCode === undefined || Number.isSafeInteger(row.systemCode)),
      "Unknown native reclaim result",
    )
    seen.add(row.pid)
  }
  return { ...result, request: wireRequest, reply }
}

function receiptFiles({ directory, version, root = tests }) {
  const label = /^[a-zA-Z0-9._+-]{1,80}$/.test(version ?? "") ? version : "unknown"
  const fallback = () => {
    const runs = path.join(root, "runs")
    fs.mkdirSync(runs, { recursive: true })
    return fs.mkdtempSync(path.join(runs, "cached-upgrade-eligibility-"))
  }
  let selected, locationError
  try {
    if (directory === undefined) selected = fallback()
    else {
      check(path.isAbsolute(directory), "Eligibility directory must be absolute")
      if (!fs.existsSync(directory)) fs.mkdirSync(directory, { mode: 0o700 })
      check(
        fs.lstatSync(directory).isDirectory() && !fs.lstatSync(directory).isSymbolicLink(),
        "Eligibility directory must be non-linked",
      )
      selected = directory
    }
    const started = path.join(selected, `${label}.started.json`),
      final = path.join(selected, `${label}.json`)
    check(
      !fs.existsSync(started) && !fs.existsSync(final),
      "Eligibility receipt already exists; no overwrite",
    )
    const descriptor = fs.openSync(started, "wx", 0o600)
    fs.writeFileSync(
      descriptor,
      JSON.stringify({
        schemaVersion: 1,
        status: "prerequisite-checks-started",
        version,
        at: new Date().toISOString(),
        pm2DaemonsStarted: 0,
        fixtureEnvironmentsCreated: 0,
        productActionsStarted: 0,
        cleanupEvidence: false,
      }) + "\n",
    )
    fs.closeSync(descriptor)
    return { started, final, locationError }
  } catch (error) {
    locationError = errorData(error)
    selected = fallback()
    const started = path.join(selected, `${label}.started.json`),
      final = path.join(selected, `${label}.json`)
    fs.writeFileSync(
      started,
      JSON.stringify({
        schemaVersion: 1,
        status: "requested-receipt-location-refused",
        version,
        locationError,
        pm2DaemonsStarted: 0,
        fixtureEnvironmentsCreated: 0,
        productActionsStarted: 0,
        cleanupEvidence: false,
      }) + "\n",
      { flag: "wx", mode: 0o600 },
    )
    return { started, final, locationError }
  }
}

/** 每项检查只结算一次；条件不足也保存独立回执，不覆盖旧结果。 */
export async function settlePrerequisiteChecks({
  checks,
  directory,
  version,
  root = tests,
  context = {},
}) {
  const files = receiptFiles({ directory, version, root }),
    rows = []
  if (files.locationError)
    rows.push({
      name: "receipt-location",
      required: true,
      status: "failed",
      error: files.locationError,
    })
  for (const item of checks) {
    try {
      rows.push({
        name: item.name,
        required: item.required !== false,
        status: "passed",
        detail: await item.run(),
      })
    } catch (error) {
      rows.push({
        name: item.name,
        required: item.required !== false,
        status: "failed",
        error: errorData(error),
        nativeReceipt: error?.receipt,
      })
    }
  }
  const eligible = !rows.some(row => row.required && row.status !== "passed")
  const receipt = {
    schemaVersion: 1,
    status: eligible ? "eligible-before-fixture" : "ineligible-before-fixture",
    eligible,
    platform: process.platform,
    architecture: process.arch,
    version,
    ...context,
    checks: rows,
    startedReceipt: files.started,
    pm2DaemonsStarted: 0,
    fixtureEnvironmentsCreated: 0,
    productActionsStarted: 0,
    cleanupEvidence: false,
  }
  fs.writeFileSync(files.final, JSON.stringify(receipt, null, 2) + "\n", {
    flag: "wx",
    mode: 0o600,
  })
  if (!eligible) {
    const error = new Error(`Cached upgrade prerequisites failed; receipt: ${files.final}`)
    error.eligibilityReceipt = files.final
    error.eligibility = receipt
    throw error
  }
  return { receipt, receiptFile: files.final, receiptSha256: sha(files.final) }
}

function executableMetadata(file) {
  const resolved = fs.realpathSync.native(file),
    stat = fs.statSync(resolved)
  check(stat.isFile(), "External prerequisite is not a regular executable")
  fs.accessSync(resolved, fs.constants.X_OK)
  return { file, resolved, sha256: sha(resolved), bytes: stat.size }
}
function findProgram(name, env) {
  for (const entry of String(env.PATH ?? "").split(path.delimiter)) {
    if (!entry || !path.isAbsolute(entry)) continue
    const candidate = path.join(entry, name)
    try {
      return executableMetadata(candidate)
    } catch {}
  }
  throw new Error(`Conditional system program unavailable: ${name}`)
}
function pidusageInputs(pm2Root) {
  const roots = new Map(),
    require = createRequire(path.join(pm2Root, "package.json"))
  for (const owner of [null, "pm2-sysmonit", "@pm2/io"]) {
    try {
      const resolver = owner ? createRequire(require.resolve(`${owner}/package.json`)) : require
      const file = resolver.resolve("pidusage/package.json"),
        metadata = JSON.parse(fs.readFileSync(file, "utf8"))
      roots.set(file, { owner: owner ?? "pm2", file, version: metadata.version, sha256: sha(file) })
    } catch (error) {
      if (!owner) throw error
    }
  }
  return [...roots.values()]
}

export async function ensureCachedUpgradePrerequisites({
  pm2Root,
  nodePath = process.execPath,
  env = process.env,
  receiptDirectory = env.GUARD_TEST_PM2_CACHED_ELIGIBILITY_DIR,
  testsRoot = tests,
}) {
  let pm2, helper, powershell
  try {
    pm2 = JSON.parse(fs.readFileSync(path.join(pm2Root, "package.json"), "utf8"))
  } catch {}
  const version = pm2?.version ?? "unknown",
    checks = [],
    usePs = /^true$/i.test(env.PIDUSAGE_USE_PS ?? "")
  checks.push({
    name: "platform-and-pm2-input",
    run: () => {
      check(
        ["linux", "win32"].includes(process.platform) && process.arch === "x64",
        "Unqualified cached-upgrade platform/architecture",
      )
      check(pm2?.name === "pm2" && typeof version === "string", "Unknown PM2 package")
      return { pm2Root, name: pm2.name, version }
    },
  })
  checks.push({
    name: "fixed-node-image-and-capabilities",
    run: async () => {
      check(path.isAbsolute(nodePath), "Node prerequisite must be absolute")
      const metadata = executableMetadata(nodePath)
      check(
        metadata.sha256 === hashes[process.platform],
        "Node prerequisite image differs from pinned platform input",
      )
      const value = await runPrerequisiteProgram(
        metadata.resolved,
        [
          "--input-type=module",
          "-e",
          "import * as module from 'node:module';console.log(JSON.stringify({version:process.version,inspect:process.features.inspector,requireModule:process.features.require_module,registerHooks:typeof module.registerHooks,fetch:typeof fetch,WebSocket:typeof WebSocket}))",
        ],
        { timeout: 10000 },
      )
      const features = JSON.parse(value.stdout)
      check(
        features.version === "v24.22.1" &&
          features.inspect === true &&
          features.requireModule === true &&
          features.registerHooks === "function" &&
          features.fetch === "function" &&
          features.WebSocket === "function",
        "Node prerequisite capabilities unavailable",
      )
      check(
        !env.NODE_OPTIONS && !env.PM2_NODE_OPTIONS && !env.NODE_PATH,
        "Injected Node module environment must be absent before the fixture",
      )
      return { ...metadata, features, native: value.native }
    },
  })
  if (process.platform === "linux") {
    checks.push({
      name: "pinned-linux-reclaim-helper",
      run: () => {
        helper = inspectReclaimHelper(
          env.GUARD_TEST_LINUX_RECLAIM_HELPER,
          env.GUARD_TEST_LINUX_RECLAIM_HELPER_SHA256,
        )
        return helper
      },
    })
    checks.push({
      name: "linux-pidfd-self-eligibility",
      run: async () => {
        check(helper, "Reclaim helper input did not qualify")
        const request = {
          protocol: 1,
          nonce: randomBytes(24).toString("hex"),
          bootId: readCurrentBootId(),
          budgetMs: 15000,
          records: [],
        }
        return executeLinuxReclaim(helper, request)
      },
    })
    checks.push({
      name: "pidusage-selected-procfile-system-inputs",
      required: !usePs,
      run: async () => {
        const packages = pidusageInputs(pm2Root),
          shell = executableMetadata("/bin/sh"),
          getconf = findProgram("getconf", env),
          values = {}
        for (const key of ["CLK_TCK", "PAGESIZE"]) {
          const result = await runPrerequisiteProgram(getconf.file, [key], { timeout: 5000 })
          check(/^[1-9][0-9]*$/.test(result.stdout.trim()), "getconf capability unavailable")
          values[key] = result.stdout.trim()
        }
        check(
          fs
            .readFileSync("/proc/uptime", "utf8")
            .trim()
            .match(/^[0-9.]+ [0-9.]+$/),
          "pidusage proc uptime input unavailable",
        )
        return {
          packages,
          shell,
          getconf,
          values,
          path: "procfile-default",
          monitorStatsNotQualified: true,
        }
      },
    })
    checks.push({
      name: "pidusage-conditional-ps",
      required: usePs,
      run: async () => {
        const metadata = findProgram("ps", env)
        if (!usePs) return { ...metadata, applicable: false, argumentsNotQualified: true }
        const result = await runPrerequisiteProgram(
          metadata.file,
          ["-o", "etime,pid,ppid,pcpu,rss,time", "-p", String(process.pid)],
          { timeout: 5000 },
        )
        check(
          result.stdout
            .trim()
            .split(/\r?\n/)
            .some(line => {
              const columns = line.trim().split(/\s+/)
              return columns.length === 6 && columns[1] === String(process.pid)
            }),
          "Selected pidusage ps arguments unavailable",
        )
        return {
          ...metadata,
          applicable: true,
          ownPidArguments: "etime,pid,ppid,pcpu,rss,time",
          native: result.native,
          monitorStatsNotQualified: true,
        }
      },
    })
  } else if (process.platform === "win32") {
    checks.push({
      name: "windows-system-powershell-cim",
      run: async () => {
        check(path.isAbsolute(env.SystemRoot ?? ""), "Windows SystemRoot is unknown")
        powershell = executableMetadata(
          path.join(env.SystemRoot, "System32/WindowsPowerShell/v1.0/powershell.exe"),
        )
        check(
          findProgram("powershell.exe", env).resolved.toLowerCase() ===
            powershell.resolved.toLowerCase(),
          "PATH PowerShell differs from pinned system PowerShell",
        )
        const script =
          "$ErrorActionPreference='Stop';[Console]::OutputEncoding=[Text.UTF8Encoding]::new($false);$OutputEncoding=[Console]::OutputEncoding;$p=Get-CimInstance Win32_Process -Filter ('ProcessId = '+$PID);@{version=$PSVersionTable.PSVersion.ToString();edition=$PSVersionTable.PSEdition;selfCim=([int]$p.ProcessId -eq $PID);commandSource=(Get-Command Get-CimInstance).Source}|ConvertTo-Json -Compress"
        const result = await runPrerequisiteProgram(
          powershell.resolved,
          ["-NoProfile", "-NonInteractive", "-Command", script],
          { timeout: 15000 },
        )
        const capabilities = JSON.parse(result.stdout)
        check(
          capabilities.selfCim === true &&
            capabilities.commandSource === "CimCmdlets" &&
            /^5\.1\./.test(capabilities.version),
          "Windows system PowerShell/CIM capability unavailable",
        )
        return { ...powershell, capabilities, native: result.native }
      },
    })
    checks.push({
      name: "pidusage-windows-conditional-statistics",
      required: false,
      run: () => {
        const programs = ["System32/cmd.exe", "System32/chcp.com", "System32/Wbem/WMIC.exe"].map(
          relative => {
            const file = path.join(env.SystemRoot ?? "", relative)
            try {
              return { available: true, ...executableMetadata(file) }
            } catch (error) {
              return { file, available: false, error: errorData(error) }
            }
          },
        )
        return {
          packages: pidusageInputs(pm2Root),
          programs,
          monitorStatsNotQualified: true,
          missingStatisticsToolDoesNotQualifyStatistics: true,
        }
      },
    })
  }
  const result = await settlePrerequisiteChecks({
    checks,
    directory: receiptDirectory,
    version,
    root: testsRoot,
    context: {
      pm2Root,
      nodePath,
      notRequiredForThisFixture: [
        "python",
        "pnpm (host restart bridge uses original Node CLI)",
        "external Redis (fixture supplies memory Redis)",
      ],
    },
  })
  return { ...result, helper, powershell }
}
