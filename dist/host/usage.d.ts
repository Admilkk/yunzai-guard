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
    /** 进程树常驻内存字节。 */
    rssBytes: number;
    /** 进程树累计 CPU 秒数（用户态加内核态）。 */
    cpuSeconds: number;
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
/** 解析 ps 的累计 CPU 时间，形如 `1:02.50` 或 `1-02:03:04`。 */
export declare function cpuTime(value: string | undefined): number;
/** 采样进程树；进程已退出或平台不支持时返回 undefined。 */
export declare function sampleUsage(root: number): Promise<ProcessUsage | undefined>;
/** 定期采样一个业务进程树，并对新出现的外部连接回调一次。 */
export declare class UsageWatch {
    #private;
    /** 创建采样器；回调异常不影响后续采样。 */
    constructor(root: number, onConnection: (remote: string, usage: ProcessUsage) => void, onSample?: (usage: ProcessUsage) => void);
    /** 最近一次成功的采样。 */
    get latest(): ProcessUsage | undefined;
    /** 开始定期采样；Windows 依赖 PowerShell，间隔更长。 */
    start(intervalMs?: number): void;
    /** 立即采样一次；上一次未完成时跳过。 */
    sample(): Promise<ProcessUsage | undefined>;
    /** 停止采样。 */
    stop(): void;
}
export interface ResourcePoint {
    time: number;
    processes: number;
    rssBytes: number;
    /** 采样间隔内的 CPU 占用，单位为核（1 = 一个核心满载）。 */
    cpu: number;
    readBytesPerSecond: number;
    writeBytesPerSecond: number;
    connections: number;
    /** 宿主进程常驻内存。 */
    hostRssBytes: number;
    /** 宿主事件循环延迟 p99，毫秒。 */
    hostLagMs: number;
}
/** 业务进程树的资源历史：由累计计数换算出速率，保留最近一段时间的曲线。 */
export declare class ResourceHistory {
    #private;
    /** 开始统计宿主事件循环延迟。 */
    constructor();
    /** 记录一次采样；业务进程重启后累计值回退时，速率记为 0。 */
    push(usage: ProcessUsage): void;
    /** 业务进程重建后断开速率计算。 */
    restart(): void;
    /** 历史采样点，旧的在前。 */
    points(): ResourcePoint[];
}
