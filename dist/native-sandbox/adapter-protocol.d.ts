export type AdapterId = string | number;
export type AdapterValue = null | boolean | number | string | AdapterValue[] | {
    [key: string]: AdapterValue;
};
export type AdapterProfile = Record<string, AdapterValue>;
export type AdapterEntries = Array<[AdapterId, AdapterProfile]>;
export type AdapterSelector = {
    kind: "friend";
    userId: AdapterId;
} | {
    kind: "group";
    groupId: AdapterId;
} | {
    kind: "member";
    groupId: AdapterId;
    userId: AdapterId;
};
export interface AdapterMethodCall {
    methodHandle: string;
    args: AdapterValue[];
    selector?: AdapterSelector;
}
export interface AdapterRegistration {
    handle: string;
    id: string;
    name: string;
    version: string;
    loadHandle: string;
}
export interface AdapterAccount {
    handle: string;
    id: AdapterId;
    adapterHandle: string;
    metadata: AdapterProfile;
    friends: AdapterEntries;
    groups: AdapterEntries;
    members: Array<[AdapterId, AdapterEntries]>;
    methods: Record<string, string>;
    entityMethods: Record<string, string>;
}
export type AdapterFrame = {
    type: "register";
    adapter: AdapterRegistration;
} | {
    type: "account";
    account: AdapterAccount;
} | {
    type: "event";
    accountHandle: string;
    name: string;
    event: AdapterProfile;
} | {
    type: "remove";
    accountHandle: string;
};
export declare const adapterAccountMethods: readonly ["login", "logout", "getFriendArray", "getFriendList", "getFriendMap", "getGroupArray", "getGroupList", "getGroupMap", "getGroupMemberMap"];
export declare const adapterEntityMethods: readonly ["sendMsg", "recallMsg", "getInfo", "getAvatarUrl"];
export declare const adapterProfileKeys: readonly ["id", "uin", "user_id", "group_id", "nickname", "name", "username", "user_name", "group_name", "card", "avatar", "sex", "age", "title", "role", "level", "join_time", "last_sent_time", "member_count", "max_member_count", "first_name", "last_name"];
export declare const reservedAdapterIds: Set<string>;
export declare class AdapterBridgeError extends Error {
    code: string;
    /** 创建带错误码的适配器协议错误。 */
    constructor(code: string, message: string);
}
/** 抛出适配器协议错误。 */
export declare function adapterFail(code: string, message: string): never;
/** 校验适配器内的 id。 */
export declare function adapterId(value: unknown): AdapterId;
/** 把 id 转为 Map 键。 */
export declare function adapterKey(value: unknown): string;
/** 校验指定前缀的句柄。 */
export declare function adapterHandle(value: unknown, prefix: "adapter" | "account" | "method"): string;
/** 两端独立校验；访问器、函数和 SDK 原型不能跨越 IPC。 */
export declare function adapterDto(value: unknown): AdapterValue;
/** 校验为普通对象行。 */
export declare function adapterRow(value: unknown): Record<string, unknown>;
/** 校验适配器方法调用。 */
export declare function validateAdapterCall(input: unknown): AdapterMethodCall;
/** 校验适配器帧。 */
export declare function validateAdapterFrame(input: unknown): AdapterFrame;
/** 判断事件名是否属于该 id 的合法事件。 */
export declare function validAdapterEvent(name: string, id: AdapterId): boolean;
export declare const adapterEventKeys: Set<string>;
/** 校验适配器事件，非法时抛错。 */
export declare function validateAdapterEvent(event: AdapterProfile, name: string, id: AdapterId): void;
