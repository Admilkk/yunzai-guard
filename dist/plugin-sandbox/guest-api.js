/** 在插件上下文构建对象，不向插件提供真实 Bot、事件、插件或文件系统对象。 */
export function guestBootstrap(event, pluginIds = []) {
    return `(() => {
    const nativeInvoke = globalThis.__guardInvoke;
    const nativeAttempt = globalThis.__guardAttempt;
    const nativeDone = globalThis.__guardDone;
    delete globalThis.__guardInvoke;
    delete globalThis.__guardAttempt;
    delete globalThis.__guardDone;
    const ErrorType = Error;
    const define = Object.defineProperty;
    const freeze = Object.freeze;
    const apply = Reflect.apply;
    const ownValues = Object.values;
    const isArray = Array.isArray;
    const RegExpType = RegExp;
    const match = Function.prototype.call.bind(RegExp.prototype.test);
    const owners = new WeakMap();
    const resolve = Promise.resolve.bind(Promise);
    const then = Function.prototype.call.bind(Promise.prototype.then);
    const invoke = (...args) => {
      if (nativeInvoke(...args) !== true) throw new ErrorType("GUARD_DENIED");
    };
    const refuse = target => {
      nativeAttempt("sandbox.hook", target);
      throw new ErrorType("GUARD_HOOK_DENIED");
    };
    const append = (prefix, key) => {
      const next = prefix + "." + (typeof key === "symbol" ? "[symbol]" : key);
      if (next.length > 256) return refuse(prefix.slice(0, 256));
      return next;
    };
    const facade = (prefix, names, depth = 0) => {
      const value = () => refuse(prefix);
      owners.set(value, prefix);
      for (const name of names) {
        let nested;
        define(value, name, {
          get: () => nested || (nested = facade(append(prefix, name), depth < 2 ? ["em", "fnc", "handler", "prototype"] : [], depth + 1)),
          set: () => refuse(append(prefix, name)), configurable: false
        });
      }
      return freeze(value);
    };
    for (const name of ["Bot", "Plugins"]) {
      const keys = name === "Bot"
        ? ["em", "prepareEvent", "restart", "exit", "sendMsg", "pickFriend", "pickGroup", "on", "once", "off", "emit", "prototype"]
        : ${JSON.stringify(pluginIds)};
      const value = facade(name, keys);
      define(globalThis, name, { get: () => value, set: () => refuse(name), configurable: false });
    }
    // vm2 在当前 Node 版本主动移除 Proxy，不能重新暴露宿主 Proxy。
    // 这些插件内包装上报修改 API，冻结的代理接口使未知直接写入失效。
    for (const [object, name, property] of [
      [Object, "defineProperty", true], [Object, "defineProperties", false],
      [Object, "setPrototypeOf", false], [Object, "assign", false],
      [Object, "freeze", false], [Object, "seal", false], [Object, "preventExtensions", false],
      [Reflect, "set", true], [Reflect, "defineProperty", true], [Reflect, "deleteProperty", true],
      [Reflect, "setPrototypeOf", false], [Reflect, "preventExtensions", false]
    ]) {
      const original = object[name];
      define(object, name, { value: function(target, key, ...rest) {
        const owner = owners.get(target);
        if (owner) return refuse(property ? append(owner, typeof key === "string" ? key : "[property]") : owner);
        if (target === globalThis && property && (key === "Bot" || key === "Plugins")) return refuse(key);
        return apply(original, object, arguments);
      }, configurable: false, writable: false });
    }
    // 仅支持文本能力，移除二进制分配接口和面向宿主的全局对象。
    for (const name of ["Buffer", "process", "require", "fetch", "Worker", "WebAssembly",
      "ArrayBuffer", "SharedArrayBuffer", "DataView", "Int8Array", "Uint8Array", "Uint8ClampedArray",
      "Int16Array", "Uint16Array", "Int32Array", "Uint32Array", "Float32Array", "Float64Array",
      "BigInt64Array", "BigUint64Array", "Atomics", "WeakRef", "FinalizationRegistry"])
      define(globalThis, name, { value: undefined, configurable: false, writable: false });
    define(globalThis, "guard", { value: freeze({
      invoke,
      reply: text => invoke("reply", text),
      log: text => invoke("log", text),
      writeText: (file, text) => invoke("writeText", text, file)
    }), configurable: false, writable: false });
    const input = JSON.parse(${JSON.stringify(JSON.stringify(event))});
    input.msg = input.message;
    input.user_id = input.userId;
    input.group_id = input.groupId;
    input.self_id = input.selfId;
    input.reply = text => invoke("reply", text);
    define(globalThis, "event", {
      value: freeze(input),
      configurable: false, writable: false
    });
    define(globalThis, "onMessage", { value: undefined, configurable: false, writable: true });
    const module = { exports: {} };
    class Plugin {
      constructor(options = {}) {
        Object.assign(this, options);
        this.e = input;
      }
      reply(text) { return invoke("reply", text); }
    }
    define(globalThis, "plugin", { value: Plugin, configurable: false, writable: false });
    define(globalThis, "module", { value: module, configurable: false, writable: false });
    define(globalThis, "exports", { value: module.exports, configurable: false, writable: false });
    const legacy = async () => {
      const exported = module.exports;
      const collection = typeof exported === "function" ? [exported]
        : exported && typeof exported === "object" ? ownValues(exported.apps || exported) : [];
      if (!collection.length || collection.length > 16) throw new ErrorType("PLUGIN_EXPORT_REQUIRED");
      for (const Constructor of collection) {
        if (typeof Constructor !== "function") continue;
        const instance = new Constructor(input);
        instance.e = input;
        if (typeof instance.init === "function") await instance.init();
        if (!isArray(instance.rule)) continue;
        if (instance.rule.length > 64) throw new ErrorType("PLUGIN_RULE_BUDGET");
        for (const rule of instance.rule) {
          if (!rule || typeof rule.reg !== "string" || typeof rule.fnc !== "string") continue;
          if (!match(new RegExpType(rule.reg), input.msg)) continue;
          const method = instance[rule.fnc];
          if (typeof method !== "function") throw new ErrorType("PLUGIN_METHOD_REQUIRED");
          if (await apply(method, instance, [input]) !== false) return;
        }
      }
    };
    // 宿主不等待或检查插件 Promise 及抛出的值。
    // 插件源码调用此执行器时，由宿主初始化阶段拒绝。
    define(globalThis, "__guardRun", { configurable: false, writable: false, value: () => {
      try {
        const pending = typeof globalThis.onMessage === "function" ? globalThis.onMessage(input) : legacy();
        then(resolve(pending),
          () => nativeDone("ok"), () => nativeDone("script-failed"));
      } catch { nativeDone("script-failed"); }
    } });
  })();`;
}
//# sourceMappingURL=guest-api.js.map
// Guard 自有导出登记。
import { registerModule as __guardRegisterExports } from "../protect/objects.js"
__guardRegisterExports("plugin-sandbox/guest-api.ts", { guestBootstrap })
