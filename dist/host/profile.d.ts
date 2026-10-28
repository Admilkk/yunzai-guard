import type { GuardSettings } from "../shared/types.js";
type Baseline = GuardSettings["baseline"];
export type Severity = "low" | "medium" | "high";
export type AnomalyType = "new-target" | "rate-spike" | "off-hours" | "burst";
export interface Anomaly {
    id: string;
    time: number;
    plugin: string;
    type: AnomalyType;
    severity: Severity;
    kind: string;
    key: string;
    detail: string;
}
export interface ProfileEvent {
    plugin?: string;
    kind: string;
    operation?: string;
    target: string;
    time?: number;
}
/** 判断严重度是否不低于下限。 */
export declare function atLeast(value: Severity, minimum: Severity): boolean;
/** 把事件归并为“类型 + 对象”形式的行为特征；不关心的类型返回 undefined。 */
export declare function featureOf(event: ProfileEvent): {
    kind: string;
    key: string;
} | undefined;
/** 估计一个新行为的严重程度：能执行代码或对外开放的更高，普通文件目录更低。 */
export declare function severityOf(kind: string, key: string): Severity;
/** 行为画像：学习每个插件的常规行为，并在之后识别新目标、频率突增、非常规时段与批量探测。 */
export declare class BehaviorProfile {
    #private;
    /** 读取已保存的画像；文件缺失或损坏时从空画像开始。 */
    constructor(options: {
        file: string;
        settings: () => Baseline;
        clock?: () => number;
    });
    /** 处理一条行为事件，返回由它触发的异常。 */
    observe(event: ProfileEvent): Anomaly[];
    /** 定时结算统计窗口，检查没有新事件时也会发生的频率突增。 */
    tick(now?: number): Anomaly[];
    /** 各插件的画像摘要。 */
    summary(now?: number): {
        enabled: boolean;
        learnHours: number;
        plugins: {
            plugin: string;
            startedAt: number;
            learning: boolean;
            learnEndsAt: number;
            features: number;
            total: number;
            kinds: Record<string, number>;
            risk: {
                score: number;
                level: Severity;
            };
            anomalies7d: number;
            lastAnomaly: Anomaly | undefined;
        }[];
    };
    /** 单个插件的完整画像。 */
    detail(plugin: string, now?: number): {
        plugin: string;
        startedAt: number;
        learning: boolean;
        risk: {
            score: number;
            level: Severity;
        };
        total: number;
        days: number;
        hourly: number[];
        features: {
            count: number;
            firstAt: number;
            lastAt: number;
            kind: string;
            key: string;
        }[];
        anomalies: Anomaly[];
    } | undefined;
    /** 把一个行为加入常规画像（信任）。 */
    trust(plugin: string, kind: string, key: string): boolean;
    /** 从画像中移除一个行为，之后再次出现会重新提示。 */
    forget(plugin: string, kind: string, key: string): boolean;
    /** 立即结束学习期，之后的新行为开始提示。 */
    endLearning(plugin?: string): number;
    /** 清空画像并重新学习；不传插件名时清空全部。 */
    reset(plugin?: string): void;
    /** 立即写盘。 */
    flush(): void;
}
export {};
