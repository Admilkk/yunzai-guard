/** 内核持有的租约会在接入进程退出时自动释放。 */
export declare function acquirePm2AttachLock(parent: {
    pid: number;
    created: string;
}): Promise<() => Promise<void>>;
