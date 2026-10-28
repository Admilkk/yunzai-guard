import path from "node:path";
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import { arrayEach, arrayEvery, arrayIsArray, arrayIncludes, arrayPush, arraySlice, jsonStringify, objectCreate, objectDefine, objectDescriptor, objectHasOwn, objectKeys, ownKeys, reflectGet, regexpTest, setHas, string, stringIndexOf, stringLower, stringStartsWith, stringSlice, } from "../protect/intrinsics.js";
const bootstrap = fileURLToPath(new URL("../runtime-bootstrap.cjs", import.meta.url));
const childPreload = new URL("../child-preload.js", import.meta.url).href;
const resolutionPreload = new URL("../native-sandbox/resolution-preload.js", import.meta.url).href;
const resolutionBootstrap = fileURLToPath(new URL("../native-sandbox/resolution-bootstrap.cjs", import.meta.url));
const ownRequires = new Set([bootstrap, resolutionBootstrap]);
const ownImports = new Set([
    childPreload,
    new URL("../worker-preload.js", import.meta.url).href,
    new URL("../native-sandbox/preload.js", import.meta.url).href,
    resolutionPreload,
].flatMap(value => [value, fileURLToPath(value)]));
const ownExecutable = process.execPath;
const windows = process.platform === "win32";
const resolvePath = path.resolve;
const realpath = fs.realpathSync.native;
/** 仅移除当前 Guard 安装的预加载器，保留应用自身预加载器和参数。 */
export function stripGuardExecArgv(input) {
    const rest = [];
    for (let index = 0; index < input.length; index++) {
        const value = input[index];
        if (value === "--import" && setHas(ownImports, input[index + 1])) {
            index++;
            continue;
        }
        if (stringStartsWith(value, "--import=") && setHas(ownImports, stringSlice(value, 9)))
            continue;
        if ((value === "--require" || value === "-r") && setHas(ownRequires, input[index + 1])) {
            index++;
            continue;
        }
        if ((stringStartsWith(value, "--require=") && setHas(ownRequires, stringSlice(value, 10))) ||
            (stringStartsWith(value, "-r") && setHas(ownRequires, stringSlice(value, 2))))
            continue;
        arrayPush(rest, value);
    }
    return rest;
}
/** 强制传递受控运行时，不受调用方 execArgv 影响。 */
export function monitoredExecArgv(input) {
    const rest = stripGuardExecArgv(input);
    const result = [];
    if (windows)
        arrayEach(process.execArgv, value => {
            if (arrayIncludes(["--preserve-symlinks", "--preserve-symlinks-main"], value) &&
                !arrayIncludes(rest, value))
                arrayPush(result, value);
        });
    arrayEach(["--require", bootstrap, "--import", childPreload], value => arrayPush(result, value));
    arrayEach(rest, value => arrayPush(result, value));
    return result;
}
/** NODE_OPTIONS 使用空白和双引号，不采用 shell 语法；无关参数原样保留。 */
export function stripGuardNodeOptions(input) {
    const tokens = [];
    let at = 0;
    while (at < input.length) {
        while (regexpTest(/\s/, input[at] ?? "") && at < input.length)
            at++;
        if (at === input.length)
            break;
        const start = at;
        let value = "";
        let quoted = false;
        while (at < input.length) {
            const char = input[at];
            if (char === '"') {
                quoted = !quoted;
                at++;
                continue;
            }
            if (char === "\\" && quoted && arrayIncludes(['"', "\\"], input[at + 1] ?? "")) {
                value += input[at + 1];
                at += 2;
                continue;
            }
            if (!quoted && regexpTest(/\s/, char))
                break;
            value += char;
            at++;
        }
        // 用户语法错误仍交给 Node 报错，不将其重解释为合法参数。
        if (quoted)
            return input;
        arrayPush(tokens, { raw: stringSlice(input, start, at), value });
    }
    const kept = [];
    for (let index = 0; index < tokens.length; index++) {
        const token = tokens[index];
        const next = tokens[index + 1];
        if ((token.value === "--import" && setHas(ownImports, next?.value ?? "")) ||
            (arrayIncludes(["--require", "-r"], token.value) && setHas(ownRequires, next?.value ?? ""))) {
            index++;
            continue;
        }
        if (stripGuardExecArgv([token.value]).length)
            arrayPush(kept, token.raw);
    }
    let output = "";
    arrayEach(kept, value => {
        output += `${output ? " " : ""}${value}`;
    });
    return output;
}
/** 复制选项对象的自有属性到无原型对象。 */
function copyOptions(input) {
    const result = objectCreate(null);
    if (input)
        arrayEach(ownKeys(input), key => {
            if (objectDescriptor(input, key)?.enumerable)
                objectDefine(result, key, {
                    value: reflectGet(input, key),
                    enumerable: true,
                    writable: true,
                    configurable: true,
                });
        });
    return result;
}
/** 复制环境变量为无原型对象。 */
function copyEnvironment(input) {
    const env = objectCreate(null);
    // Node 也接收继承的环境变量；值只转换一次，避免校验后再次触发 getter。
    for (const key in input) {
        const value = input[key];
        env[key] = value === undefined ? undefined : string(value);
    }
    return env;
}
/** 去掉 Guard 注入的环境变量，得到普通子进程环境。 */
function ordinaryEnvironment(input) {
    const env = copyEnvironment(input);
    arrayEach(objectKeys(env), key => {
        const normalized = stringLower(key);
        if (arrayIncludes([
            "yunzai_guard_runtime_manifest",
            "yunzai_guard_resolution_manifest",
            "yunzai_guard_parent_runtime",
            "yunzai_guard_origin_plugin",
            "yunzai_guard_pipe",
        ], normalized))
            delete env[key];
        if (normalized === "node_options" && typeof env[key] === "string") {
            const cleaned = stripGuardNodeOptions(env[key]);
            if (cleaned)
                env[key] = cleaned;
            else
                delete env[key];
        }
    });
    return env;
}
/** 返回 NODE_OPTIONS 的实际键名（Windows 不区分大小写）。 */
function nodeOptionsKey(env) {
    if (!windows)
        return "NODE_OPTIONS";
    let first;
    arrayEach(objectKeys(env), key => {
        if (stringLower(key) === "node_options" && (first === undefined || key < first))
            first = key;
    });
    return first ?? "NODE_OPTIONS";
}
/** 在 NODE_OPTIONS 前追加参数。 */
function prependNodeOptions(env, prefix) {
    const key = nodeOptionsKey(env);
    const current = typeof env[key] === "string" ? env[key] : "";
    env[key] = prefix + (current ? ` ${current}` : "");
}
/** 判断可执行文件是否为当前 Node。 */
function executable(value, cwd) {
    if (typeof value !== "string")
        return false;
    const candidate = typeof cwd === "string" ? resolvePath(cwd, value) : resolvePath(value);
    const own = resolvePath(ownExecutable);
    if (windows ? stringLower(candidate) === stringLower(own) : candidate === own)
        return true;
    try {
        const actual = realpath(candidate);
        const canonicalOwn = realpath(ownExecutable);
        return windows ? stringLower(actual) === stringLower(canonicalOwn) : actual === canonicalOwn;
    }
    catch {
        return false;
    }
}
/** 返回参数列表中 options 的位置。 */
function optionsIndex(args) {
    return arrayIsArray(args[1]) || (args[1] == null && args.length >= 3) ? 2 : 1;
}
/** 在检查前固定启动参数的快照。 */
export function snapshotLaunch(operation, input) {
    const args = arraySlice(input);
    const at = optionsIndex(args);
    const current = args[at];
    const callbackOnly = arrayIncludes(["exec", "execFile"], operation) && typeof current === "function";
    if (!callbackOnly && current != null && (typeof current !== "object" || arrayIsArray(current)))
        return input;
    const options = copyOptions(callbackOnly ? undefined : current);
    if (arrayIsArray(args[1]))
        args[1] = arraySlice(args[1]);
    if (arrayIsArray(options.execArgv))
        options.execArgv = arraySlice(options.execArgv);
    options.env = copyEnvironment(options.env && typeof options.env === "object" ? options.env : process.env);
    args[at] = options;
    if (callbackOnly)
        arrayPush(args, current);
    return args;
}
/** 判断是否为可直接继承监控的 Node 子进程启动。 */
export function isDirectNodeLaunch(operation, args) {
    if (!arrayIncludes(["fork", "spawn", "spawnSync", "execFile", "execFileSync"], operation))
        return false;
    const options = args[optionsIndex(args)];
    if (options?.shell)
        return false;
    if (operation === "fork")
        return options?.execPath === undefined || executable(options.execPath, options.cwd);
    if (!executable(args[0], options?.cwd))
        return false;
    const argv = arrayIsArray(args[1]) ? args[1] : [];
    return !arrayIncludes(["--version", "-v", "--help", "-h", "--v8-options"], argv[0]);
}
/** 用新的 argv 与 options 重组启动参数。 */
function withArgv(args, argv, options) {
    const result = [args[0], argv, options];
    arrayEach(arraySlice(args, optionsIndex(args) + 1), value => arrayPush(result, value));
    return result;
}
/** 为可识别的 Node 子进程注入运行时预加载与清单。 */
export function prepareNodeLaunch(operation, input, context) {
    const prepared = snapshotLaunch(operation, input);
    if (prepared === input)
        return input;
    const at = optionsIndex(prepared);
    const options = prepared[at];
    const direct = isDirectNodeLaunch(operation, prepared);
    if (context.manifestPath && !direct)
        return prepared;
    const fork = operation === "fork";
    const inherited = fork
        ? options.execArgv === undefined
            ? process.execArgv
            : options.execArgv
        : arrayIsArray(prepared[1])
            ? prepared[1]
            : [];
    if ((fork || direct) &&
        (!arrayIsArray(inherited) || !arrayEvery(inherited, item => typeof item === "string")))
        return input;
    const argv = arrayIsArray(inherited) ? arraySlice(inherited) : [];
    const env = options.env;
    if (!context.manifestPath) {
        options.env = ordinaryEnvironment(env);
        const nativeEnv = options.env;
        if (context.resolutionManifestPath &&
            windows &&
            arrayIncludes(process.execArgv, "--preserve-symlinks") &&
            arrayIncludes(process.execArgv, "--preserve-symlinks-main"))
            prependNodeOptions(nativeEnv, "--preserve-symlinks --preserve-symlinks-main");
        if (fork)
            options.execArgv = stripGuardExecArgv(argv);
        else if (direct && arrayIsArray(prepared[1]))
            prepared[1] = stripGuardExecArgv(argv);
        if (direct && context.resolutionManifestPath) {
            nativeEnv.YUNZAI_GUARD_RESOLUTION_MANIFEST = resolvePath(context.resolutionManifestPath);
            prependNodeOptions(nativeEnv, `--require ${jsonStringify(resolutionBootstrap)}`);
            const resolution = (input) => {
                const result = [];
                if (windows)
                    arrayEach(["--preserve-symlinks", "--preserve-symlinks-main"], flag => {
                        if (!arrayIncludes(input, flag))
                            arrayPush(result, flag);
                    });
                arrayPush(result, "--require");
                arrayPush(result, resolutionBootstrap);
                arrayEach(input, value => arrayPush(result, value));
                return result;
            };
            if (fork)
                options.execArgv = resolution(options.execArgv);
            else
                return withArgv(prepared, resolution(stripGuardExecArgv(argv)), options);
        }
        return prepared;
    }
    const prefix = `--require ${jsonStringify(bootstrap)} `;
    const key = nodeOptionsKey(env);
    let nodeOptions = typeof env[key] === "string" ? env[key] : "";
    while (stringStartsWith(nodeOptions, prefix))
        nodeOptions = stringSlice(nodeOptions, prefix.length);
    env.YUNZAI_GUARD_RUNTIME_MANIFEST = resolvePath(context.manifestPath);
    env.YUNZAI_GUARD_PARENT_RUNTIME = context.runtimeId;
    env.YUNZAI_GUARD_ORIGIN_PLUGIN = context.originPlugin() ?? "unknown";
    env[key] = prefix + nodeOptions;
    if (fork)
        options.execArgv = monitoredExecArgv(argv);
    else
        return withArgv(prepared, monitoredExecArgv(argv), options);
    return prepared;
}
/** 为底层 ChildProcess#spawn 的选项注入运行时预加载。 */
export function prepareSpawnOptions(input, context) {
    const options = copyOptions(input);
    const args = options.args === undefined
        ? []
        : arrayIsArray(options.args)
            ? arraySlice(options.args)
            : options.args;
    const pairs = arrayIsArray(options.envPairs) ? arraySlice(options.envPairs) : options.envPairs;
    if (!arrayIsArray(args) ||
        !arrayEvery(args, value => typeof value === "string") ||
        (pairs !== undefined &&
            (!arrayIsArray(pairs) || !arrayEvery(pairs, value => typeof value === "string"))))
        return options;
    options.args = args;
    if (pairs !== undefined)
        options.envPairs = pairs;
    if (!context)
        return options;
    const env = objectCreate(null);
    if (pairs === undefined) {
        options.envPairs = [];
        const inherited = copyEnvironment(process.env);
        arrayEach(objectKeys(inherited), key => {
            if (inherited[key] !== undefined)
                arrayPush(options.envPairs, `${key}=${inherited[key]}`);
        });
    }
    arrayEach(options.envPairs, pair => {
        const at = stringIndexOf(pair, "=");
        if (at > 0) {
            const key = stringSlice(pair, 0, at);
            if (!objectHasOwn(env, key))
                env[key] = stringSlice(pair, at + 1);
        }
    });
    const publicArgs = [options.file, arraySlice(options.args, 1), { env, cwd: options.cwd }];
    const prepared = prepareNodeLaunch("spawn", publicArgs, context);
    const next = prepared[2];
    options.args = [options.args[0] ?? options.file];
    arrayEach(prepared[1], value => arrayPush(options.args, value));
    const output = [];
    const seen = objectCreate(null);
    arrayEach(options.envPairs, pair => {
        const at = stringIndexOf(pair, "=");
        if (at <= 0) {
            arrayPush(output, pair);
            return;
        }
        const key = stringSlice(pair, 0, at);
        if (!objectHasOwn(next.env, key) || next.env[key] === undefined)
            return;
        if (next.env[key] === env[key])
            arrayPush(output, pair);
        else if (!seen[key])
            arrayPush(output, `${key}=${next.env[key]}`);
        seen[key] = true;
    });
    arrayEach(objectKeys(next.env), key => {
        if (!seen[key] && next.env[key] !== undefined)
            arrayPush(output, `${key}=${next.env[key]}`);
    });
    options.envPairs = output;
    return options;
}
//# sourceMappingURL=launch.js.map
// Guard 自有导出登记。
import { registerModule as __guardRegisterExports } from "../protect/objects.js"
__guardRegisterExports("runtime/launch.ts", { stripGuardExecArgv, monitoredExecArgv, stripGuardNodeOptions, snapshotLaunch, isDirectNodeLaunch, prepareNodeLaunch, prepareSpawnOptions })
