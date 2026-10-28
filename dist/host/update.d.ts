import type { GuardSettings } from "../shared/types.js";
import { swapPackage, type StagedRelease } from "../update/install.js";
import { type UpdateLevel } from "../update/plan.js";
type UpdateSettings = GuardSettings["update"];
type Phase = "idle" | "downloading" | "installing" | "restarting" | "pending" | "failed";
/** 更新完成的方式：热替换、重启业务进程、宿主重新启动，或宿主仍需手动重启。 */
export type FinishMode = "hot" | "worker" | "relaunch" | "host-pending";
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
    /** 上一版本的发布文件或 Git 提交仍保留时可以还原。 */
    rollback?: {
        version: string;
    };
    /** 最近一次更新的级别与改动文件数。 */
    plan?: {
        level: UpdateLevel;
        changed: number;
    };
    /** 控制台已更新、等待重启业务进程生效的更新。 */
    pending?: {
        version: string;
        since: number;
        rollback: boolean;
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
    /** 把已暂存的发布包交给生命周期队列；immediate 为真时业务侧更新不等待空闲。 */
    install: (staged: StagedRelease, from: string, rollback: boolean, immediate: boolean) => void;
    /** 取消等待中的更新：控制台回到当前文件。 */
    cancelPending: () => Promise<void>;
    record: (type: string, details?: Record<string, unknown>) => void;
}
/**
 * 判断等待中的业务侧更新是否到了执行时机：
 * now 立即；window 只在维护时段；idle 等业务连续空闲，超过最长等待后直接执行。
 */
export declare function pendingDue(input: {
    since: number;
    settings: UpdateSettings;
    lastActivityAt: number;
    now: number;
}): boolean;
/**
 * 版本检查与更新编排：周期查询公开发布、通知主人、暂存发布包。
 * 文件替换由宿主生命周期队列在业务进程停止后执行。
 */
export declare class UpdateService {
    #private;
    /** 载入持久化检查结果、待发通知与回滚目标，并解析上一版本。 */
    constructor(options: UpdateOptions);
    /** 读取轻量元数据与已解析的回滚版本，供面板、命令与 CLI 展示；不启动子进程。 */
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
     * 暂存最新发布、比较组件得出更新级别，再交给生命周期队列。force 允许重装当前版本或跨主版本升级，
     * 低于当前版本的发布仍拒绝；必须成功检查发布信息，不以旧缓存替代失败响应。
     * immediate 为真时，需要重启业务进程的更新马上执行，不等待空闲。
     * 已有等待生效的更新时，再次请求更新即视为要求马上生效。
     */
    apply(force: boolean, immediate?: boolean): Promise<{
        ok: boolean;
        message: string;
    }>;
    /**
     * 还原到上一版本：同样按组件比较，能热替换时不重启。
     * 有等待生效的更新时，还原即取消这次更新，控制台回到当前文件。
     */
    rollback(): Promise<{
        ok: boolean;
        message: string;
    }>;
    /** 由生命周期队列在业务进程停止后调用，执行文件替换。 */
    swap(staged: StagedRelease): ReturnType<typeof swapPackage>;
    /** 业务侧更新改为等待：控制台已换成新版本，业务进程择时重启。 */
    defer(staged: StagedRelease, from: string, rollback: boolean): void;
    /** 等待中的更新；用于判断是否到了执行时机。 */
    get pending(): {
        version: string;
        since: number;
    } | undefined;
    /** 立即执行等待中的更新：重启业务进程使其生效。 */
    applyPending(): Promise<{
        ok: boolean;
        message: string;
    }>;
    /** 宿主重新启动前记录待确认的更新，新宿主上线后据此确认成功或还原。 */
    markVerify(value: {
        from: string;
        to: string;
        rollback: boolean;
        revert?: boolean;
    }): void;
    /** 读取待确认的更新并累加启动次数；没有时返回 undefined。 */
    takeVerify(): {
        from: string;
        to: string;
        rollback: boolean;
        revert: boolean;
        attempts: number;
    } | undefined;
    /** 清除待确认记录。 */
    clearVerify(): void;
    /** 新宿主上的更新未能上线：把保留的上一版本暂存起来用于还原。 */
    stageRevert(version: string): Promise<StagedRelease>;
    /** 更新结束：记录结果并通知主人。 */
    finish(result: {
        ok: boolean;
        from: string;
        to: string;
        message?: string;
        mode: FinishMode;
        rollback?: boolean;
    }): void;
}
export {};
