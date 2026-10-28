/** 拒绝以 --expose-internals 启动的进程。 */
export declare function assertNoInternals(): void;
/** 限制 process.binding 只能查询常见绑定，并禁用 _linkedBinding。 */
export declare function installBindingGuard(seal: (object: object, key: PropertyKey, value: unknown, label: string) => void, deny: (operation: string, target: string) => never): void;
