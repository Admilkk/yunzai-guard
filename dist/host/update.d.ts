import type { GuardSettings } from "../shared/types.js";
import { swapPackage, type StagedRelease } from "../update/install.js";
type UpdateSettings = GuardSettings["update"];
type Phase = "idle" | "downloading" | "installing" | "restarting" | "failed";
export interface UpdateSummary {
    version: string;
    name: string;
    notes: string;
    url: string;
    publishedAt: string;
}
export interface UpdateState {
    current: string;
    installMode: "release" | "git";
    /** Git 安装的分支；release 分支可自动更新，其他分支需手动更新。 */
    gitBranch?: string;
    /** 能否由 Guard 自动更新与还原。 */
    autoUpdate: boolean;
    enabled: boolean;
    intervalMs: number;
    checking: boolean;
    checkedAt?: number;
    error?: string;
    latest?: UpdateSummary;
    available: boolean;
    phase: Phase;
    message?: string;
    hostRestartPending: boolean;
    /** 上一版本仍保留在 .update/previous 时可以还原。 */
    rollback?: {
        version: string;
    };
    lastResult?: {
        ok: boolean;
        version: string;
        message: string;
        at: number;
    };
}
interface UpdateOptions {
    /** 插件目录，更新只替换其中的发布文件。 */
    pluginDir: string;
    stateDir: string;
    /** 当前生效的更新配置，每次使用时读取以便即时生效。 */
    settings: () => UpdateSettings;
    /** 立即送达主人；业务进程未上线时返回 false，消息留待上线后补发。 */
    send: (text: string) => boolean;
    /** 把已暂存的发布包交给生命周期队列。 */
    install: (staged: StagedRelease, from: string, rollback?: boolean) => void;
    record: (type: string, details?: Record<string, unknown>) => void;
}
/**
 * 版本检查与更新编排：周期查询公开发布、通知主人、暂存发布包。
 * 文件替换由宿主生命周期队列在业务进程停止后执行。
 */
export declare class UpdateService {
    #private;
    /** 载入上次保存的检查结果和待发通知。 */
    constructor(options: UpdateOptions);
    /** 当前状态快照，供面板、命令与 CLI 展示。 */
    state(): UpdateState;
    /** 开始周期检查；首次检查稍后进行，避免与启动抢占资源。 */
    start(): void;
    /** 停止周期检查。 */
    stop(): void;
    /** 补发留存的通知。 */
    flush(): void;
    /** 发送通知；业务进程不在线时留存，defer 为真时不尝试立即发送。 */
    notify(text: string, defer?: boolean): void;
    /** 检查最新版本；并发调用共用同一次请求。manual 为真时忽略 ETag 并无视关闭开关。 */
    check(manual?: boolean): Promise<UpdateState>;
    /**
     * 暂存最新发布并交给生命周期队列。force 允许重装当前版本、跨主版本更新，
     * 并跳过版本比较。返回给调用方的文本即用户可见的结果。
     */
    apply(force: boolean): Promise<{
        ok: boolean;
        message: string;
    }>;
    /**
     * 还原到上一版本：把保留的文件当作暂存包交给生命周期队列。
     * 还原后宿主与业务进程都必须用旧代码重新启动，所以不会在旧宿主里直接拉起业务进程。
     */
    rollback(): Promise<{
        ok: boolean;
        message: string;
    }>;
    /** 由生命周期队列在业务进程停止后调用，执行文件替换。 */
    swap(staged: StagedRelease): ReturnType<typeof swapPackage>;
    /** 更新结束：记录结果并通知主人；defer 为真时留待新宿主上线后发送。 */
    finish(result: {
        ok: boolean;
        from: string;
        to: string;
        message?: string;
        relaunch: boolean;
        rollback?: boolean;
    }): void;
}
export {};
