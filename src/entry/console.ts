// Windows 冷接管后宿主是不挂控制台的后台进程：detached 子进程拿不到原控制台句柄，
// 非 detached 子进程又会随原进程一起被结束。本进程经 cmd 拉起、挂在原控制台上，
// 持续打印宿主写入 host.log 的输出，效果与 Linux 冷接管后宿主继承终端一致。
// 原进程退出前先暂停启动它的 shell：命令提示符不会提前出现，键盘输入转给业务进程的标准输入，
// 体验与机器人直接在前台运行一致；宿主停止后恢复 shell。无法暂停时只转印输出，提示符照常回来；
// Git Bash 等伪终端会在原进程退出后结束控制台会话，此时不转印，机器人在后台运行。
// Ctrl+C 或关闭窗口请求宿主停止；再按一次 Ctrl+C 只结束本进程。宿主级更新重启时跟随新宿主。
// 用法：node dist/entry/console.js <宿主 PID> <host.log 起始位置> [就绪管道 原进程 PID 原进程父 PID]
import fs from "node:fs"
import net from "node:net"
import path from "node:path"
import { execFile, spawnSync } from "node:child_process"
import { StringDecoder } from "node:string_decoder"
import { request } from "../host/control.js"
import { stateDir } from "../shared/identity.js"
import { M } from "../shared/messages.js"

const pollInterval = 200
const relaunchWait = 120000
const inputChunk = 4000
const file = path.join(stateDir, "host.log")
const decoder = new StringDecoder("utf8")
const buffer = Buffer.alloc(64 * 1024)
const [hostArg, offsetArg, readyPipe, bootstrapArg, parentArg] = process.argv.slice(2)
const bootstrapPid = Number(bootstrapArg)
const parentPid = Number(parentArg)
let hostPid = Number(hostArg)
let offset = Number(offsetArg) || 0
let current: string | undefined
let waitingSince: number | undefined
let stopping = false
let held = false
let reading = false

// 只暂停与本进程同一控制台的直接父进程（cmd、PowerShell、npm 的 shell 或 JiuLi 守护进程），
// 且确认原进程仍在：原进程已退出时 shell 可能已回到提示符，不能再冻结它。
// 脚本运行在自己的隐藏控制台里，仅在检查时短暂附加到父进程的控制台，避免 PowerShell 改写窗口标题。
const shellScript = `
$ProgressPreference = "SilentlyContinue"
Add-Type -Namespace YunzaiGuard -Name Shell -MemberDefinition @'
[DllImport("kernel32.dll")] public static extern System.IntPtr OpenProcess(uint access, bool inherit, uint pid);
[DllImport("kernel32.dll")] public static extern bool CloseHandle(System.IntPtr handle);
[DllImport("kernel32.dll")] public static extern bool FreeConsole();
[DllImport("kernel32.dll")] public static extern bool AttachConsole(uint pid);
[DllImport("kernel32.dll")] public static extern uint GetConsoleProcessList(uint[] list, uint count);
[DllImport("ntdll.dll")] public static extern int NtSuspendProcess(System.IntPtr handle);
[DllImport("ntdll.dll")] public static extern int NtResumeProcess(System.IntPtr handle);
'@
$api = [YunzaiGuard.Shell]
$target = [uint32]$env:YUNZAI_GUARD_SHELL_PID
$result = "skip"
$attached = $true
if ($env:YUNZAI_GUARD_SHELL_ACTION -eq "hold") {
  $attached = $false
  [void]$api::FreeConsole()
  if ($api::AttachConsole($target)) {
    $list = New-Object uint32[] 256
    $count = $api::GetConsoleProcessList($list, 256)
    $attached = $count -le 256 -and ($list[0..($count - 1)] -contains [uint32]$env:YUNZAI_GUARD_SHELL_RELAY)
    [void]$api::FreeConsole()
  }
  # 伪终端会在原进程退出后结束本窗口的控制台会话，既不能暂停也无法继续转印：
  # winpty（Git Bash 中 node 的默认别名）的 winpty-agent 负责整个窗口的输入输出，暂停后窗口冻结；
  # mintty 直接运行时按 MSYS2/Cygwin 记录的前台作业分发按键，暂停 shell 后机器人收不到输入与 Ctrl+C。
  if ($attached) {
    $parent = $null
    $modules = @()
    try {
      $parent = Get-Process -Id $target
      if ($env:TERM_PROGRAM -eq "mintty") { $modules = $parent.Modules.ModuleName }
    } catch {}
    if ($parent.ProcessName -eq "winpty-agent" -or ($modules -match '^(msys-2\\.0|cygwin1)\\.dll$')) {
      $attached = $false
      $result = "pty"
    }
  }
}
$handle = [System.IntPtr]::Zero
if ($attached) { $handle = $api::OpenProcess(0x0800, $false, $target) }
if ($handle -ne [System.IntPtr]::Zero) {
  if ($env:YUNZAI_GUARD_SHELL_ACTION -eq "resume") {
    [void]$api::NtResumeProcess($handle)
    $result = "resumed"
  } elseif ($api::NtSuspendProcess($handle) -eq 0) {
    if (Get-Process -Id ([int]$env:YUNZAI_GUARD_SHELL_BOOTSTRAP) -ErrorAction SilentlyContinue) {
      $result = "held"
    } else {
      [void]$api::NtResumeProcess($handle)
    }
  }
  [void]$api::CloseHandle($handle)
}
$result
`
const powershell = path.join(
  process.env.SystemRoot || "C:\\Windows",
  "System32",
  "WindowsPowerShell",
  "v1.0",
  "powershell.exe",
)

