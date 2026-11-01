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
export type SettingsPlan = Pick<SettingsApplyState, "liveFields" | "reloadFields" | "restartFields">
export interface SavedOperation {
  id: string
  title: string
  time: number
  revision: string
  beforeRevision: string
  status: SettingsApplyState["status"] | "unknown"
  canUndo: boolean
  canRestoreBefore?: boolean
  canRestore: boolean
  changes: ConfigChange[]
}
export interface TaskCase {
  id: string
  plugin: string
  kind: string
  operation: string
  target: string
  ruleId?: string
  currentRuleId?: string
  action: "deny" | "restart"
  currentAction?: RuleAction
  count: number
  lastAt: number
  entry: AuditEntry
  uncertain: boolean
  acknowledged: boolean
}
export interface TaskCases {
  revision: string
  cases: TaskCase[]
  coverage: {
    complete: boolean
    truncated: boolean
    sampled: number
    errors: string[]
    lossReported: boolean
  }
}
export interface PluginDiagnosis {
  plugin: string
  revision: string
  findings: Array<{
    kind: "blocked" | "configuration" | "startup" | "unknown"
    title: string
    detail: string
    scope: "plugin" | "global"
    action:
      "review-cases" | "retry-apply" | "wait" | "restart-host" | "inspect-startup" | "view-logs"
    caseIds?: string[]
    evidence?: AuditEntry[]
  }>
  cases: TaskCase[]
  coverage: TaskCases["coverage"]
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
  lastOperation?: SavedOperation
  operations: SavedOperation[]
  historyError: string
  canUndo: boolean
  quickChange: (
    title: string,
    summary: string,
    change: (document: Draft) => void,
    mode?: "apply" | "draft",
  ) => Promise<false | { staged: boolean; revision?: string }>
  undoLast: () => Promise<void>
  restoreOperation: (id: string, target?: "before" | "after") => Promise<boolean>
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
