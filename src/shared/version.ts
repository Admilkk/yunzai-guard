/** 判断 `X.Y.Z` 正式版本号是否不低于下限；其他格式一律视为不满足。 */
export function atLeastVersion(
  value: unknown,
  minimum: readonly [number, number, number],
): boolean {
  if (typeof value !== "string" || value.length > 64) return false
  const match = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.exec(value)
  if (!match) return false
  for (let index = 0; index < 3; index++) {
    const part = Number(match[index + 1])
    if (part !== minimum[index]) return part > minimum[index]
  }
  return true
}

const semver = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z.-]{1,32}))?$/

/** 解析 `X.Y.Z[-预发布]` 版本号；其他格式返回 undefined。 */
export function parseVersion(
  value: unknown,
): { core: [number, number, number]; pre: string[] } | undefined {
  if (typeof value !== "string" || value.length > 64) return undefined
  const match = semver.exec(value.replace(/^v/, ""))
  if (!match) return undefined
  return {
    core: [Number(match[1]), Number(match[2]), Number(match[3])],
    pre: match[4] ? match[4].split(".") : [],
  }
}

/** 按语义化版本比较，返回正数表示 a 更新；任一版本无法解析时返回 undefined。 */
export function compareVersions(a: unknown, b: unknown): number | undefined {
  const left = parseVersion(a)
  const right = parseVersion(b)
  if (!left || !right) return undefined
  for (let index = 0; index < 3; index++) {
    const difference = left.core[index] - right.core[index]
    if (difference) return difference
  }
  if (!left.pre.length || !right.pre.length) return right.pre.length - left.pre.length
  for (let index = 0; index < Math.max(left.pre.length, right.pre.length); index++) {
    const x = left.pre[index]
    const y = right.pre[index]
    if (x === undefined) return -1
    if (y === undefined) return 1
    const numeric = /^\d+$/.test(x) && /^\d+$/.test(y)
    if (numeric && Number(x) !== Number(y)) return Number(x) - Number(y)
    if (!numeric && x !== y) return x < y ? -1 : 1
  }
  return 0
}
