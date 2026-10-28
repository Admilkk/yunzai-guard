export declare class YunzaiGuard extends plugin {
    /** 以最高优先级注册为 Yunzai 插件。 */
    constructor();
    /** 把消息交给独立插件沙箱分派，已处理时拦截后续插件。 */
    accept(event: Record<string, unknown>): Promise<"return" | false>;
    /**
     * 主人的 #guard更新 / #guard强制更新：转交宿主执行，结果由宿主通知主人。
     * 需要重启业务进程的更新默认等空闲时生效；有等待生效的更新时再次发送即马上执行。
     */
    update(): Promise<boolean>;
    /** 主人的 #guard回滚：还原到上一版本，结果由宿主通知主人。 */
    rollback(): Promise<boolean>;
    /** 主人的 #guard登录：宿主生成一次性链接并私聊主人，群聊里只提示已发送。 */
    login(): Promise<boolean>;
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
