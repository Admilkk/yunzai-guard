import path from "node:path"
import { newWeakMap, objectDefine, stringLower, weakMapGet, weakMapSet } from "./intrinsics.js"

const capturedProcess = process
const windows = process.platform === "win32"
const systemCmd = path.win32.join(process.env.SystemRoot || "C:\\Windows", "System32", "cmd.exe")
const implicitShells = newWeakMap<object, string>()
const customImplicitShells = newWeakMap<object, boolean>()
// Node 的 exec 会克隆 options，但保留 env；只传递同一个系统 cmd 的私有来源记录。
const implicitEnvironments = newWeakMap<object, string>()
const NativeTypeError = TypeError

function comparable(value: string): string {
  let result = ""
  for (let index = 0; index < value.length; index++)
    result += value[index] === "/" ? "\\" : value[index]
  return stringLower(result)
}

const comparableSystemCmd = comparable(systemCmd)

function recorded(records: WeakMap<object, string>, object: unknown, value: string): boolean {
  return object !== null && typeof object === "object" && weakMapGet(records, object) === value
}

/** 固定 Windows 实际使用的隐式 shell，环境和归因回调后续变化不再影响启动。 */
export function snapshotCommandShell(
  operation: string,
  options: Record<PropertyKey, any>,
  previous?: unknown,
  previousEnvironment?: unknown,
): void {
  if (!windows) return
  const supplied = options.shell
  let implicit = false
  if (typeof supplied === "string") {
    implicit =
      recorded(implicitShells, previous, supplied) ||
      recorded(implicitEnvironments, previousEnvironment, supplied)
  } else if (operation === "exec" || operation === "execSync" || supplied === true) {
    const requested = capturedProcess.env.comspec
    if (requested && typeof requested !== "string") {
      const error = new NativeTypeError('The "process.env.comspec" property must be a string')
      objectDefine(error, "code", { value: "ERR_INVALID_ARG_TYPE" })
      throw error
    }
    const shell = requested || "cmd.exe"
    implicit = comparable(shell) === "cmd.exe" || comparable(shell) === comparableSystemCmd
    options.shell = implicit ? systemCmd : shell
    if (!implicit) weakMapSet(customImplicitShells, options, true)
  }
  if (!implicit) return
  options.shell = systemCmd
  weakMapSet(implicitShells, options, systemCmd)
  if (options.env !== null && typeof options.env === "object")
    weakMapSet(implicitEnvironments, options.env, systemCmd)
}

/** 只豁免本次快照记录且 shell 值未变化的系统 cmd，调用者属性不能伪造来源。 */
export function isImplicitSystemShell(options: unknown, shell: unknown): boolean {
  return windows && typeof shell === "string" && recorded(implicitShells, options, shell)
}

export function isCustomImplicitShell(options: unknown): boolean {
  return (
    options !== null &&
    typeof options === "object" &&
    weakMapGet(customImplicitShells, options) === true
  )
}
