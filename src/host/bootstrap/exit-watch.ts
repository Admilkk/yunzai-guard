import fs from "node:fs"
import path from "node:path"
import { spawn } from "node:child_process"
import { performance } from "node:perf_hooks"
import { M } from "../../shared/messages.js"

export interface BootstrapProcessIdentity {
  readonly pid: number
  /** Linux 启动时钟计数或 Windows StartTime 的 UTC 计数；绝不只凭 PID 识别。 */
  readonly created: string
  readonly parentPid: number
  readonly namespace?: string
}

export interface BootstrapExitWatch {
  readonly identities: readonly BootstrapProcessIdentity[]
  /** 仅在两个原始进程及本次观察器全部退出后完成。 */
  readonly exited: Promise<void>
  /** 仅取消观察，不向任何被观察进程发送信号。 */
  close(): Promise<void>
}

export class BootstrapExitWatchClosedError extends Error {
  /** 创建观察被关闭时的错误。 */
  constructor() {
    super("Bootstrap exit watch closed before original processes exited")
    this.name = "BootstrapExitWatchClosedError"
  }
}

/** 创建可外部解决的 Promise。 */
function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (error: unknown) => void
  const promise = new Promise<T>((yes, no) => {
    resolve = yes
    reject = no
  })
  // 观察器可能在调用方等待 exited 前完成；保留原 Promise 的拒绝结果，
  // 同时避免产生未处理的拒绝。
  void promise.catch(() => {})
  return { promise, resolve, reject }
}

/** 创建超时错误。 */
function timeoutError() {
  const error = new Error(M.host.exitDeadline)
  error.name = "BootstrapExitWatchTimeoutError"
  return error
}

/** 读取 Linux 进程的状态字段。 */
function linuxStat(pid: number) {
  const text = fs.readFileSync(`/proc/${pid}/stat`, "utf8")
  const end = text.lastIndexOf(") ")
  if (end < 0) throw new Error(M.host.processStat)
  const fields = text
    .slice(end + 2)
    .trim()
    .split(/\s+/)
  if (!/^\d+$/.test(fields[19] ?? "") || !/^\d+$/.test(fields[1] ?? ""))
    throw new Error(M.host.identityMissing)
  return { pid, created: fields[19], parentPid: Number(fields[1]), state: fields[0] }
}

/** 读取 Linux 进程身份（启动时间），用于防止 PID 复用。 */
function linuxIdentity(pid: number) {
  const before = linuxStat(pid)
  const namespace = fs.readlinkSync(`/proc/${pid}/ns/pid`)
  const after = linuxStat(pid)
  if (before.created !== after.created) throw new Error(M.host.identityChanged)
  if (!/^pid:\[\d+\]$/.test(namespace)) throw new Error(M.host.pidNamespace)
  return { ...after, namespace }
}

/** 在 Linux 上等待原进程及其子进程退出。 */
function linuxWatch(rootPid: number, childPid: number | null, timeout: number): BootstrapExitWatch {
  const start = performance.now()
  const identities = [
    linuxIdentity(rootPid),
    ...(childPid === null ? [] : [linuxIdentity(childPid)]),
  ]
  for (const identity of identities) {
    const current = linuxIdentity(identity.pid)
    if (
      current.created !== identity.created ||
      current.namespace !== identity.namespace ||
      ["Z", "X", "x"].includes(current.state)
    )
      throw new Error(M.host.notLive)
    if (
      identity.pid === childPid &&
      (identity.parentPid !== rootPid || current.parentPid !== rootPid)
    )
      throw new Error(M.host.redisNotChild)
  }
  const exited = deferred<void>()
  const pending = new Set(identities)
  let finished = false
  const finish = (error?: unknown) => {
    if (finished) return
    finished = true
    clearInterval(poll)
    clearTimeout(deadline)
    if (error) exited.reject(error)
    else exited.resolve()
  }
  const poll = setInterval(() => {
    try {
      for (const identity of pending) {
        try {
          const current = linuxIdentity(identity.pid)
          if (
            current.created !== identity.created ||
            current.namespace !== identity.namespace ||
            ["Z", "X", "x"].includes(current.state)
          )
            pending.delete(identity)
        } catch (error) {
          if (["ENOENT", "ESRCH"].includes((error as NodeJS.ErrnoException).code ?? ""))
            pending.delete(identity)
          else throw error
        }
      }
      if (!pending.size) finish()
    } catch (error) {
      finish(error)
    }
  }, 25)
  const deadline = setTimeout(
    () => finish(timeoutError()),
    Math.max(1, timeout - (performance.now() - start)),
  )
  return Object.freeze({
    identities: Object.freeze(
      identities.map(({ state: _state, ...identity }) => Object.freeze(identity)),
    ),
    exited: exited.promise,
    /** 关闭观察。 */
    async close() {
      finish(new BootstrapExitWatchClosedError())
    },
  })
}

