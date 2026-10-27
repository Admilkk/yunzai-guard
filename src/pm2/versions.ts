const minimum = [6n, 0n, 14n] as const

/**
 * 接受 >= 6.0.14 的任意 SemVer，包括更高版本的预发布号（如 7.1.0-rc.1）；
 * 6.0.14 自身的预发布号早于正式版，仍拒绝。版本号只是门槛，
 * 守护进程结构与身份仍须另行检查。
 */
export function isSupportedPm2Version(value: unknown): boolean {
  if (typeof value !== "string" || value.length > 128) return false
  const match =
    /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/.exec(
      value,
    )
  if (!match || match[0] !== value) return false
  const core = [BigInt(match[1]!), BigInt(match[2]!), BigInt(match[3]!)]
  for (let index = 0; index < 3; index++) {
    if (core[index]! > minimum[index]!) return true
    if (core[index]! < minimum[index]!) return false
  }
  return match[4] === undefined
}
