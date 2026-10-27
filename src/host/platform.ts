import fs from "node:fs"
import path from "node:path"
import { spawn, type ChildProcess } from "node:child_process"
import { performance } from "node:perf_hooks"
import { setTimeout as sleep } from "node:timers/promises"
import {
  createNativeIdentityAdapter,
  createOriginalWindowsChildProbe,
  type CapturedRecord,
  type NativeRootScopeSession,
  type OriginalWindowsChildProbe,
} from "../native-process/index.js"
import { M } from "../shared/messages.js"

export interface PlatformCapabilities {
  platform: string
  supported: boolean
  isolation: "managed-process" | "os-sandbox"
  osSandbox: boolean
  processTree:
    "process-group" | "identity-checked-snapshot" | "pid-namespace" | "job-object" | "unsupported"
  limitations: string[]
}

/** 返回当前平台支持的运行模式与隔离能力。 */
export function capabilities(
  platform: NodeJS.Platform = process.platform,
  mode = "managed",
): PlatformCapabilities {
  const supported = ["win32", "linux", "android"].includes(platform)
  const osSandbox = supported && ["win32", "linux"].includes(platform) && mode === "os-sandbox"
  return {
    platform,
    supported,
    isolation: osSandbox ? "os-sandbox" : "managed-process",
    osSandbox,
    processTree: osSandbox
      ? platform === "win32"
        ? "job-object"
        : "pid-namespace"
      : !supported
        ? "unsupported"
        : platform === "win32"
          ? "identity-checked-snapshot"
          : "process-group",
    limitations: [
      osSandbox
        ? "Native programs are constrained by the OS boundary, not audited at every syscall"
        : "JS hooks do not isolate native code or a hostile process running as the same OS user",
      osSandbox
        ? platform === "win32"
          ? "AppContainer plus Job Object; network capability policy applies; no automatic loopback exemptions"
          : "bubblewrap namespaces plus seccomp; network host explicitly shares the host network"
        : platform === "win32"
          ? "Windows snapshots do not contain descendants that detached or reparented before capture; Job Objects are not installed"
          : "Processes that escape the worker process group are outside this cleanup boundary; after a reaped group leader, nonempty groups are not signalled because ownership cannot be proven",
      ...(!osSandbox && platform === "win32"
        ? [
            "Managed Windows descendant identity requires the qualified official x64 Node 24.22.1 image; other Host profiles are refused before worker spawn",
          ]
        : []),
    ],
  }
}

/** 确认当前平台支持所选运行模式。 */
export function assertPlatform(mode: string, platform: NodeJS.Platform = process.platform): void {
  if (!capabilities(platform).supported) throw new Error(M.host.platform(platform))
  if (mode !== "managed" && (mode !== "os-sandbox" || platform === "android"))
    throw new Error(M.host.sandboxUnavailable)
}

/** 执行 PowerShell 脚本并返回标准输出。 */
export function powershell(script: string, timeout = 12000): Promise<string> {
  return new Promise((resolve, reject) => {
    const executable = path.join(
      process.env.SystemRoot || "C:\\Windows",
      "System32",
      "WindowsPowerShell",
      "v1.0",
      "powershell.exe",
    )
    const helper = spawn(executable, ["-NoProfile", "-NonInteractive", "-Command", script], {
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    })
    let output = ""
    const timer = setTimeout(() => {
      helper.kill()
      reject(new Error(M.host.helperTimeout))
    }, timeout)
    helper.stdout?.on("data", (data: Buffer) => {
      output += data.toString()
      if (output.length > 1024 * 1024) {
        helper.kill()
        clearTimeout(timer)
        reject(new Error(M.host.helperOutput))
      }
    })
    helper.once("error", error => {
      clearTimeout(timer)
      reject(error)
    })
    helper.once("exit", code => {
      clearTimeout(timer)
      if (code === 0) resolve(output.trim())
      else reject(new Error(M.host.helperFailed(code)))
    })
  })
}