/** 生成 Windows 进程退出观察脚本，只接受数字参数。 */
function windowsScript(rootPid: number, childPid: number | null, timeout: number): string {
  // 仅传入数字参数；查询 CIM 前先打开各 Process.Handle，
  // 再复查 HasExited。持有存活进程句柄，避免捕获期间 PID 被复用，
  // 导致 CIM 的父进程记录指向其他进程。
  return `
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)
$guardProcesses = @()
$guardClock = [Diagnostics.Stopwatch]::StartNew()
try {
  $guardIds = @(${rootPid}${childPid === null ? "" : `,${childPid}`})
  $guardIdentities = @()
  foreach ($guardId in $guardIds) {
    $guardProcess = [Diagnostics.Process]::GetProcessById($guardId)
    $guardProcesses += $guardProcess
    $null = $guardProcess.Handle
    $guardCreated = $guardProcess.StartTime.ToUniversalTime().Ticks.ToString()
    if ($guardProcess.HasExited) { throw 'Bootstrap original process is not live during capture' }
    $guardRow = Get-CimInstance Win32_Process -Filter ('ProcessId = ' + $guardId) -ErrorAction Stop
    if ($null -eq $guardRow -or $guardProcess.HasExited) { throw 'Bootstrap identity disappeared during capture' }
    $guardIdentities += @{ pid = [int]$guardId; created = $guardCreated; parentPid = [int]$guardRow.ParentProcessId }
  }
  foreach ($guardProcess in $guardProcesses) {
    if ($guardProcess.HasExited) { throw 'Bootstrap original process exited before ready' }
  }
  ${childPid === null ? "" : `if ($guardIdentities[1].parentPid -ne ${rootPid}) { throw 'Owned Redis is not a direct bootstrap child' }`}
  [Console]::Out.WriteLine((@{ type = 'ready'; identities = @($guardIdentities) } | ConvertTo-Json -Depth 4 -Compress))
  [Console]::Out.Flush()
  foreach ($guardProcess in $guardProcesses) {
    $guardRemaining = [Math]::Max(1, ${timeout} - [int]$guardClock.ElapsedMilliseconds)
    if (-not $guardProcess.WaitForExit($guardRemaining)) { throw 'Bootstrap original process exit deadline exceeded' }
  }
  [Console]::Out.WriteLine('{"type":"exited"}')
  [Console]::Out.Flush()
} catch {
  [Console]::Out.WriteLine((@{ type = 'error'; message = $_.Exception.Message } | ConvertTo-Json -Compress))
  [Console]::Out.Flush()
  exit 1
} finally {
  foreach ($guardProcess in $guardProcesses) { $guardProcess.Dispose() }
}
`
}

