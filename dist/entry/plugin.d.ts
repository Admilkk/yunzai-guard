export declare class YunzaiGuard extends plugin {
    /**
     * 以普通 Yunzai 插件注册，只承担冷接管入口与兜底提示。
     * 受管运行时会在核心加载本插件时换成运行时子类，命令与受限脚本分派都在其中处理；
     * 走到下面的规则，说明尚未接管或核心加载器桥接不可用。
     */
    constructor();
    /** 兜底：说明当前无法通过聊天执行 Guard 命令。 */
    unavailable(): Promise<boolean>;
    /** 插件初始化：检查平台与配置，并在核心就绪后交接给受管宿主。 */
    init(): Promise<string | undefined>;
    /**
     * 外部托管时原地接管：核心就绪后释放原进程的资源，再用 execve 把本进程替换成 Guard 宿主。
     * PID 不变，Docker 的 1 号进程与 node . daemon 的子进程关系都保持原样，与 TRSS 自身的重启方式一致。
     */
    private replaceInPlace;
    /** 核心就绪后准备运行时并交接；下载在交接前完成，不调整已有 PM2 daemon。 */
    private takeOverWhenReady;
}
