import { randomUUID } from "node:crypto";
import { adapterAccountMethods, adapterEntityMethods, adapterProfileKeys, adapterEventKeys, adapterDto, adapterFail, adapterId, adapterKey, reservedAdapterIds, validateAdapterCall, validateAdapterFrame, validateAdapterEvent, } from "./protocol.js";
/** 校验为普通对象。 */
function object(value) {
    if (!value || typeof value !== "object")
        return adapterFail("ADAPTER_INVALID_OBJECT", "Expected guest adapter object");
    return value;
}
/** 这些选定 getter 仅在受限插件进程执行，不在宿主执行。 */
function profile(value) {
    const result = Object.create(null);
    if (!value || typeof value !== "object")
        return result;
    for (const key of adapterProfileKeys) {
        const item = value[key];
        if (item === null ||
            typeof item === "string" ||
            typeof item === "boolean" ||
            (typeof item === "number" && Number.isFinite(item)))
            result[key] = item;
    }
    return result;
}
/** 解析适配器条目列表。 */
function entries(value) {
    if (value === undefined || value === null)
        return [];
    if (!(value instanceof Map))
        return adapterFail("ADAPTER_UNSUPPORTED_SYNC", "Account maps must be synchronous Map snapshots");
    if (value.size > 256)
        return adapterFail("ADAPTER_COLLECTION_LIMIT", "Account map requires pagination");
    return [...value].map(([id, value]) => [adapterId(id), profile(value)]);
}
/** 原 SDK 对象和函数留在此处，集成方只提供值帧发送器。 */
export class NativeAdapterGuest {
    send;
    adapter = [];
    connectedIds = [];
    registrations = new Map();
    registeredObjects = new WeakMap();
    accounts = new Map();
    bindings = new Map();
    retiring = false;
    closed = false;
    disposal;
    /** 创建沙箱内的适配器代理。 */
    constructor(send) {
        this.send = send;
        Object.defineProperty(this.adapter, "push", {
            value: (...items) => {
                for (const value of items)
                    this.register(value);
                return this.adapter.length;
            },
        });
    }
    /** 确认代理未被释放。 */
    active() {
        if (this.closed || this.retiring)
            adapterFail("ADAPTER_CLOSED", "Adapter guest is closed");
    }
    /** 向宿主发布适配器帧。 */
    publish(frame) {
        this.send(validateAdapterFrame(frame));
    }
    /** 登记一个能力绑定，返回句柄。 */
    bind(binding) {
        if (this.bindings.size >= 1024)
            adapterFail("ADAPTER_HANDLE_LIMIT", "Too many adapter method capabilities");
        const handle = `method-${randomUUID()}`;
        this.bindings.set(handle, binding);
        return handle;
    }
    /** 登记插件提供的适配器及其账号。 */
    register(value) {
        this.active();
        const adapter = object(value);
        const existing = this.registeredObjects.get(adapter);
        if (existing)
            return this.registrations.get(existing).descriptor;
        if (this.registrations.size >= 8)
            adapterFail("ADAPTER_LIMIT", "Too many adapters in one plugin session");
        if (typeof adapter.load !== "function")
            adapterFail("ADAPTER_MISSING_LOAD", "Adapter must supply its real load method");
        const descriptor = {
            handle: `adapter-${randomUUID()}`,
            id: String(adapter.id ?? ""),
            name: String(adapter.name ?? adapter.id ?? ""),
            version: String(adapter.version ?? ""),
            loadHandle: this.bind({ kind: "load", adapter }),
        };
        validateAdapterFrame({ type: "register", adapter: descriptor });
        this.registrations.set(descriptor.handle, { value: adapter, descriptor });
        this.registeredObjects.set(adapter, descriptor.handle);
        Array.prototype.push.call(this.adapter, adapter);
        this.publish({ type: "register", adapter: descriptor });
        return descriptor;
    }
    /** 仅由插件 Bot 属性的账号赋值分支调用，宿主代码不调用。 */
    setAccount(id, value) {
        this.active();
        const key = adapterKey(id);
        if (reservedAdapterIds.has(key))
            adapterFail("ADAPTER_ACCOUNT_DENIED", "Account ID is a reserved Bot property");
        const account = object(value);
        const previous = this.accounts.get(key);
        if (previous?.value === account)
            return;
        if (!previous && this.accounts.size >= 32)
            adapterFail("ADAPTER_ACCOUNT_LIMIT", "Too many accounts in one plugin session");
        if (previous)
            this.removeAccount(id);
        this.accounts.set(key, {
            id: adapterId(id),
            handle: `account-${randomUUID()}`,
            value: account,
            methods: new Map(),
        });
    }
    /** 按 id 取得账号；撤销外部能力期间，原 logout 仍可能经 Bot[id] 使用自身 SDK。 */
    getAccount(id) {
        if (this.closed)
            adapterFail("ADAPTER_CLOSED", "Adapter guest is closed");
        return this.accounts.get(adapterKey(id))?.value;
    }
    /** 判断账号是否存在。 */
    hasAccount(id) {
        return this.accounts.has(adapterKey(id));
    }
    /** 移除账号并撤销其能力。 */
    removeAccount(id) {
        if (this.closed)
            adapterFail("ADAPTER_CLOSED", "Adapter guest is closed");
        const key = adapterKey(id), account = this.accounts.get(key);
        if (!account)
            return;
        for (const [handle, binding] of this.bindings)
            if (binding.kind !== "load" && binding.account === account)
                this.bindings.delete(handle);
        this.accounts.delete(key);
        for (let index = this.connectedIds.length - 1; index >= 0; index--)
            if (adapterKey(this.connectedIds[index]) === key)
                this.connectedIds.splice(index, 1);
        if (!this.retiring)
            this.publish({ type: "remove", accountHandle: account.handle });
    }
    /** 为账号或实体方法登记句柄。 */
    method(account, kind, method) {
        const key = `${kind}:${method}`;
        let handle = account.methods.get(key);
        if (!handle) {
            handle = this.bind({ kind, account, method });
            account.methods.set(key, handle);
        }
        return handle;
    }
    /** 生成账号的可序列化快照。 */
    snapshot(account) {
        const value = account.value;
        const adapter = value.adapter;
        const adapterHandle = adapter && typeof adapter === "object" ? this.registeredObjects.get(adapter) : undefined;
        if (!adapterHandle)
            return adapterFail("ADAPTER_ACCOUNT_DENIED", "Account must belong to a registered guest adapter");
        const metadata = profile(value);
        metadata.info = profile(value.info);
        const version = Object.create(null);
        if (value.version && typeof value.version === "object")
            for (const key of ["id", "name", "version"]) {
                const item = value.version[key];
                if (typeof item === "string")
                    version[key] = item;
            }
        metadata.version = version;
        const stat = Object.create(null);
        if (value.stat && typeof value.stat === "object")
            for (const key of ["start_time", "online"]) {
                const item = value.stat[key];
                if (typeof item === "number" && Number.isFinite(item))
                    stat[key] = item;
            }
        metadata.stat = stat;
        const members = value.gml;
        if (members !== undefined && !(members instanceof Map))
            return adapterFail("ADAPTER_UNSUPPORTED_SYNC", "Group member maps must be synchronous");
        if (members instanceof Map && members.size > 256)
            return adapterFail("ADAPTER_COLLECTION_LIMIT", "Group member map requires pagination");
        const methods = Object.create(null);
        for (const method of adapterAccountMethods)
            if (typeof value[method] === "function")
                methods[method] = this.method(account, "account", method);
        const entityMethods = Object.fromEntries(adapterEntityMethods.map(method => [method, this.method(account, "entity", method)]));
        return {
            handle: account.handle,
            id: account.id,
            adapterHandle,
            metadata,
            friends: entries(value.fl),
            groups: entries(value.gl),
            members: members instanceof Map
                ? [...members].map(([id, map]) => [adapterId(id), entries(map)])
                : [],
            methods,
            entityMethods,
        };
    }
    /** 把账号变化同步给宿主。 */
    flush() {
        this.active();
        for (const account of this.accounts.values())
            this.publish({ type: "account", account: this.snapshot(account) });
    }
    /** Bot.em 保持同步；按序先发布账号元数据，再发布事件。 */
    emit(name, input) {
        if (this.closed)
            adapterFail("ADAPTER_CLOSED", "Adapter guest is closed");
        const value = object(input), account = this.accounts.get(adapterKey(value.self_id));
        if (!account)
            adapterFail("ADAPTER_EVENT_DENIED", "Guest cannot emit for an account it does not own");
        if (this.retiring) {
            if (name !== `disconnect.${account.id}` && name !== "system.offline")
                this.active();
            for (let index = this.connectedIds.length - 1; index >= 0; index--)
                if (adapterKey(this.connectedIds[index]) === adapterKey(account.id))
                    this.connectedIds.splice(index, 1);
            return; // 本地关闭通知；宿主能力已撤销，不再向其发帧。
        }
        const event = Object.create(null);
        for (const [key, descriptor] of Object.entries(Object.getOwnPropertyDescriptors(value))) {
            if (!adapterEventKeys.has(key) ||
                !descriptor.enumerable ||
                !Object.hasOwn(descriptor, "value"))
                continue;
            event[key] = key === "sender" ? profile(descriptor.value) : adapterDto(descriptor.value);
        }
        validateAdapterEvent(event, name, account.id);
        this.publish({ type: "account", account: this.snapshot(account) });
        this.publish({ type: "event", accountHandle: account.handle, name, event });
        if (name === `connect.${account.id}` &&
            !this.connectedIds.some(id => adapterKey(id) === adapterKey(account.id)))
            this.connectedIds.push(account.id);
        if (name === `disconnect.${account.id}`)
            for (let index = this.connectedIds.length - 1; index >= 0; index--)
                if (adapterKey(this.connectedIds[index]) === adapterKey(account.id))
                    this.connectedIds.splice(index, 1);
    }
    /** 按选择器取得账号或成员对象。 */
    select(account, selector) {
        const value = account.value;
        let selected;
        if (selector.kind === "friend") {
            const pick = value.pickFriend ?? value.pickUser;
            if (typeof pick !== "function")
                return adapterFail("ADAPTER_UNSUPPORTED_METHOD", "Account has no friend selector");
            selected = Reflect.apply(pick, value, [selector.userId]);
        }
        else if (selector.kind === "group") {
            if (typeof value.pickGroup !== "function")
                return adapterFail("ADAPTER_UNSUPPORTED_METHOD", "Account has no group selector");
            selected = Reflect.apply(value.pickGroup, value, [selector.groupId]);
        }
        else if (typeof value.pickMember === "function")
            selected = Reflect.apply(value.pickMember, value, [
                selector.groupId,
                selector.userId,
            ]);
        else {
            const group = this.select(account, { kind: "group", groupId: selector.groupId });
            if (typeof group.pickMember !== "function")
                return adapterFail("ADAPTER_UNSUPPORTED_METHOD", "Group has no member selector");
            selected = Reflect.apply(group.pickMember, group, [selector.userId]);
        }
        const row = object(selected);
        if (typeof row.then === "function")
            adapterFail("ADAPTER_UNSUPPORTED_SYNC", "A synchronous pick selector returned a Promise");
        return row;
    }
    /** 执行宿主转来的适配器方法调用。 */
    async invoke(input, restoreArgs) {
        this.active();
        const call = validateAdapterCall(input), binding = this.bindings.get(call.methodHandle);
        if (!binding)
            return adapterFail("ADAPTER_UNKNOWN_METHOD", "Method capability is unknown or revoked");
        let target, method;
        if (binding.kind === "load") {
            if (call.selector || call.args.length)
                return adapterFail("ADAPTER_INVALID_SELECTOR", "Adapter load accepts no selector or arguments");
            target = binding.adapter;
            method = "load";
        }
        else {
            if (this.accounts.get(adapterKey(binding.account.id)) !== binding.account)
                return adapterFail("ADAPTER_UNKNOWN_ACCOUNT", "Account capability is revoked");
            if ((binding.kind === "entity" && !call.selector) ||
                (binding.kind === "account" && call.selector))
                return adapterFail("ADAPTER_INVALID_SELECTOR", "Method capability has the wrong target kind");
            target = call.selector ? this.select(binding.account, call.selector) : binding.account.value;
            method = binding.method;
        }
        if (typeof target[method] !== "function")
            return adapterFail("ADAPTER_UNSUPPORTED_METHOD", `Original adapter method is unavailable: ${method}`);
        // 执行原方法，保留其抛错或拒绝，不能转换为成功。
        const args = restoreArgs ? await restoreArgs(call.args) : call.args;
        this.active();
        const result = await Reflect.apply(target[method], target, args);
        this.active();
        this.flush();
        if (method === "getInfo")
            return adapterDto(profile(result));
        if (result instanceof Map && method === "getGroupMemberMap")
            return adapterDto({
                $type: "AdapterMemberMaps",
                entries: [...result].map(([id, members]) => [adapterId(id), entries(members)]),
            });
        if (result instanceof Map)
            return adapterDto({ $type: "AdapterMap", entries: entries(result) });
        if (["getFriendArray", "getGroupArray"].includes(method) && Array.isArray(result))
            return adapterDto(result.map(profile));
        return adapterDto(result);
    }
    /** 注销全部账号并释放代理。 */
    async dispose() {
        if (this.disposal)
            return this.disposal;
        this.retiring = true;
        this.bindings.clear();
        this.disposal = (async () => {
            const accounts = [...this.accounts.values()];
            let logoutFailures = 0;
            try {
                for (const account of accounts) {
                    try {
                        if (typeof account.value.logout === "function")
                            await Reflect.apply(account.value.logout, account.value, []);
                    }
                    catch {
                        logoutFailures++;
                    }
                }
                return { accounts: accounts.length, logoutFailures };
            }
            finally {
                this.accounts.clear();
                this.registrations.clear();
                this.connectedIds.length = 0;
                this.closed = true;
            }
        })();
        return this.disposal;
    }
}
//# sourceMappingURL=guest.js.map
// Guard 自有导出登记。
import { registerModule as __guardRegisterExports } from "../../protect/objects.js"
__guardRegisterExports("native-sandbox/adapter/guest.ts", { NativeAdapterGuest })
