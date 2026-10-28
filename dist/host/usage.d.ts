/** 业务进程树的系统层采样；包含原生扩展发起、不经过 JS 入口的读写与连接。 */
export interface ProcessUsage {
    sampledAt: number;
    processes: number;
    /** 进程树累计读取字节，含文件、管道与套接字。 */
    readBytes: number;
    /** 进程树累计写入字节，含文件、管道与套接字。 */
    writeBytes: number;
    /** 已建立的非回环 TCP 连接远端，形如 `1.2.3.4:443`、`[2001:db8::1]:443`。 */
    remote: string[];
    /** 已建立的回环 TCP 连接数量，例如本机 Redis。 */
    loopback: number;
}
/** 判断地址是否为回环地址。 */
export declare function isLoopback(address: string): boolean;
/** 把地址与端口组合为远端标识，IPv6 加方括号。 */
export declare function endpoint(address: string, port: number): string;
/** 解码 /proc/net/tcp 中的十六进制地址（IPv4 为小端 32 位，IPv6 为 4 组小端 32 位）。 */
export declare function decodeProcAddress(hex: string): string | undefined;
/** 解析 /proc/net/tcp(6) 文本，返回 inode 到已建立连接远端的映射。 */
export declare function parseProcTcp(text: string): Map<string, {
    address: string;
    port: number;
}>;
/** 采样进程树；进程已退出或平台不支持时返回 undefined。 */
export declare function sampleUsage(root: number): Promise<ProcessUsage | undefined>;
/** 定期采样一个业务进程树，并对新出现的外部连接回调一次。 */
export declare class UsageWatch {
    #private;
    /** 创建采样器；回调异常不影响后续采样。 */
    constructor(root: number, onConnection: (remote: string, usage: ProcessUsage) => void);
    /** 最近一次成功的采样。 */
    get latest(): ProcessUsage | undefined;
    /** 开始定期采样；Windows 依赖 PowerShell，间隔更长。 */
    start(intervalMs?: number): void;
    /** 立即采样一次；上一次未完成时跳过。 */
    sample(): Promise<ProcessUsage | undefined>;
    /** 停止采样。 */
    stop(): void;
}