/** 在 Windows 上等待原进程及其子进程退出。 */
async function windowsWatch(
  rootPid: number,
  childPid: number | null,
  timeout: number,
): Promise<BootstrapExitWatch> {
  const executable = path.join(
    process.env.SystemRoot || "C:\\Windows",
    "System32/WindowsPowerShell/v1.0/powershell.exe",
  )
  const helper = spawn(
    executable,
    ["-NoProfile", "-NonInteractive", "-Command", windowsScript(rootPid, childPid, timeout)],
    {
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    },
  )
  const ready = deferred<readonly BootstrapProcessIdentity[]>()
  const exited = deferred<void>()
  const closed = deferred<void>()
  let terminalError: unknown
  let complete = false
  let helperClosed = false
  let identities: readonly BootstrapProcessIdentity[] | undefined
  let output = "",
    stderr = ""
  let closing: Promise<void> | undefined
  const close = (): Promise<void> => {
    if (closing) return closing
    closing = (async () => {
      if (!helperClosed) {
        terminalError ??= new BootstrapExitWatchClosedError()
        helper.kill("SIGKILL") // 仅终止本次私有观察器，不操作被观察目标。
      }
      let timer: ReturnType<typeof setTimeout> | undefined
      try {
        await Promise.race([
          closed.promise,
          new Promise<never>((_resolve, reject) => {
            timer = setTimeout(() => reject(new Error(M.host.observerCleanup)), 5000)
          }),
        ])
      } finally {
        clearTimeout(timer)
      }
    })()
    void closing.catch(() => {})
    return closing
  }
  const stop = (error: unknown) => {
    terminalError ??= error
    void close().catch(cleanupError => {
      ready.reject(cleanupError)
      exited.reject(cleanupError)
    })
  }
  const deadline = setTimeout(() => stop(timeoutError()), timeout)
  helper.once("error", error => {
    terminalError ??= error
  })
  helper.stderr.on("data", data => {
    stderr = (stderr + String(data)).slice(-8192)
  })
  helper.stdout.on("data", data => {
    output += String(data)
    if (output.length > 16384) return stop(new Error(M.host.observerOutput))
    let end: number
    while ((end = output.indexOf("\n")) !== -1) {
      const line = output.slice(0, end).trim()
      output = output.slice(end + 1)
      if (!line) continue
      try {
        const frame = JSON.parse(line) as {
          type?: string
          identities?: BootstrapProcessIdentity[]
          message?: string
        }
        if (frame.type === "ready" && !identities) {
          const expected = [rootPid, ...(childPid === null ? [] : [childPid])]
          const rows = frame.identities
          if (
            !Array.isArray(rows) ||
            rows.length !== expected.length ||
            rows.some(
              (row, i) =>
                row.pid !== expected[i] ||
                !/^\d+$/.test(row.created) ||
                !Number.isSafeInteger(row.parentPid) ||
                row.parentPid < 0,
            )
          )
            throw new Error(M.host.observerIdentity)
          if (childPid !== null && rows[1].parentPid !== rootPid)
            throw new Error(M.host.redisParent)
          identities = Object.freeze(
            rows.map(row =>
              Object.freeze({ pid: row.pid, created: row.created, parentPid: row.parentPid }),
            ),
          )
          ready.resolve(identities)
        } else if (frame.type === "exited" && identities) complete = true
        else if (frame.type === "error")
          terminalError ??=
            frame.message === "Bootstrap original process exit deadline exceeded"
              ? timeoutError()
              : new Error(frame.message || M.host.observerFailedPlain)
        else throw new Error(M.host.observerFrame)
      } catch (error) {
        stop(error)
      }
    }
  })
  helper.once("close", (code, signal) => {
    helperClosed = true
    clearTimeout(deadline)
    const failure =
      terminalError ??
      (!identities || !complete || code !== 0
        ? new Error(M.host.observerFailed(code, signal, stderr))
        : undefined)
    if (failure) {
      ready.reject(failure)
      exited.reject(failure)
    } else exited.resolve()
    closed.resolve()
  })
  try {
    const captured = await ready.promise
    return Object.freeze({ identities: captured, exited: exited.promise, close })
  } catch (error) {
    await close()
    throw error
  }
}

/** 交接就绪前捕获存活原始进程的身份，全程不向目标发送信号。 */
export async function watchBootstrapExit(
  bootstrapPid: number,
  ownedRedisPid: number | null,
  timeout: number,
): Promise<BootstrapExitWatch> {
  const validPid = (pid: number) => Number.isSafeInteger(pid) && pid > 1 && pid !== process.pid
  if (
    !validPid(bootstrapPid) ||
    (ownedRedisPid !== null && (!validPid(ownedRedisPid) || ownedRedisPid === bootstrapPid))
  )
    throw new Error(M.host.observePid)
  if (!Number.isSafeInteger(timeout) || timeout < 1 || timeout > 2147483647)
    throw new Error(M.host.observeTimeout)
  if (process.platform === "linux") return linuxWatch(bootstrapPid, ownedRedisPid, timeout)
  if (process.platform === "win32") return windowsWatch(bootstrapPid, ownedRedisPid, timeout)
  throw new Error(M.host.observePlatform(process.platform))
}
