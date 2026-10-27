import assert from "node:assert/strict"
import test from "node:test"
import { runJiuliSandboxAcceptance } from "./helpers/jiuli-sandbox-acceptance.mjs"

const enabled =
  process.env.GUARD_TEST_JIULI_SANDBOX === "1" && ["win32", "linux"].includes(process.platform)

test(
  "玖璃旧插件、原生类和 DSL 在独立系统沙箱内分发并正确回收",
  {
    skip: enabled
      ? false
      : "requires GUARD_TEST_JIULI_SANDBOX=1, GUARD_JIULI_SOURCE and Windows AppContainer/Linux bubblewrap",
    timeout: 420000,
  },
  async t => {
    const report = await runJiuliSandboxAcceptance()
    t.diagnostic(`Evidence: ${report.receipt}`)
    assert.equal(report.status, "passed", report.error)
    assert.equal(report.cleanupConfirmed, true, report.cleanupError)
  },
)
