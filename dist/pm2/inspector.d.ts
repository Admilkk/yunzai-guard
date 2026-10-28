import { type NativeIdentityAdapter } from "../native-process/index.js";
export interface Listener {
    host: string;
    port: number;
}
interface InspectorEndpoint {
    url: string;
    connectUrl: string;
    wildcard: boolean;
}
export interface InspectorDeadline {
    remainingMs(): number;
}
export interface ParentInspectorOptions {
    deadline?: InspectorDeadline;
    /** 仅供宿主使用的适配器；不根据客体数据帧或进程标签创建。 */
    nativeIdentity?: NativeIdentityAdapter;
    /** 仅提供端点观察接口；激活始终由原生父进程会话负责。 */
    discover?: (pid: number, deadline: InspectorDeadline) => Promise<InspectorEndpoint | undefined>;
}
/** 创建 Inspector 操作的截止时间。 */
export declare function inspectorDeadline(budgetMs: number): InspectorDeadline;
export interface ParentProof {
    pid: number;
    created: string;
    commandLine: string;
}
export interface DaemonIdentity {
    pid: number;
    main: string;
    pm2Root: string;
    name: string;
    version: string;
    godCached: boolean;
    inspectorUrl: string;
}
/** 解析父进程身份记录。 */
export declare function parseParentRecord(value: unknown, pid: number): ParentProof;
/** 解析 Windows 监听端口列表。 */
export declare function parseWindowsListeners(text: string, pid: number): Listener[];
/** 解析 Inspector 回复。 */
export declare function parseInspectorReply(text: string): {
    id?: number;
    result?: unknown;
    error?: unknown;
} | null;
/** 运行时描述不可信；只保留简短原因，不保留表达式或堆栈。 */
export declare function safeRuntimeError(details: unknown): string;
/** 拒绝会将新激活端点暴露到非回环地址的可见调试配置。 */
export declare function assertLoopbackInspectorArguments(commandLine: string): void;
/** 只读取当前直接父进程身份，不通过全局 PM2 socket 选择守护进程。 */
export declare function readParentProof(): ParentProof;
/** 确认父进程身份未变。 */
export declare function assertParentUnchanged(proof: ParentProof): void;
/** 确认父进程为 PM2 daemon。 */
export declare function assertParentProof(proof: ParentProof, home: string | undefined): void;
/** 规范化 Inspector 宣告的端点。 */
export declare function normalizeInspectorEndpoint(advertised: string, listener: Listener): InspectorEndpoint | null;
/** 判断宣告端点与实际监听是否为同一目标。 */
export declare function sameInspectorTarget(advertised: string, actual: string, wildcard: boolean): boolean;
export declare class ParentInspector {
    private socket;
    private endpointUrl;
    readonly opened: boolean;
    private proof;
    readonly wildcard: boolean;
    private connectUrl;
    private nativeParent;
    private deadline;
    private serial;
    private confirmationSerial;
    private identityValidated;
    private closePromise?;
    private pending;
    /** 创建 Inspector 会话。 */
    private constructor();
    /** 调试端点地址。 */
    get url(): string;
    /** 核验父进程并连接其 Inspector。 */
    static connect(proof: ParentProof, options?: ParentInspectorOptions): Promise<ParentInspector>;
    /** 在 daemon 中求值表达式。 */
    evaluate<T>(expression: string): Promise<T>;
    /** 读取 daemon 身份。 */
    identity(): Promise<DaemonIdentity>;
    /** 复查父进程身份与剩余时间。 */
    verifyParent(): Promise<void>;
    /** 关闭会话，重复调用返回同一个 Promise。 */
    close(closeOwnedEndpoint?: () => Promise<void>): Promise<void>;
    /** 执行实际关闭。 */
    private closeOnce;
    /** 断开连接并关闭本会话打开的端点。 */
    private closeEndpoint;
}
export {};