/** 以系统 PowerShell 暂停或恢复 shell，返回脚本结果。 */
function shellArgs(action: "hold" | "resume") {
  return [
    powershell,
    [
      "-NoLogo",
      "-NoProfile",
      "-NonInteractive",
      "-ExecutionPolicy",
      "Bypass",
      "-EncodedCommand",
      Buffer.from(shellScript, "utf16le").toString("base64"),
    ],
    {
      env: {
        ...process.env,
        YUNZAI_GUARD_SHELL_ACTION: action,
        YUNZAI_GUARD_SHELL_PID: String(parentPid),
        YUNZAI_GUARD_SHELL_BOOTSTRAP: String(bootstrapPid),
        YUNZAI_GUARD_SHELL_RELAY: String(process.pid),
      },
      timeout: 15000,
      windowsHide: true,
    },
  ] as const
}

/**
 * 暂停 shell，返回 held（已暂停）、pty（mintty 等伪终端，不能暂停）或 plain（其他无法暂停的情形）。
 * 结果不明时按已暂停处理并立即恢复，宁可让提示符回来也不能把 shell 冻住。
 */
function holdShell(): Promise<"held" | "pty" | "plain"> {
  if (
    process.platform !== "win32" ||
    !process.stdin.isTTY ||
    !Number.isSafeInteger(parentPid) ||
    parentPid <= 0 ||
    !Number.isSafeInteger(bootstrapPid) ||
    bootstrapPid <= 0
  )
    return Promise.resolve("plain")
  return new Promise(resolve => {
    const [command, args, options] = shellArgs("hold")
    execFile(command, args, options, (error, stdout) => {
      const result = String(stdout).trim()
      if (!error && (result === "held" || result === "pty")) return resolve(result)
      if (!error && result === "skip") return resolve("plain")
      held = true
      releaseShell()
      resolve("plain")
    })
  })
}

/** 恢复被暂停的 shell，同步执行以便在退出流程中调用。 */
function releaseShell(): void {
  if (!held) return
  held = false
  const [command, args, options] = shellArgs("resume")
  spawnSync(command, args, { ...options, stdio: "ignore" })
}

/** 把已打开文件从 start 起的内容写到控制台，返回读到的末尾位置。 */
function copy(handle: number, start: number): number {
  for (;;) {
    const count = fs.readSync(handle, buffer, 0, buffer.length, start)
    if (!count) return start
    start += count
    const text = decoder.write(buffer.subarray(0, count))
    if (text) process.stdout.write(text)
  }
}

/** 打开文件执行读取，读完立即关闭：长期占用会妨碍宿主轮转时删除 host.log。 */
function withFile<T>(target: string, read: (handle: number) => T): T | undefined {
  let handle: number
  try {
    handle = fs.openSync(target, "r")
  } catch {
    return undefined
  }
  try {
    return read(handle)
  } finally {
    fs.closeSync(handle)
  }
}

