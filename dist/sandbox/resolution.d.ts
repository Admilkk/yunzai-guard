export interface ModuleAliases {
    root: string;
    links: Array<{
        from: string;
        to: string;
    }>;
    /** 不重写指向当前会话可写授权范围的普通 pnpm 工作区反向链接。 */
    skippedWritableBacklinks?: Array<{
        from: string;
        to: string;
    }>;
    /** 核心根包的反向链接由 guest 包映射接管，不加入路径重写表或授予目标写权限。 */
    skippedCoreBacklinks?: Array<{
        from: string;
        to: string;
    }>;
}
/** 仅由宿主生成快照；链接不授予系统访问权，此处不遍历链接目标。 */
export declare function collectWindowsAliases(projectRoot: string, writablePaths?: readonly string[], writableFiles?: readonly string[]): ModuleAliases;
/** 恢复模块规范位置，并用 preserve-symlinks 避免查询无权访问的祖先路径。 */
export declare function installSandboxResolution(manifestPath?: string): () => void;
