export interface HookRequest {
    operation: string;
    object: object;
    key?: PropertyKey;
    receiver?: object;
}
export interface HookChange extends HookRequest {
    outcome: "returned" | "rejected" | "threw" | "blocked";
    changed?: boolean;
    before?: PropertyDescriptor;
    after?: PropertyDescriptor;
    properties?: readonly {
        key: PropertyKey;
        before?: PropertyDescriptor;
        after?: PropertyDescriptor;
    }[];
    prototypeChanged?: boolean;
}
export interface HookListener {
    before?(request: HookRequest): void;
    after?(change: HookChange): void;
}
export interface HookWatch {
    track(object: object, listener: HookListener, key?: PropertyKey): () => void;
    targets(): readonly {
        object: object;
        key: string;
        value: Function;
    }[];
    close(): void;
}
/** 只拦截显式反射调用，保留业务属性描述符和普通赋值语义。 */
export declare function installHookWatch(): HookWatch;
