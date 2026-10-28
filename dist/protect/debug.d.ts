/** 调试器可读取闭包与控制密钥，不能与受保护宿主共用。 */
export declare function assertNoDebugger(): void;
/** 只关闭调试和堆导出能力；业务内建对象仍可按原方式使用。 */
export declare function installDebugGuard(seal: (object: object, key: PropertyKey, value: unknown, label: string) => void, deny: (operation: string, target: string) => never): void;
