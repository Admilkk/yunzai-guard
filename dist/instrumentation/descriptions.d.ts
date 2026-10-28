import type dgram from "node:dgram";
export interface Description {
    kind: "network" | "listen" | "process" | "filesystem" | "native";
    operation: string;
    target: string;
    auditTarget?: string;
    details?: Record<string, unknown>;
}
/** 普通 fork 子进程不是宿主 worker，不能继承其握手预加载器。 */
export declare function prepareFork(args: unknown[]): unknown[];
/** 去掉控制字符并截断到 512 字符。 */
export declare function cleanTarget(value: string): string;
/** 描述 http/https 请求的目标与方法。 */
export declare function describeRequest(operation: string, args: unknown[], protocol: string): Description;
/** 描述套接字连接目标。 */
export declare function describeSocket(operation: string, args: unknown[], protocol: string): Description;
/** 描述 UDP 发送目标。 */
export declare function describeDatagram(socket: dgram.Socket, args: unknown[]): Description;
/** 描述命令执行；shell 命令只保留首个程序名。 */
export declare function describeCommand(operation: string, args: unknown[]): Description;
/** 描述 fetch 请求的目标与方法。 */
export declare function describeFetch(args: unknown[]): Description;
/** 监听端口同样是网络暴露面；只记录地址与端口，不记录回调。 */
export declare function describeListen(operation: string, args: unknown[], protocol: string): Description;
/** 直接 DNS 查询；net/http 内部解析经 dns.lookup，不在此重复记录。 */
export declare function describeDns(operation: string, args: unknown[]): Description;
/** 描述以 URL 为首参的网络连接。 */
export declare function describeUrl(operation: string, args: unknown[], protocol: string): Description;
/** 文件目标只保留路径文本；句柄、fd 等非路径输入返回 undefined。 */
export declare function filePath(value: unknown): string | undefined;
/** 描述一次文件访问。 */
export declare function describeFile(operation: string, target: string, write: boolean, source?: string): Description;
/** 描述原生扩展加载。 */
export declare function describeNative(args: unknown[]): Description;
