import type { GuardAction, GuardRule } from "../shared/types.js";
import type { NativeSandboxSettings } from "../native-sandbox/types.js";
export type SandboxCapability = "reply" | "log" | "writeText";
export interface SandboxLimits {
    timeoutMs: number;
    memoryMiB: number;
    violationAction: "deny" | "restart";
    hookAction: GuardAction;
}
/** 插件描述通过校验后，在执行前已解析全部继承配置。 */
export interface SandboxPlugin extends SandboxLimits {
    id: string;
    enabled: boolean;
    match: string;
    capabilities: SandboxCapability[];
    rules: GuardRule[];
}
export interface SandboxSettings extends SandboxLimits {
    plugins: SandboxPlugin[];
    native: NativeSandboxSettings;
}
export interface SandboxSource extends SandboxPlugin {
    source: string;
    sha256: string;
}
export interface SandboxEvent {
    message: string;
    userId: string;
    groupId: string;
    selfId: string;
    isGroup: boolean;
}
export interface SandboxAction {
    capability: SandboxCapability;
    text: string;
    file?: string;
}
export interface SandboxAttempt {
    operation: string;
    target: string;
}
export type SandboxResult = ({
    ok: true;
    actions: SandboxAction[];
} | {
    ok: false;
    code: string;
}) & {
    attempts?: SandboxAttempt[];
};
