import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import nodePath from "node:path";
import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
import { attachNativeTransport } from "./transport.js";
import { validateNativeWriteGrants, validateNativeWritablePaths } from "./config.js";
import { parseNativeSandbox } from "./config.js";
import { nativeBehaviorSettings } from "./behavior.js";
import { buildLinuxSandbox } from "../sandbox/linux.js";
import { spawnWindowsSandbox, } from "../sandbox/windows.js";
import { configuredPrivateWindowsRuntime, } from "../sandbox/windows-runtime.js";
import { within } from "../protect/paths.js";
import { M } from "../shared/messages.js";
import { sha256 } from "../shared/hash.js";
const path = Object.freeze({ ...nodePath });
const createDirectory = fs.mkdtempSync.bind(fs);
const openFile = fs.openSync.bind(fs);
const writeFile = fs.writeSync.bind(fs);
const closeFile = fs.closeSync.bind(fs);
const temporaryRoot = (() => {
    try {
        return fs.realpathSync.native(os.tmpdir());
    }
    catch {
        return path.resolve(os.tmpdir());
    }
})();
const createId = randomUUID;
const bytes = Buffer.from.bind(Buffer);
const stringify = JSON.stringify.bind(JSON);
const runtimeKey = Symbol.for("yunzai.guard.runtime.v1");
const initialRoot = (() => {
    try {
        return fs.realpathSync.native(process.cwd());
    }
    catch {
        return path.resolve(process.cwd());
    }
})();
const ownDescriptor = Object.getOwnPropertyDescriptor.bind(Object);
// 原生 ACL 和挂载准备会遍历实际依赖及资源树，其有界
// 启动预算须独立于插件普通单次 RPC 超时。
export const nativeStartupTimeoutMs = 60000;
const active = new Set();
const reclaimedFailures = new WeakSet();
const rememberReclaimed = reclaimedFailures.add.bind(reclaimedFailures);
const wasReclaimed = reclaimedFailures.has.bind(reclaimedFailures);
/** 判断启动失败后是否已确认清理完成。 */
export function nativeStartupCleanupConfirmed(error) {
    return error !== null && typeof error === "object" && wasReclaimed(error);
}
/** Windows 下统一为小写以便比较路径。 */
const fold = (value) => (process.platform === "win32" ? value.toLowerCase() : value);
/** 合并启动阶段的多个错误。 */
function startupFailure(errors) {
    return new AggregateError(errors, M.nativeSandbox.unavailableNoFallback(errors.map(error => (error instanceof Error ? error.message : String(error))).join("; ")));
}
/** 可信 spawn 返回后，第一步同步安装。 */
function observeStartup(child) {
    let settled = false;
    let finishReady;
    let timer;
    const ready = new Promise((resolve, reject) => {
        const finish = (success, error) => {
            if (settled)
                return;
            settled = true;
            if (timer)
                clearTimeout(timer);
            child.off("message", onMessage);
            if (success)
                resolve();
            else
                reject(error);
        };
        finishReady = finish;
        const onMessage = (message) => {
            if (message?.type === "preload-hello")
                finish(true);
        };
        // 就绪后仍保留此被动错误接收器，避免早到或晚到的
        // 原生错误在原所有者关闭期间成为未处理错误。
        child.on("error", error => finish(false, error));
        child.once("exit", (code, signal) => finish(false, new Error(M.nativeSandbox.exitedEarly(code ?? "none", signal ?? "none"))));
        child.on("message", onMessage);
        timer = setTimeout(() => finish(false, new Error(M.nativeSandbox.transportTimeout)), nativeStartupTimeoutMs);
    });
    void ready.catch(() => { });
    return {
        ready,
        /** 取消启动并记录原因。 */
        cancel(error) {
            finishReady(false, error);
        },
    };
}
/** 子进程必须受系统限制，不提供无沙箱回退。 */
export async function launchNativeSandbox(options) {
    const cleanup = { confirmed: true };
    try {
        return await startNativeSandbox(options, cleanup);
    }
    catch (error) {
        if (!cleanup.confirmed)
            throw error;
        const failure = startupFailure([error]);
        rememberReclaimed(failure);
        throw failure;
    }
}
/** 启动原生插件沙箱子进程。 */
async function startNativeSandbox(options, cleanup) {
    if (process.platform !== "linux" && process.platform !== "win32")
        throw new Error(M.nativeSandbox.platform);
    const platform = process.platform;
    const root = fs.realpathSync.native(options.root);
    if (ownDescriptor(globalThis, runtimeKey) && fold(root) !== fold(initialRoot))
        throw new Error(M.nativeSandbox.pluginDir);
    const pluginRoot = fs.realpathSync.native(options.pluginRoot);
    if (fold(pluginRoot) !== fold(path.resolve(options.pluginRoot)) ||
        fold(path.dirname(pluginRoot)) !== fold(path.join(root, "plugins")) ||
        !fs.statSync(pluginRoot).isDirectory())
        throw new Error(M.nativeSandbox.pluginDir);
    const guardRoot = fs.realpathSync.native(fileURLToPath(new URL("../../", import.meta.url)));
    if (within(pluginRoot, guardRoot) || within(guardRoot, pluginRoot))
        throw new Error(M.nativeSandbox.guardWritable);
    const entry = fs.realpathSync.native(options.entry);
    const transport = fileURLToPath(new URL("./preload.js", import.meta.url));
    if (!within(root, entry) ||
        within(pluginRoot, entry) ||
        !fs.statSync(entry).isFile() ||
        !within(root, transport))
        throw new Error(M.nativeSandbox.trustedEntry);
    if (options.network !== "none" && options.network !== "host")
        throw new Error(M.nativeSandbox.networkMode);
    const defaultConfig = path.join(root, "config/default_config");
    const grants = validateNativeWriteGrants(options.writablePaths ?? [], options.writableFiles ?? [], "native sandbox write grants", fs.existsSync(defaultConfig) ? fs.readdirSync(defaultConfig) : []);
    const sharedWritablePaths = validateNativeWritablePaths(options.sharedWritablePaths);
    if (sharedWritablePaths.some(target => !grants.writablePaths.includes(target)))
        throw new Error(M.nativeSandbox.sharedDirs);
    if (options.args?.some(value => typeof value !== "string" || value.includes("\0")))
        throw new Error(M.nativeSandbox.childArgs);
    const identity = fold(pluginRoot);
    if (active.has(identity))
        throw new Error(M.nativeSandbox.alreadyActive);
    active.add(identity);
    cleanup.confirmed = false;
    let runtime;
    try {
        runtime = createDirectory(path.join(temporaryRoot, "yunzai-native-runtime-"));
    }
    catch (error) {
        active.delete(identity);
        cleanup.confirmed = true;
        throw error;
    }
    const manifest = path.join(runtime, "manifest.json");
    let server;
    let serverListenFailed = false;
    let child;
    let linux;
    let closing;
    let startup;
    let ready;
    const cleanupRuntime = async (release = true) => {
        const errors = [];
        try {
            if (server)
                await new Promise((resolve, reject) => server.close(error => {
                    const neverListening = serverListenFailed &&
                        !server.listening &&
                        error?.code === "ERR_SERVER_NOT_RUNNING";
                    if (error && !neverListening)
                        reject(error);
                    else
                        resolve();
                }));
        }
        catch (error) {
            errors.push(error);
        }
        try {
            if (fs.existsSync(runtime)) {
                if (fs.realpathSync.native(runtime) !== runtime ||
                    path.dirname(runtime) !== temporaryRoot ||
                    !path.basename(runtime).startsWith("yunzai-native-runtime-"))
                    throw new Error(M.nativeSandbox.unsafeCleanup);
                fs.rmSync(runtime, { recursive: true, force: true });
            }
        }
        catch (error) {
            errors.push(error);
        }
        if (release && !errors.length) {
            active.delete(identity);
            cleanup.confirmed = true;
        }
        if (errors.length)
            throw startupFailure(errors);
    };
    const close = () => (closing ??= (async () => {
        const errors = [];
        if (child && platform === "win32") {
            try {
                await child.sandboxDispose();
            }
            catch (error) {
                errors.push(error);
            }
        }
        else if (child) {
            try {
                if (child.exitCode === null &&
                    child.signalCode === null &&
                    !child.kill("SIGKILL") &&
                    child.exitCode === null &&
                    child.signalCode === null)
                    throw new Error(M.nativeSandbox.termination);
            }
            catch (error) {
                errors.push(error);
            }
            try {
                await linux.waitForExit(child, 5000);
            }
            catch (error) {
                errors.push(error);
            }
        }
        if (errors.length) {
            // 移除 Linux 无活动作用的辅助资源，但确认范围清理前保留准入记录。
            // Windows 日志仍引用描述目录的 ACE，需保留目录供恢复使用。
            if (platform === "linux") {
                try {
                    await cleanupRuntime(false);
                }
                catch (cleanupError) {
                    errors.push(cleanupError);
                }
            }
            throw startupFailure(errors);
        }
        await cleanupRuntime();
    })());
    const ownChild = (launched) => {
        child = launched;
        startup = observeStartup(launched);
        ready = startup.ready.catch(async (error) => {
            try {
                await close();
            }
            catch (cleanupError) {
                throw startupFailure([error, cleanupError]);
            }
            throw startupFailure([error]);
        });
        void ready.catch(() => { });
        launched.once("exit", () => {
            void close().catch(() => { });
        });
    };
    try {
        const endpoint = platform === "win32"
            ? `\\\\.\\pipe\\yunzai-guard-native-${createId()}`
            : path.join(runtime, "broker.sock");
        const nativeBehavior = options.behavior === undefined
            ? undefined
            : {
                pluginId: parseNativeSandbox({ plugins: [{ id: options.behavior.pluginId }] })
                    .plugins[0].id,
                settings: nativeBehaviorSettings(options.behavior.settings),
            };
        if (nativeBehavior && fold(nativeBehavior.pluginId) !== fold(path.basename(pluginRoot)))
            throw new Error(M.nativeSandbox.behaviorIdentity);
        const content = bytes(stringify({ version: 1, endpoint, nativeBehavior }));
        const manifestFd = openFile(manifest, "wx", 0o400);
        try {
            let offset = 0;
            while (offset < content.length) {
                const written = writeFile(manifestFd, content, offset, content.length - offset, offset);
                if (!written)
                    throw Object.assign(new Error("EIO"), { code: "EIO" });
                offset += written;
            }
        }
        finally {
            closeFile(manifestFd);
        }
        if (platform === "linux") {
            // 仅用于挂载协调，此端点不接受消息或运行时管理请求。
            server = net.createServer(socket => {
                socket.on("error", () => { });
                socket.destroy();
            });
            server.on("error", () => { });
            try {
                await new Promise((resolve, reject) => {
                    server.once("error", reject);
                    server.listen(endpoint, resolve);
                });
            }
            catch (error) {
                serverListenFailed = true;
                throw error;
            }
        }
        const env = {};
        for (const key of ["PATH", "SystemRoot", "WINDIR", "LANG", "TZ", "LOCALAPPDATA"])
            if (process.env[key] !== undefined)
                env[key] = process.env[key];
        env.YUNZAI_GUARD_RUNTIME_MANIFEST = manifest;
        const args = ["--import", pathToFileURL(transport).href, entry, ...(options.args ?? [])];
        const settings = {
            shutdownTimeout: 10000,
            sandbox: {
                network: options.network,
                denyNetworkCalls: options.network === "none",
                writablePaths: [
                    path.relative(root, pluginRoot).split(path.sep).join("/"),
                    ...grants.writablePaths,
                ],
                writableFiles: grants.writableFiles,
            },
        };
        if (platform === "win32") {
            const privateRuntime = configuredPrivateWindowsRuntime(guardRoot, options.privateWindowsRuntime);
            const privateCache = path.join(guardRoot, ".cache");
            ownChild(spawnWindowsSandbox(root, settings, {
                executable: privateRuntime?.executable ?? process.execPath,
                expectedExecutableSha256: privateRuntime?.sha256,
                canonicalMetadataProtocol: privateRuntime?.canonicalMetadataProtocol,
                prependRuntimePath: privateRuntime !== undefined,
                additionalDeniedPaths: privateRuntime && fs.existsSync(privateCache) ? [privateCache] : [],
                args,
                env,
                cwd: root,
                runtimeManifest: manifest,
                forwardOutput: false,
                sharedWritablePaths,
                sessionKey: `plugin-${sha256(identity).slice(0, 32)}`,
            }));
        }
        else {
            linux = buildLinuxSandbox(root, settings, {
                executable: process.execPath,
                args,
                env,
                runtimeManifest: manifest,
            });
            // 仅在子进程保留 Node IPC 端点，父进程读取有界的原始 FD 3 帧。
            const stdio = ["ignore", "ignore", "ignore", "pipe", "ignore", "pipe"];
            for (const extra of linux.extraStdio)
                stdio[extra.fd] = extra.source;
            const setupErrors = [];
            try {
                ownChild(spawn(linux.executable, linux.args, {
                    cwd: linux.cwd,
                    env: linux.env,
                    stdio,
                    detached: true,
                }));
                linux.observe(child);
                const stream = child.stdio[3];
                if (!stream || typeof stream.write !== "function")
                    throw new Error(M.nativeSandbox.fd3);
                const launched = child;
                attachNativeTransport(launched, stream, error => {
                    if (!closing) {
                        if (launched.listenerCount("error"))
                            launched.emit("error", error);
                        void close().catch(() => { });
                    }
                });
                launched.once("disconnect", () => {
                    void close().catch(() => { });
                });
            }
            catch (error) {
                setupErrors.push(error);
            }
            try {
                linux.dispose();
            }
            catch (error) {
                setupErrors.push(error);
            }
            if (setupErrors.length === 1)
                throw setupErrors[0];
            if (setupErrors.length)
                throw startupFailure(setupErrors);
        }
        const launched = child;
        // 业务日志通过显式 RPC 记录，避免原始 stdout/stderr 阻塞子进程。
        launched.stdout?.resume();
        launched.stderr?.resume();
        return {
            child: launched,
            platform,
            pluginRoot,
            ready: ready,
            close,
            windowsCanonicalStats: platform === "win32"
                ? () => launched.sandboxCanonicalStats()
                : undefined,
        };
    }
    catch (error) {
        startup?.cancel(error);
        try {
            if (child)
                await close();
            else
                await cleanupRuntime();
        }
        catch (cleanupError) {
            throw startupFailure([error, cleanupError]);
        }
        throw startupFailure([error]);
    }
}
//# sourceMappingURL=launch.js.map
// Guard 自有导出登记。
import { registerModule as __guardRegisterExports } from "../protect/objects.js"
__guardRegisterExports("native-sandbox/launch.ts", { nativeStartupTimeoutMs, nativeStartupCleanupConfirmed, launchNativeSandbox })
