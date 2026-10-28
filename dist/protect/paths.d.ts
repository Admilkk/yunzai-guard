/** 判断 value 是否位于 root 内（含 root 本身）。 */
export declare function within(root: string, value: string): boolean;
/** 仅使用捕获的只读入口，避免包装器递归调用。 */
export declare class Paths {
    #private;
    /** 登记受保护根目录。 */
    constructor(roots: string[], deny: (operation: string, target: string) => never);
    /** Node 也接受 Uint8Array 和 URL-like，检查与调用必须使用同一份路径。 */
    snapshot(value: unknown, operation: string, readOnly?: boolean, absolute?: boolean): unknown;
    /** 检查路径或 fd 是否落在受保护目录，必要时同时检查祖先目录。 */
    check(value: unknown, operation: string, ancestors?: boolean): void;
    /** 登记 fd 与打开时的路径身份。 */
    track(fd: number, value: unknown): void;
    /** 移除已关闭 fd 的登记。 */
    forget(fd: number): void;
    /** 检查 fd 指向的文件是否受保护。 */
    fd(fd: number, operation: string): void;
}
