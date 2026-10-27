import assert from "node:assert/strict"
import test from "node:test"
import { auditModule } from "./audit-core-fixture.mjs"

const { redactAuditText } = await auditModule("audit/redaction")
const { sanitizeAuditEvent } = await auditModule("audit/event")
const { authorizeHostEvent } = await auditModule("host/event-policy")
const { parseSettings } = await auditModule("config/index")

test("persistent URLs omit credentials in pathname, userinfo, query and fragment", () => {
  const result = redactAuditText(
    "https://user:pass@api.example.invalid:8443/bot123:private/sendMessage?key=private#private wss://chat.example.invalid/session/private?access_token=private",
  )
  assert.equal(
    result,
    "https://api.example.invalid:8443/[path-redacted] wss://chat.example.invalid/[path-redacted]",
  )
  assert.doesNotMatch(result, /private|bot123|user:pass/)
  assert.equal(
    redactAuditText("https://api.example.invalid/?key=private"),
    "https://api.example.invalid/",
  )
})

test("Host authorizes pathname rules before persistent evidence removes the pathname", () => {
  const settings = parseSettings({
    rules: [
      {
        id: "private-route",
        kind: "network",
        target: "https://api.example.invalid/private/*",
        action: "restart",
      },
    ],
  })
  const raw = {
    kind: "network",
    operation: "fetch",
    target: "https://api.example.invalid/private/path-token",
    plugin: "legacy-plugin",
    action: "audit",
  }
  const authorized = authorizeHostEvent(settings, raw)
  assert.equal(authorized.action, "restart")
  assert.equal(authorized.ruleId, "private-route")
  const persisted = sanitizeAuditEvent(authorized, redactAuditText)
  assert.equal(persisted.action, "restart")
  assert.equal(persisted.ruleId, "private-route")
  assert.equal(persisted.target, "https://api.example.invalid/[path-redacted]")
  assert.equal(raw.target, "https://api.example.invalid/private/path-token")
})

test("non-URL diagnostics still redact known credential forms and enforce their text bound", () => {
  const result = redactAuditText("Bearer abc password=def api_key=ghi")
  assert.equal(result, "Bearer [redacted] password=[redacted] api_key=[redacted]")
  assert.ok(redactAuditText("x".repeat(3000)).length <= 2048)
  assert.equal(redactAuditText("https://[bad/secret"), "[invalid URL]")
})
