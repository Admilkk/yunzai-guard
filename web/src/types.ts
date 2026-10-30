import type { ConfigChange } from "./lib/diff"

export type RuleAction = "audit" | "deny" | "restart"
export interface Rule {
  id: string
  kind?: string | string[]
  plugin?: string
  operation?: string
  target?: string
  action: RuleAction
}
export type Draft = Record<string, any> & { rules?: Rule[] }
export interface SettingsApplyState {
  status: "applied" | "applying" | "pending-restart" | "failed"
  mode: "live" | "worker-reload" | "host-restart"
  revision: number
  liveFields: string[]
  reloadFields: string[]
  restartFields: string[]
  error?: string
}
export interface PluginPermission {
  id: string
  label: string
  action: RuleAction
  ruleId?: string
  conditional: boolean
  enforcement: "entrypoint" | "after-change" | string
  sample: { kind: string; operation: string; target: string }
}
export interface PluginRecord {
  id: string
  description?: string
  reserved: boolean
  stats: { total: number; audit: number; deny: number; restart: number; lastEventAt?: number }
  statsScope?: "unavailable" | "retained-window" | "retained-page" | string
  permissions: PluginPermission[]
  rules: Array<Rule & { index: number }>
  sandbox?: { enabled: boolean; config?: Record<string, any> }
}
export interface AuditEntry {
  id: string
  time: number
  type: string
  plugin: string
  kind: string
  operation: string
  target: string
  action: RuleAction | "info"
  ruleId?: string
  blocked?: boolean
  details: Record<string, any>
}
export interface ConsoleValue {
  booting: boolean
  loading: boolean
  connected: boolean
  configurationLoaded: boolean
  configurationError: string | null
  settingsRevision?: string
  /** settings.yaml 原文，原始配置页据此编辑。 */
  settingsText?: string
  error: string
  meta: Record<string, any> | null
  session: Record<string, any> | null
  overview: Record<string, any> | null
  plugins: PluginRecord[]
  draft: Draft
  dirty: boolean
  changes: ConfigChange[]
  saving: boolean
  pendingRestart: boolean
  apply?: SettingsApplyState
  rawText: string | null
  update: (change: (document: Draft) => void) => boolean
  setRawText: (value: string | null) => void
  commitRaw: () => boolean
  requestCode: () => Promise<void>
  login: (code: string, remember: boolean) => Promise<void>
  logout: () => Promise<void>
  reload: (preserve?: boolean) => Promise<void>
  save: () => Promise<void>
  validate: () => Promise<void>
  reset: () => void
}
