import type { StartPanelOptions } from "../web/index.js";
export interface CoreHostOptions {
    /** 每次启动控制台时生成的宿主能力，不含内存会话交接。 */
    panel: () => Omit<StartPanelOptions, "handover">;
    record: (type: string, details?: Record<string, unknown>) => void;
}
/**
 * 控制台的宿主端：在宿主进程内加载、停止与替换控制台。
 * 热替换时以新代号重新加载控制台模块，宿主与业务进程不受影响；旧模块停止服务后不再运行任何任务，
 * 但 ES 模块无法卸载，其代码会保留到宿主下次重启（每次约数 MB）。
 * 控制台从哪个插件目录加载由调用方决定，等待业务侧更新时可以先从暂存目录运行新版本。
 */
export declare class CoreHost {
    #private;
    /** 创建控制台管理器。 */
    constructor(options: CoreHostOptions);
    /** 当前控制台所在的插件目录。 */
    get pluginDir(): string | undefined;
    /** 当前控制台的版本。 */
    get version(): string | undefined;
    /** 从指定插件目录加载并启动控制台。 */
    start(pluginDir: string): Promise<boolean>;
    /** 停止控制台：交出内存会话后关闭端口与连接。 */
    stop(): Promise<void>;
    /**
     * 换成另一个插件目录中的控制台。新控制台未能启动时回到原目录，返回 false。
     * 控制台在两次监听之间短暂不可用，浏览器会自动重连。
     */
    swap(pluginDir: string): Promise<boolean>;
    /** 请求控制台生成一次性登录链接。 */
    loginLink(): Promise<{
        urls: string[];
        ttlSeconds: number;
    }>;
}
