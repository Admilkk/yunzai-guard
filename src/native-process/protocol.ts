export const nativeIdentityProtocol = 1 as const
export const nativeIdentityLimits = {
  frameBytes: 65536,
  stderrBytes: 65536,
  scopeEntries: 256,
  requests: 64,
  maximumBudgetMs: 2147483647,
} as const

export type NativeBirth =
  | { kind: "windows-filetime-100ns"; value: string }
  | { kind: "linux-proc-start-ticks"; value: string; bootId: string; pidNamespace: string }
export interface NativeIdentity {
  pid: number
  birth: NativeBirth
}
export interface CapturedRecord {
  recordId: string
  identity: NativeIdentity
  parentPid: number
}
export type RefusalCode =
  | "UNSUPPORTED_PLATFORM_OR_ARCH"
  | "UNSUPPORTED_NODE_PROFILE"
  | "NATIVE_PRIMITIVE_UNAVAILABLE"
  | "ACCESS_DENIED"
  | "ROOT_OR_PARENT_CHANGED"
  | "IDENTITY_UNKNOWN"
  | "RELATIONSHIP_UNKNOWN"
  | "SIGNAL_HANDLER_UNAVAILABLE_OR_UNKNOWN"
  | "INSPECTOR_ACTIVATION_DISABLED"
  | "ACTIVATION_ALREADY_ATTEMPTED"
  | "STATE_OR_REQUEST_INVALID"
  | "FRAME_OR_SCOPE_LIMIT"
  | "DEADLINE"
  | "NATIVE_OPERATION_UNKNOWN"
export type NativeFailureResult =
  "refused-before-action" | "failed" | "started-unconfirmed" | "unknown"
export class NativeIdentityError extends Error {
  /** 创建带拒绝原因码的原生身份错误。 */
  constructor(
    public readonly code: RefusalCode,
    public readonly result: NativeFailureResult = "unknown",
    public readonly systemCode?: number,
  ) {
    super(`Native process identity: ${code} (${result})`)
    this.name = "NativeIdentityError"
  }
}
export interface QualifiedNodeProfile {
  id: string
  platform: "win32" | "linux"
  architecture: string
  verification: "qualified-target-image"
  inspectorActivation:
    "windows-held-handle-debug-mapping" | "linux-held-pidfd-sigusr1-under-trusted-stable-handler"
}
export interface InspectorActivated {
  type: "inspector-activated"
  parentBindingToken: string
  actionSerial: number
  originalParent: NativeIdentity
  result: "native-action-completed" | "started-unconfirmed"
}
export interface InspectorParentConfirmed {
  type: "inspector-parent-confirmed"
  parentBindingToken: string
  connectionSerial: number
  parent: NativeIdentity
  originalLive: true
}
export interface CapturedTerminated {
  type: "captured-terminated"
  rootBindingToken: string
  results: Array<{
    recordId: string
    result: "original-exited" | "terminated-and-exited" | "identity-changed" | "unknown"
    systemCode?: number
  }>
}
export interface OriginalWindowsChildProbe {
  readonly pid: number
  probeOriginalNow(): { live: true; probeSerial: number } | { live: false; reason: string }
  retire(): void
}
export interface OriginalChildLedger {
  commitVerifiedSnapshot(root: NativeIdentity, records: readonly CapturedRecord[]): void
}
export interface NativeRootScopeSession {
  readonly root: NativeIdentity
  captureInto(ledger: OriginalChildLedger): Promise<{
    observation: "complete" | "incomplete"
    committed: boolean
    unknownCount: number
    records: readonly CapturedRecord[]
    reason?: RefusalCode
  }>
  retireCapture(): void
  terminateCaptured(recordIds: readonly string[]): Promise<CapturedTerminated>
  close(): Promise<void>
}
export interface NativeInspectorParentSession {
  readonly parent: NativeIdentity
  readonly activationProfile?: QualifiedNodeProfile
  readonly activationAvailable: boolean
  readonly unavailableReason?: RefusalCode
  activateOnce(): Promise<InspectorActivated>
  confirmAfterWebSocket(connectionSerial: number): Promise<InspectorParentConfirmed>
  close(): Promise<void>
}
export interface NativeIdentityAdapter {
  openRoot(
    probe: OriginalWindowsChildProbe,
    remainingBudgetMs: number,
  ): Promise<NativeRootScopeSession>
  openInspectorParent(options: {
    expectedParent?: NativeIdentity
    remainingBudgetMs: number
  }): Promise<NativeInspectorParentSession>
}
export interface NativeIdentityOptions {
  bundleRoot?: string
}
