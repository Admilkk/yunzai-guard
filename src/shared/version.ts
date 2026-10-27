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
    if (part !== minimum[index]) return part > minimum[index]!
  }
  return true
}