/** 打印 host.log 新增的内容；宿主轮转后先补完移到 host.log.1 的尾部，再从新文件开头读。 */
function drain(): void {
  withFile(file, handle => {
    const info = fs.fstatSync(handle)
    const identity = `${info.ino}:${info.birthtimeMs}`
    // 新文件可能复用旧文件的 inode，长度回退同样视为轮转。
    if ((current !== undefined && identity !== current) || info.size < offset) {
      withFile(`${file}.1`, previous => copy(previous, offset))
      offset = 0
    }
    current = identity
    offset = copy(handle, offset)
  })
}

/** 判断进程是否仍在运行。 */
function alive(pid: number): boolean {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM"
  }
}

/** 读取控制信息中另一个正在运行的宿主。 */
function nextHost(): number | undefined {
  try {
    const pid = (
      JSON.parse(fs.readFileSync(path.join(stateDir, "control.json"), "utf8")) as {
        hostPid?: unknown
      }
    ).hostPid
    return typeof pid === "number" && pid !== hostPid && alive(pid) ? pid : undefined
  } catch {
    return undefined
  }
}

/** 键盘输入按行转给宿主，由宿主写入业务进程的标准输入；超长的行分段发送。 */
function forwardInput(): void {
  let queue: Promise<unknown> = Promise.resolve()
  process.stdin.setEncoding("utf8")
  process.stdin.on("error", () => {})
  process.stdin.on("data", (text: string) => {
    for (const line of text.replace(/\r\n/g, "\n").split(/(?<=\n)/))
      for (let index = 0; index < line.length; index += inputChunk) {
        const data = line.slice(index, index + inputChunk)
        queue = queue.then(() => request("input", { data })).catch(() => {})
      }
  })
}

/** 首次 Ctrl+C 与 cli stop 一样请求宿主停止，之后照常打印停止过程；再按一次立即结束本进程。 */
function interrupt(): void {
  if (stopping) process.exit(130)
  stopping = true
  process.stdout.write(`${M.entry.consoleStopping}\n`)
  request("stop").catch((error: Error) =>
    process.stdout.write(`${M.entry.consoleStopFailed(error.message)}\n`),
  )
}

/** 宿主不再运行：打印剩余输出，恢复 shell 后退出。 */
function finish(): void {
  const rest = decoder.end()
  if (rest) process.stdout.write(rest)
  releaseShell()
  process.exit(0)
}

process.stdout.on("error", () => process.exit(0))
process.on("exit", releaseShell)
process.on("SIGINT", interrupt)
process.on("SIGBREAK", interrupt)
// 关闭窗口：Windows 在数秒后强制结束本进程，停止请求只需送达，宿主自行完成停止。
process.on("SIGHUP", () => {
  stopping = true
  request("stop").catch(() => {})
})
const mode = await holdShell()
held = mode === "held"
// 告知原进程已挂上控制台，以及 shell 的处理方式；原进程退出时连接随之断开，不影响本进程。
const report = readyPipe
  ? net
      .connect(readyPipe, function (this: net.Socket) {
        this.end(`${mode}\n`)
      })
      .on("error", () => {})
  : undefined
// 伪终端在原进程退出后就结束本窗口的控制台会话，无法继续转印：报告后即退出，机器人在后台运行，
// 不能留到会话结束时把它当作关闭窗口去停止机器人。
if (mode === "pty") {
  if (report)
    await new Promise(resolve => {
      report.on("close", resolve)
      setTimeout(resolve, 5000).unref()
    })
  process.exit(0)
}
report?.unref()
const timer = setInterval(() => {
  // 原进程退出前它自己的标准输入适配器还在读键盘，之后才接管输入。
  if (held && !reading && !alive(bootstrapPid)) {
    reading = true
    forwardInput()
  }
  // 先确认存活再读取：宿主退出前写下的最后几行也会打印出来。
  const running = alive(hostPid)
  drain()
  if (running) return
  const next = nextHost()
  if (next) {
    hostPid = next
    waitingSince = undefined
    return
  }
  // 宿主级更新留下待确认记录，由旧宿主退出时拉起新宿主，等它写出控制信息。
  waitingSince ??= Date.now()
  if (
    !stopping &&
    Date.now() - waitingSince < relaunchWait &&
    fs.existsSync(path.join(stateDir, "update-verify.json"))
  )
    return
  clearInterval(timer)
  finish()
}, pollInterval)
