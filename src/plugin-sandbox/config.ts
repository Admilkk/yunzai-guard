import { action, boolean, keys, number, object, rule, string } from "../config/validation.js"
import type { SandboxCapability, SandboxLimits, SandboxPlugin, SandboxSettings } from "./types.js"
import { parseNativeSandbox } from "../native-sandbox/config.js"
import { M } from "../shared/messages.js"

const defaults: SandboxLimits = {
  timeoutMs: 1000,
  memoryMiB: 16,
  violationAction: "deny",
  hookAction: "deny",
}

/** 解析受限脚本的资源限额。 */
function limits(
  source: Record<string, unknown>,
  inherited: SandboxLimits,
  location: string,
): SandboxLimits {
  const violationAction =
    source.violationAction === undefined ? inherited.violationAction : source.violationAction
  if (violationAction !== "deny" && violationAction !== "restart")
    throw new TypeError(M.pluginSandbox.violationAction(location))
  return {
    timeoutMs: number(source.timeoutMs, inherited.timeoutMs, `${location}.timeoutMs`, 100, 5000),
    memoryMiB: number(source.memoryMiB, inherited.memoryMiB, `${location}.memoryMiB`, 4, 64),
    violationAction,
    hookAction: action(source.hookAction, inherited.hookAction, `${location}.hookAction`),
  }
}

/** 解析一个受限脚本插件配置。 */
function plugin(
  value: unknown,
  inherited: SandboxLimits,
  location: string,
  legacy: boolean,
): SandboxPlugin {
  const source = object(value, location)
  keys(
    source,
    legacy
      ? ["id", "match", "capabilities"]
      : [
          "id",
          "enabled",
          "match",
          "capabilities",
          "timeoutMs",
          "memoryMiB",
          "violationAction",
          "hookAction",
          "rules",
        ],
    location,
  )
  const id = string(source.id, `${location}.id`, 48)
  if (!/^[a-z][a-z0-9-]{0,47}$/.test(id) || /^(con|prn|aux|nul|com[0-9]|lpt[0-9])$/.test(id))
    throw new TypeError(M.pluginSandbox.id(location))
  const match = string(source.match, `${location}.match`, 128)
  if (
    !Array.isArray(source.capabilities) ||
    source.capabilities.length > 3 ||
    source.capabilities.some(capability => !["reply", "log", "writeText"].includes(capability)) ||
    new Set(source.capabilities).size !== source.capabilities.length
  )
    throw new TypeError(M.pluginSandbox.capabilities(location))
  const inputRules = source.rules === undefined ? [] : source.rules
  if (!Array.isArray(inputRules) || inputRules.length > 1000)
    throw new TypeError(M.pluginSandbox.rules(location))
  const rules = inputRules.map((item, index) => rule(item, `${location}.rules[${index}]`))
  if (new Set(rules.map(item => item.id)).size !== rules.length)
    throw new TypeError(M.pluginSandbox.rulesDuplicate(location))
  for (const item of rules) {
    if (Array.isArray(item.kind)) Object.freeze(item.kind)
    Object.freeze(item)
  }
  const result: SandboxPlugin = {
    id,
    enabled: boolean(source.enabled, true, `${location}.enabled`),
    match,
    capabilities: [...source.capabilities] as SandboxCapability[],
    ...limits(source, inherited, location),
    rules,
  }
  Object.freeze(result.capabilities)
  Object.freeze(result.rules)
  return Object.freeze(result)
}

/** 统一规范新旧输入；声明冲突时不能静默选择执行模式。 */
export function parsePluginSandbox(newValue?: unknown, legacyValue?: unknown): SandboxSettings {
  if (newValue !== undefined && legacyValue !== undefined)
    throw new TypeError(M.pluginSandbox.legacyConflict)
  const legacy = legacyValue !== undefined
  const location = legacy ? "settings.strictJs" : "settings.pluginSandbox"
  const value = legacy ? legacyValue : newValue
  const source = object(value === undefined ? {} : value, location)
  keys(
    source,
    legacy
      ? ["plugins", "timeoutMs", "memoryMiB", "violationAction"]
      : [
          "defaults",
          "plugins",
          "native",
          "timeoutMs",
          "memoryMiB",
          "violationAction",
          "hookAction",
        ],
    location,
  )
  let inputDefaults = source
  if (!legacy) {
    const fields = ["timeoutMs", "memoryMiB", "violationAction", "hookAction"]
    const flattened = fields.some(key => source[key] !== undefined)
    if (source.defaults !== undefined && flattened)
      throw new TypeError(M.pluginSandbox.defaultsConflict(location))
    inputDefaults = object(
      flattened
        ? Object.fromEntries(fields.map(key => [key, source[key]]))
        : source.defaults === undefined
          ? {}
          : source.defaults,
      `${location}.defaults`,
    )
    keys(
      inputDefaults,
      ["timeoutMs", "memoryMiB", "violationAction", "hookAction"],
      `${location}.defaults`,
    )
  }
  const inherited = limits(inputDefaults, defaults, legacy ? location : `${location}.defaults`)
  const inputPlugins = source.plugins === undefined ? [] : source.plugins
  if (!Array.isArray(inputPlugins) || inputPlugins.length > 16)
    throw new TypeError(M.pluginSandbox.plugins(location))
  const plugins = inputPlugins.map((item, index) =>
    plugin(item, inherited, `${location}.plugins[${index}]`, legacy),
  )
  if (new Set(plugins.map(item => item.id)).size !== plugins.length)
    throw new TypeError(M.pluginSandbox.pluginsDuplicate(location))
  Object.freeze(plugins)
  return Object.freeze({ ...inherited, plugins, native: parseNativeSandbox(source.native) })
}
