import inspector from "node:inspector"
import inspectorPromises from "node:inspector/promises"
import v8 from "node:v8"
import { apply, error, objectDescriptor } from "./intrinsics.js"
import { M } from "../shared/messages.js"

const debuggerUrl = inspector.url
const signalProcess = process.kill
const debugSignal =
  process.platform === "linux" ? 10 : process.platform === "darwin" ? 30 : undefined

/** 调试器可读取闭包与控制密钥，不能与受保护宿主共用。 */
export function assertNoDebugger(): void {
  if (debuggerUrl()) throw error(M.protect.inspectorOpen)
}

/** 只关闭调试和堆导出能力；业务内建对象仍可按原方式使用。 */
export function installDebugGuard(
  seal: (object: object, key: PropertyKey, value: unknown, label: string) => void,
  deny: (operation: string, target: string) => never,
): void {
  assertNoDebugger()
  const locked = new WeakMap<object, Set<string>>()
  const block = (object: object, key: string, promise = false) => {
    const descriptor = objectDescriptor(object, key)
    if (typeof descriptor?.value !== "function") return
    let keys = locked.get(object)
    if (!keys) locked.set(object, (keys = new Set()))
    if (keys.has(key)) return
    keys.add(key)
    const call = () => deny("debug-access", key)
    seal(object, key, promise ? async () => call() : call, `debug.${key}`)
  }
  block(inspector, "open")
  block(inspectorPromises, "open")
  for (const prototype of [inspector.Session.prototype, inspectorPromises.Session.prototype]) {
    block(prototype, "connect")
    block(prototype, "connectToMainThread")
    block(prototype, "post", prototype === inspectorPromises.Session.prototype)
  }
  for (const key of ["writeHeapSnapshot", "getHeapSnapshot", "queryObjects"]) block(v8, key)
  block(process, "_debugProcess")
  const rawKill = objectDescriptor(process, "_kill")?.value
  if (typeof rawKill === "function")
    seal(
      process,
      "_kill",
      (pid: number, signal: number) => {
        if (debugSignal !== undefined && signal === debugSignal)
          return deny("debug-access", "SIGUSR1")
        return apply(rawKill, process, [pid, signal])
      },
      "process._kill.guard",
    )
  seal(
    process,
    "kill",
    (pid: number, signal?: NodeJS.Signals | number) => {
      if (signal === "SIGUSR1" || (debugSignal !== undefined && signal === debugSignal))
        return deny("debug-access", "SIGUSR1")
      return apply(signalProcess, process, [pid, signal]) as true
    },
    "process.kill.guard",
  )
}