/** 等待首次接管前的原进程及其子进程退出。 */
export async function waitForBootstrapExit(pid: number, timeout: number): Promise<void> {
  if (!Number.isSafeInteger(pid) || pid <= 1 || pid === process.pid)
    throw new Error(M.host.bootstrapPid)
  if (process.platform === "win32") {
    // WaitForExit 使用内核进程句柄；kill(pid, 0) 无法可靠判断 Windows 进程是否退出。
    await powershell(
      `$guardProcess = Get-Process -Id ${pid} -ErrorAction SilentlyContinue; if ($null -ne $guardProcess) { if (-not $guardProcess.WaitForExit(${Math.floor(timeout)})) { exit 1 } }; exit 0`,
      timeout + 3000,
    )
    return
  }
  const deadline = Date.now() + timeout
  while (Date.now() < deadline) {
    try {
      const stat = fs.readFileSync(`/proc/${pid}/stat`, "utf8")
      if (stat.slice(stat.lastIndexOf(") ") + 2).startsWith("Z")) return
      process.kill(pid, 0)
    } catch (error) {
      if (["ESRCH", "ENOENT"].includes((error as NodeJS.ErrnoException).code || "")) return
      throw error
    }
    await sleep(25)
  }
  throw new Error(M.host.exitDeadline)
}

export interface ProcessIdentity {
  pid: number
  created: string
}

interface WindowsScope {
  probe?: OriginalWindowsChildProbe
  opening?: Promise<NativeRootScopeSession>
  session?: NativeRootScopeSession
  records: Map<string, CapturedRecord>
  retired: boolean
  qualificationError?: Error
  cleanupComplete?: boolean
  cleanupError?: Error
}
const windowsScopes = new WeakMap<ChildProcess, WindowsScope>()

/** spawn 后首次 await 前，同步固定原始原生接收器。 */
export function prepareDescendantCapture(child: ChildProcess): void {
  if (process.platform !== "win32" || windowsScopes.has(child)) return
  const scope: WindowsScope = { records: new Map(), retired: false }
  windowsScopes.set(child, scope)
  try {
    scope.probe = createOriginalWindowsChildProbe(child)
  } catch (error) {
    scope.qualificationError = error as Error
  }
}

/** PID 和创建时间仅作证据，不能据此重新打开进程并终止。 */
export async function captureDescendants(
  child: ChildProcess,
  remainingBudgetMs = 30000,
): Promise<ProcessIdentity[]> {
  if (process.platform !== "win32" || !child.pid) return []
  prepareDescendantCapture(child)
  const scope = windowsScopes.get(child)!
  if (scope.qualificationError) throw scope.qualificationError
  if (scope.retired || hasExited(child)) throw new Error(M.host.rootUnavailable)
  scope.opening ??= createNativeIdentityAdapter().openRoot(scope.probe!, remainingBudgetMs)
  scope.session ??= await scope.opening
  const result = await scope.session.captureInto({
    /** 记录已核验的进程快照。 */
    commitVerifiedSnapshot(_root, records) {
      for (const row of records) scope.records.set(row.recordId, row)
    },
  })
  if (!result.committed || result.observation !== "complete")
    throw new Error(M.host.descendantsIncomplete(result.reason ?? "unknown"))
  return [...scope.records.values()].map(row => ({
    pid: row.identity.pid,
    created: row.identity.birth.value,
  }))
}

/** native0 可能重置 libuv 记录的退出信号，终止前必须停止后代捕获。 */
export function retireDescendantCapture(child: ChildProcess): void {
  const scope = windowsScopes.get(child)
  if (!scope) return
  scope.retired = true
  scope.probe?.retire()
  scope.session?.retireCapture()
}

/** 判断子进程是否已退出。 */
export function hasExited(child: ChildProcess): boolean {
  return child.exitCode !== null || child.signalCode !== null
}

