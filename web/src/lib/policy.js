/** 逐插件权限类别；id 与服务端 web/monitor.ts 的采样一一对应。 */
export const categories = [
  { id: "network", label: "网络外联", short: "网络", kind: "network" },
  { id: "listen", label: "端口监听", short: "监听", kind: "listen" },
  { id: "process", label: "子进程", short: "命令", kind: "process" },
  { id: "worker", label: "工作线程", short: "线程", kind: "process", operation: "worker" },
  { id: "filesystem", label: "文件写入", short: "文件", kind: "filesystem" },
  { id: "native", label: "原生扩展", short: "原生", kind: "native" },
  { id: "plugin", label: "插件调用", short: "调用", kind: "plugin", operation: "plugin.call" },
  {
    id: "hook",
    label: "函数修改",
    short: "Hook",
    kind: "integrity",
    operation: "protected-target-change",
  },
]

export function ruleId(plugin, category) {
  let hash = 2166136261
  for (const char of plugin) hash = Math.imul(hash ^ char.charCodeAt(0), 16777619)
  return `panel.${plugin.slice(0, 65)}.${(hash >>> 0).toString(36)}.${category.id}`
}

export function ownRule(rules, plugin, category) {
  return rules.find(item => item.id === ruleId(plugin, category) && item.plugin === plugin)
}

export function setPermission(document, plugin, category, action) {
  if (/[*?]/.test(plugin)) throw new Error("插件名称不能包含通配符")
  if (plugin.toLowerCase() === "yunzai-guard") throw new Error("Guard 自保护")
  if (!["inherit", "audit", "deny", "restart"].includes(action)) throw new Error("无效动作")
  const rules = (document.rules ??= [])
  const id = ruleId(plugin, category)
  const at = rules.findIndex(item => item.id === id && item.plugin === plugin)
  if (at >= 0) rules.splice(at, 1)
  if (action === "inherit") return
  rules.unshift({
    id,
    plugin,
    kind: category.kind,
    ...(category.operation ? { operation: category.operation } : {}),
    action,
  })
  const process = categories.find(item => item.id === "process")
  const worker = categories.find(item => item.id === "worker")
  const processAt = rules.findIndex(
    item => item.id === ruleId(plugin, process) && item.plugin === plugin,
  )
  const workerAt = rules.findIndex(
    item => item.id === ruleId(plugin, worker) && item.plugin === plugin,
  )
  if (processAt >= 0 && workerAt > processAt)
    rules.splice(processAt, 0, rules.splice(workerAt, 1)[0])
}

export function nativeEntry(document, id) {
  return document.pluginSandbox?.native?.plugins?.find(item => item.id === id)
}

export function enableNative(document, id) {
  const native = ((document.pluginSandbox ??= {}).native ??= { plugins: [] })
  const found = nativeEntry(document, id)
  if (found) {
    found.enabled = true
    return found
  }
  const entry = {
    id,
    enabled: true,
    timeoutMs: 10000,
    network: "none",
    hookAction: "deny",
    adapters: false,
    allowCoreRestart: false,
    writablePaths: [],
    writableFiles: [],
    redis: { read: [], write: [] },
  }
  native.plugins.push(entry)
  return entry
}
