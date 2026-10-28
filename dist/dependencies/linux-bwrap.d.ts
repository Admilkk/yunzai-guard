/** 优先使用系统包的安全策略；缺失时使用随插件提供的无 setuid 静态程序。 */
export declare function prepareBubblewrap(repository: string, requested?: string, network?: "none" | "host"): string;
