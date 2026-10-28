import type { GuardAction } from "../shared/types.js";
export interface NativeRedisPermissions {
    /** 使用 Redis 原键名，支持精确键或单个末尾 * 表示字面前缀。 */
    read: string[];
    write: string[];
}
/** 已配置的 plugins/ 目录项，保留拼写以兼容大小写敏感宿主。 */
export interface NativeSandboxPlugin {
    id: string;
    enabled: boolean;
    timeoutMs: number;
    network: "none" | "host";
    hookAction: GuardAction;
    /** 显式信任插件在核心注册协议账号并发出对应事件。 */
    adapters: boolean;
    /** 宿主控制权须显式授予，即使回调已由宿主认证为主人请求。 */
    allowCoreRestart: boolean;
    /** 明确的原项目相对目录，不迁移或重定向数据。 */
    writablePaths: string[];
    /** 精确的已有文件；不支持单文件授权时不能扩大为父目录权限。 */
    writableFiles: string[];
    /** 默认拒绝，不自动增加 Redis 键命名空间或迁移数据。 */
    redis: NativeRedisPermissions;
}
export interface NativeSandboxSettings {
    plugins: NativeSandboxPlugin[];
}
/** 仅允许 JSON DTO，传输代码须校验该值，不暴露类实例。 */
export interface NativeClassDescriptor {
    id: string;
    /** 原 constructor.name，可为空；显示文本保留在 metadata.name。 */
    name: string;
    metadata: Record<string, unknown>;
    methods: string[];
}
/** pid 仅供观察，不能据此取得向任意进程发信号的权限。 */
export interface NativeLoadResult {
    classes: NativeClassDescriptor[];
    pid: number;
}
/** 运行时值须通过 JSON 安全传输编解码器后才能作为回复。 */
export interface NativeCallResult {
    result: unknown;
    metadata: Record<string, unknown>;
    methods?: string[];
}
