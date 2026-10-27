import assert from "node:assert/strict"
import test from "node:test"
import { parseSettings } from "../dist/config/index.js"
import { evaluatePolicy } from "../dist/config/policy.js"
import { categories, setPermission, enableNative } from "../web/src/lib/policy.js"

const category = id => categories.find(item => item.id === id)
const decision = (document, plugin, kind, operation = "fetch") =>
  evaluatePolicy(parseSettings(document), { plugin, kind, operation, target: "fixture-target" })

test("单独与批量权限仅覆盖指定插件，继承恢复已有全局规则", () => {
  const global = { id: "global-network", kind: "network", action: "audit" }
  const document = { rules: [global] }
  for (const plugin of ["alpha-plugin", "beta-plugin"])
    setPermission(document, plugin, category("network"), "deny")
  assert.equal(decision(document, "alpha-plugin", "network").action, "deny")
  assert.equal(decision(document, "beta-plugin", "network").action, "deny")
  assert.equal(decision(document, "other-plugin", "network").action, "audit")
  assert.equal(decision(document, "alpha-plugin-extra", "network").action, "audit")
  assert.equal(document.rules.at(-1), global)
  setPermission(document, "alpha-plugin", category("network"), "inherit")
  assert.equal(decision(document, "alpha-plugin", "network").ruleId, "global-network")
  assert.equal(decision(document, "beta-plugin", "network").action, "deny")
  assert.throws(() => setPermission(document, "plugin-*", category("network"), "deny"), /通配符/)
})

test("Worker 精确策略保持优先，重复启用沙箱不生成重复配置", () => {
  const document = { rules: [] }
  setPermission(document, "alpha-plugin", category("worker"), "audit")
  setPermission(document, "alpha-plugin", category("process"), "deny")
  assert.equal(decision(document, "alpha-plugin", "process", "worker").action, "audit")
  assert.equal(decision(document, "alpha-plugin", "process", "exec").action, "deny")
  setPermission(document, "alpha-plugin", category("process"), "restart")
  assert.equal(decision(document, "alpha-plugin", "process", "worker").action, "audit")
  assert.equal(decision(document, "alpha-plugin", "process", "exec").action, "restart")
  const entry = enableNative(document, "alpha-plugin")
  entry.enabled = false
  assert.equal(enableNative(document, "alpha-plugin"), entry)
  assert.equal(document.pluginSandbox.native.plugins.length, 1)
  assert.equal(entry.enabled, true)
  assert.doesNotThrow(() => parseSettings(document))
})
