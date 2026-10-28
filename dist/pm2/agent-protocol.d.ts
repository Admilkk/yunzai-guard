interface Pm2AgentModule {
    pm2AgentCapabilities: Readonly<{
        agentProtocol: 2;
        bootstrapExitBarrier: 1;
        cachedRegistryUpgrade: 1;
    }>;
    registerPm2Application: (request: unknown) => unknown;
}
interface Pm2InspectorSessionModule {
    pm2InspectorSessionProtocol: 1;
    preparePm2InspectorClose: (request: unknown) => unknown;
}
/**
 * 调用登记代码前，验证受信模块的静态 ABI。
 * 函数必须自包含，其源码还会在父守护进程的执行环境中运行；
 * 因此文案经参数传入，序列化调用时须显式提供，不能依赖模块导入。
 * 这里只协商缓存实现的兼容性，不验证恶意守护进程的身份。
 */
export declare function assertPm2AgentModule(value: unknown, message?: string): asserts value is Pm2AgentModule;
/** 清理传输有独立 ABI，不依赖加载登记代理。 */
export declare function assertPm2InspectorSessionModule(value: unknown, message?: string): asserts value is Pm2InspectorSessionModule;
/** 生成在 PM2 daemon 中登记应用的求值表达式，先校验代理模块形状。 */
export declare function pm2AgentRegistrationExpression(agentPath: string, request: unknown): string;
/** 生成在 PM2 daemon 中准备 Inspector 关闭的求值表达式。 */
export declare function pm2InspectorPreparationExpression(transportPath: string, request: unknown): string;
export {};