/** 终止 Windows 上已捕获的进程树。 */
async function terminateCapturedWindows(child: ChildProcess): Promise<void> {
  const scope = windowsScopes.get(child)
  if (!scope?.session || scope.cleanupComplete) return
  if (scope.cleanupError) throw scope.cleanupError
  const ids = [...scope.records.keys()]
  const failures: Error[] = []
  try {
    if (ids.length) {
      const result = await scope.session.terminateCaptured(ids)
      if (
        result.results.some(
          row => !["original-exited", "terminated-and-exited"].includes(row.result),
        )
      )
        throw new Error(M.host.handleCleanup)
    }
  } catch (error) {
    failures.push(error as Error)
  } finally {
    try {
      await scope.session.close()
    } catch (error) {
      failures.push(error as Error)
    }
  }
  if (failures.length) {
    scope.cleanupError = new AggregateError(failures, M.host.heldCleanup)
    throw scope.cleanupError
  }
  scope.cleanupComplete = true
}

/** 判断进程组是否仍有存活成员。 */
function liveGroupMembers(group: number): boolean {
  // 忽略已更换父进程的僵尸进程；它们不能执行或占用端口，只能由父进程 wait() 回收。
  try {
    for (const entry of fs.readdirSync("/proc")) {
      if (!/^\d+$/.test(entry)) continue
      try {
        const text = fs.readFileSync(`/proc/${entry}/stat`, "utf8")
        const fields = text.slice(text.lastIndexOf(") ") + 2).split(" ")
        if (Number(fields[2]) === group && fields[0] !== "Z" && fields[0] !== "X") return true
      } catch (error) {
        if (!["ENOENT", "ESRCH"].includes((error as NodeJS.ErrnoException).code || "")) throw error
      }
    }
    return false
  } catch {
    // Android 的 /proc 受限时，只要进程组仍存在，就不能声称清理完成。
    try {
      process.kill(-group, 0)
      return true
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ESRCH") return false
      throw error
    }
  }
}

/** 仅处理本宿主创建的子进程，不接受任意外部 PID。 */
export async function terminateWorkerTree(
  child: ChildProcess,
  descendants: ProcessIdentity[],
  options: { ownedOsScope?: boolean } = {},
): Promise<void> {
  const pid = child.pid
  if (!pid) return
  if (!Number.isSafeInteger(pid) || pid <= 1 || pid === process.pid)
    throw new Error(M.host.unsafeCleanup)
  if (process.platform === "win32") {
    let observationError: unknown
    if (!hasExited(child)) {
      if (!options.ownedOsScope && !windowsScopes.get(child)?.retired) {
        try {
          descendants.push(...(await captureDescendants(child)))
        } catch (error) {
          observationError = error
        }
      }
      retireDescendantCapture(child)
      // child.kill 使用 Node 持有的进程句柄，不会误杀复用根 PID 的进程。
      child.kill("SIGKILL")
    }
    await terminateCapturedWindows(child)
    if (observationError) throw observationError
    if (!options.ownedOsScope && descendants.length && !windowsScopes.get(child)?.session)
      throw new Error(M.host.legacyPid)
  } else {
    // 直接子进程被回收前，即使已成为僵尸，其 PID 仍被保留。
    // 回收后 PID/PGID 可能属于其他进程组，不能向归属未确认的组发送信号。
    // 此时保持宿主熔断，等待人工清理。
    if (hasExited(child)) {
      const deadline = performance.now() + 5000
      while (liveGroupMembers(pid) && performance.now() < deadline) await sleep(25)
      if (!liveGroupMembers(pid)) return
      throw new Error(M.host.groupOwnership)
    }
    // Worker 以 detached 模式启动，进程组与宿主分离。
    try {
      process.kill(-pid, "SIGKILL")
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error
    }
  }
  const deadline = performance.now() + 5000
  while (performance.now() < deadline) {
    if (hasExited(child) && (process.platform === "win32" || !liveGroupMembers(pid))) return
    await sleep(25)
  }
  throw new Error(M.host.cleanupUnconfirmed)
}
