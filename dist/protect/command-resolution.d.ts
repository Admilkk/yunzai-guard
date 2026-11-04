export interface ExecutableResolution {
    path?: string;
    script: boolean;
    node: boolean;
    limited?: boolean;
}
/** 按实际搜索环境识别入口，不执行文件，只读取两个 shebang 字节。 */
export declare function resolveCommandExecutable(file: string, directory: string, environment: unknown, shell?: boolean): ExecutableResolution;
