/** 生成新的规则 id。 */
export function newRuleId(): string {
  const bytes = new Uint8Array(6)
  globalThis.crypto.getRandomValues(bytes)
  return `rule-${Array.from(bytes, value => value.toString(16).padStart(2, "0")).join("")}`
}
