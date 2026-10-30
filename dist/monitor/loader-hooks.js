import { refuse } from "../protect/objects.js";
const engines = new WeakMap();
const creationKey = Symbol("loader-hooks");
/**
 * 核心 PluginsLoader 的钩子引擎：每个方法只替换一次，各模块登记的环绕钩子按登记顺序由外到内执行。
 * 同步方法保持同步，返回值与 this 原样透传；同一加载器共用一个引擎。
 */
export class LoaderHooks {
    loader;
    #chains = new Map();
    #trusted = new Set();
    #locked = false;
    constructor(loader, key) {
        // TypeScript 的 private 不限制 JavaScript 调用，不能让插件另建引擎绕过锁。
        if (key !== creationKey)
            refuse("loader-hooks-create", "PluginsLoader");
        this.loader = loader;
    }
    /** 取得加载器的钩子引擎，首次调用时创建。 */
    static of(loader) {
        let engine = engines.get(loader);
        if (!engine)
            engines.set(loader, (engine = new LoaderHooks(loader, creationKey)));
        return engine;
    }
    /** 登记环绕钩子；先登记的在外层。方法不存在时不登记并返回 false。 */
    around(method, hook) {
        this.#assertOpen();
        const chain = this.#chain(method);
        if (!chain)
            return false;
        chain.hooks.push(hook);
        return true;
    }
    /** 未经任何钩子的原方法，供需要绕开外层逻辑的回滚路径使用。 */
    original(method) {
        this.#assertOpen();
        return this.#chain(method)?.original;
    }
    /** 初始化时登记可信入口判断；导入时只按已登记的判断标记 Guard 自有插件。 */
    trustWhen(matches) {
        this.around("importPlugin", (next, file, ...args) => {
            if (matches(file))
                this.#trusted.add(file.name);
            return next(file, ...args);
        });
    }
    /** 全部运行时模块接入后关闭注册与原方法访问，业务插件加载期间不能再更改引擎。 */
    lock() {
        this.#locked = true;
        Object.freeze(this);
    }
    #assertOpen() {
        if (this.#locked)
            refuse("loader-hooks-locked", "PluginsLoader");
    }
    /** 是否为 Guard 自有的插件。 */
    trusted(key) {
        return typeof key === "string" && this.#trusted.has(key);
    }
    /** 首次登记时替换方法为分派函数。 */
    #chain(method) {
        const existing = this.#chains.get(method);
        if (existing)
            return existing;
        const original = this.loader[method];
        if (typeof original !== "function")
            return undefined;
        const chain = { original, hooks: [] };
        this.#chains.set(method, chain);
        const call = (self, index, args) => {
            const hook = chain.hooks[index];
            return hook
                ? Reflect.apply(hook, self, [(...next) => call(self, index + 1, next), ...args])
                : Reflect.apply(chain.original, self, args);
        };
        this.loader[method] = function (...args) {
            return call(this, 0, args);
        };
        return chain;
    }
}
//# sourceMappingURL=loader-hooks.js.map
// Guard 自有导出登记。
import { registerModule as __guardRegisterExports } from "../protect/objects.js"
__guardRegisterExports("monitor/loader-hooks.ts", { LoaderHooks })
