import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import { randomBytes } from "node:crypto";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { contextKey, stateDir } from "../shared/identity.js";
import { loadSettings } from "../config/index.js";
import { registerCurrentPm2Application } from "../pm2/auto.js";
import { inspectorDeadline } from "../pm2/inspector.js";
import { waitForBootstrapReady } from "../host/bootstrap/ready.js";
import { createBootstrapExitPlan } from "../host/bootstrap/exit-plan.js";
import { consoleRelayTimeout } from "../host/bootstrap/console-relay.js";
import { prepareNode } from "../dependencies/node.js";
import { M } from "../shared/messages.js";
import { guardCommandPatterns } from "../shared/commands.js";
/** 读取核心当前的 Redis 客户端。 */
const originalRedisClient = () => globalThis.redis;
const bootstrapStarted = new WeakSet();
/** 发送交接消息后退出当前进程。 */
function commitAndExit(send) {
    return new Promise((_, reject) => {
        send(error => {
            if (error)
                reject(error);
            else
                process.exit(0);
        });
    });
}
/** 读取 host.log 当前长度，作为控制台转印的起点。 */
function hostLogSize() {
    try {
        return fs.statSync(path.join(stateDir, "host.log")).size;
    }
    catch {
        return 0;
    }
}
/** 原进程的标准输出仍有去处（控制台、管道或文件）时才需要转印，NUL 等字符设备不算。 */
function hasOutput() {
    if (process.stdout.isTTY)
        return true;
    try {
        return !fs.fstatSync(1).isCharacterDevice();
    }
    catch {
        return false;
    }
}
/**
 * Windows 冷接管后宿主没有控制台：detached 子进程拿不到原控制台句柄，非 detached 子进程又会随原进程被结束。
 * 经 cmd 拉起的孙进程不在原进程的作业对象里，挂在原控制台上继续打印宿主输出，并且照常收到 Ctrl+C
 * （start /b 会屏蔽它）。转印进程还会暂停启动本进程的 shell 并接管键盘输入，体验与前台运行一致。
 * cmd 随原进程退出被结束，不影响孙进程。只影响显示与输入，失败时宿主照常接管。
 * 返回 held（shell 已暂停）、pty（mintty 等伪终端，只转印输出）、plain（只转印输出）或 undefined（未能拉起）。
 */
function startConsoleRelay(hostPid, offset) {
    const env = {
        ...process.env,
        YUNZAI_GUARD_CONSOLE_NODE: process.execPath,
        YUNZAI_GUARD_CONSOLE_SCRIPT: fileURLToPath(new URL("./console.js", import.meta.url)),
    };
    delete env.NODE_OPTIONS;
    const pipe = `\\\\.\\pipe\\yunzai-guard-console-${randomBytes(12).toString("hex")}`;
    return new Promise(resolve => {
        let timer;
        // 转印进程报告就绪才算挂好；cmd 必须在原进程退出前拉起它，否则会一起被结束。
        const server = net.createServer(socket => {
            let text = "";
            socket.setEncoding("utf8");
            socket.on("error", () => { });
            socket.on("data", chunk => (text += chunk));
            socket.on("end", () => finish(/^(held|pty|plain)\n/.exec(text)?.[1]));
        });
        const finish = (mode) => {
            clearTimeout(timer);
            server.close();
            resolve(mode);
        };
        server.on("error", () => finish(undefined));
        server.listen(pipe, () => {
            // 路径经环境变量展开并加引号，避免其中的 & ^ % 等字符被 cmd 解析。
            const relay = spawn(process.env.ComSpec || "cmd.exe", [
                "/d",
                "/s",
                "/c",
                `""%YUNZAI_GUARD_CONSOLE_NODE%" "%YUNZAI_GUARD_CONSOLE_SCRIPT%" ${hostPid} ${offset} ${pipe} ${process.pid} ${process.ppid}"`,
            ], {
                cwd: process.cwd(),
                env,
                stdio: "inherit",
                // 有控制台时不能隐藏：windowsHide 可能让 cmd 另开隐藏控制台，转印进程就挂不到本窗口上。
                windowsHide: !process.stdout.isTTY,
                windowsVerbatimArguments: true,
            });
            relay.once("error", () => finish(undefined));
            relay.once("exit", () => finish(undefined));
            timer = setTimeout(() => finish(undefined), consoleRelayTimeout);
        });
    });
}
export class YunzaiGuard extends plugin {
    /**
     * 以普通 Yunzai 插件注册，只承担冷接管入口与兜底提示。
     * 受管运行时会在核心加载本插件时换成运行时子类，命令与受限脚本分派都在其中处理；
     * 走到下面的规则，说明尚未接管或核心加载器桥接不可用。
     */
    constructor() {
        super({
            name: "Yunzai Guard",
            event: "message",
            priority: -1000000,
            rule: Object.values(guardCommandPatterns).map(pattern => ({
                reg: new RegExp(pattern),
                fnc: "unavailable",
                permission: "master",
            })),
        });
    }
    /** 兜底：说明当前无法通过聊天执行 Guard 命令。 */
    async unavailable() {
        const managed = Boolean(globalThis[contextKey]);
        await this.reply(managed ? M.entry.bridgeUnavailable : M.entry.commandUnavailable);
        return true;
    }
    /** 插件初始化：检查平台与配置，并在核心就绪后交接给受管宿主。 */
    async init() {
        const context = globalThis[contextKey];
        if (context)
            return;
        const managedByPm2 = process.env.pm_id !== undefined ||
            (process.env.PM2_HOME !== undefined && process.env.NODE_APP_INSTANCE !== undefined);
        if (managedByPm2 && !process.connected) {
            logger.error(M.entry.pm2NoIpc);
            process.exit(78);
        }
        // TRSS 官方 Docker 脚本与 node . daemon 以 node . start 启动（external），外部管理器跟踪这个进程本身。
        const external = global.start_type === "external" && !managedByPm2;
        if (external && (process.platform === "win32" || typeof process.execve !== "function")) {
            logger.error(M.entry.externalUnsupported);
            process.exit(78);
        }
        if (global.start_type !== "internal" && !managedByPm2 && !external) {
            logger.error(M.entry.unmanagedEntry);
            process.exit(78);
        }
        if (bootstrapStarted.has(Bot))
            return;
        let settings;
        try {
            settings = loadSettings(stateDir);
        }
        catch (error) {
            // 核心会捕获插件初始化异常；仅抛错会留下未受保护的机器人。
            console.error(M.entry.invalidSettings, error.message);
            process.exit(1);
        }
        bootstrapStarted.add(Bot);
        logger.info(M.entry.waiting);
        // 核心等待 init 完成，因此不能在此等待上线事件。
        void (external ? this.replaceInPlace(settings) : this.takeOverWhenReady(settings, managedByPm2)).catch(error => {
            console.error(M.entry.coldFailed, error.message);
            process.exit(managedByPm2 ? 78 : 1);
        });
    }
    /**
     * 外部托管时原地接管：核心就绪后释放原进程的资源，再用 execve 把本进程替换成 Guard 宿主。
     * PID 不变，Docker 的 1 号进程与 node . daemon 的子进程关系都保持原样，与 TRSS 自身的重启方式一致。
     */
    async replaceInPlace(settings) {
        const exitPlan = createBootstrapExitPlan(Bot, originalRedisClient(), originalRedisClient);
        await waitForBootstrapReady(Bot, settings.startupTimeout, new AbortController().signal);
        await exitPlan.prepare(settings.shutdownTimeout);
        exitPlan.assertCurrent();
        const env = { ...process.env, YUNZAI_GUARD_EXTERNAL: "1" };
        delete env.NODE_OPTIONS;
        logger.info(M.entry.replacing);
        process.execve(process.execPath, [process.execPath, fileURLToPath(new URL("../launcher.js", import.meta.url))], env);
    }
    /** 核心就绪后准备运行时并交接；下载在交接前完成，不调整已有 PM2 daemon。 */
    async takeOverWhenReady(settings, managedByPm2) {
        const hostExecutable = managedByPm2
            ? process.execPath
            : await prepareNode(fileURLToPath(new URL("../../", import.meta.url)));
        const exitPlan = createBootstrapExitPlan(Bot, originalRedisClient(), originalRedisClient);
        const readiness = new AbortController();
        let exiting = false;
        let bootstrapTimer;
        let registrationPending;
        if (managedByPm2)
            process.on("message", message => {
                if (message !== "shutdown" || exiting)
                    return;
                exiting = true;
                readiness.abort();
                clearTimeout(bootstrapTimer);
                void (async () => {
                    const registration = await registrationPending;
                    await exitPlan.prepare(settings.shutdownTimeout);
                    exitPlan.assertCurrent();
                    if (registration?.requiresHandoff && registration.nonce)
                        await commitAndExit(callback => process.send({ type: "yunzai-guard-pm2-exit-commit", nonce: registration.nonce }, callback));
                    else
                        process.exit(0);
                })().catch(error => {
                    logger.error(M.entry.exitCleanupFailed, error);
                    process.exit(1);
                });
            });
        try {
            await waitForBootstrapReady(Bot, settings.startupTimeout, readiness.signal);
        }
        catch (error) {
            if (exiting)
                return;
            throw error;
        }
        if (exiting)
            return;
        if (managedByPm2) {
            // 就绪独立计时；登记与交接共用启动预算，不得中途重置。
            const deadline = inspectorDeadline(settings.startupTimeout);
            const armWatchdog = (maximum) => {
                const remaining = Math.floor(Math.min(maximum, deadline.remainingMs()));
                if (remaining <= 0)
                    throw new Error(M.entry.pm2Deadline);
                clearTimeout(bootstrapTimer);
                bootstrapTimer = setTimeout(() => {
                    logger.error(M.entry.pm2Timeout);
                    process.exit(78);
                }, remaining);
            };
            armWatchdog(settings.startupTimeout);
            try {
                registrationPending = registerCurrentPm2Application({
                    root: process.cwd(),
                    launcherPath: fileURLToPath(new URL("../launcher.js", import.meta.url)),
                    shutdownTimeout: settings.shutdownTimeout,
                    startupTimeout: settings.startupTimeout,
                    requestRestart: true,
                    bootstrapRedisPid: exitPlan.redisPid,
                }, deadline);
                const registration = await registrationPending;
                if (exiting)
                    return;
                if (!registration?.requiresHandoff || !registration.nonce)
                    throw new Error(M.entry.pm2Unauthorized);
                armWatchdog(settings.handshakeTimeout);
                process.send?.({ type: "yunzai-guard-pm2-handoff", nonce: registration.nonce }, error => {
                    if (error)
                        process.exit(78);
                });
                // 登记已请求重启；关闭处理器负责退出，仍受交接期限约束。
                await new Promise(() => { });
            }
            catch (error) {
                clearTimeout(bootstrapTimer);
                if (exiting)
                    return;
                logger.error(M.entry.pm2Failed, error);
                process.exit(78);
            }
        }
        const env = { ...process.env };
        delete env.NODE_OPTIONS;
        const logOffset = hostLogSize();
        const host = spawn(hostExecutable, [
            fileURLToPath(new URL("../host/supervisor.js", import.meta.url)),
            String(process.pid),
            exitPlan.redisPid === null ? "none" : String(exitPlan.redisPid),
        ], {
            cwd: process.cwd(),
            env,
            // Windows detached 进程不能继承控制台句柄；Linux 保留 terminal/screen 输出。
            stdio: [
                process.platform === "win32" ? "ignore" : "inherit",
                process.platform === "win32" ? "ignore" : "inherit",
                process.platform === "win32" ? "ignore" : "inherit",
                "ipc",
            ],
            windowsHide: true,
            detached: true,
        });
        // 与交接并行拉起，原进程退出前确认转印进程已挂上控制台。
        const relay = process.platform === "win32" && host.pid && hasOutput()
            ? startConsoleRelay(host.pid, logOffset)
            : undefined;
        try {
            const nonce = await new Promise((resolve, reject) => {
                const timer = setTimeout(() => reject(new Error(M.entry.handoffTimeout)), settings.handshakeTimeout);
                const fail = (error) => {
                    clearTimeout(timer);
                    reject(error);
                };
                host.once("error", fail);
                host.once("exit", code => fail(new Error(M.entry.handoffExited(code))));
                host.on("message", (message) => {
                    const reply = message;
                    if (reply?.type !== "armed" ||
                        reply.version !== 1 ||
                        typeof reply.nonce !== "string" ||
                        !/^[a-f0-9]{48}$/.test(reply.nonce))
                        return;
                    clearTimeout(timer);
                    resolve(reply.nonce);
                });
            });
            const mode = await relay;
            if (mode)
                logger.info(mode === "held"
                    ? M.entry.consoleHeld
                    : mode === "pty"
                        ? M.entry.consolePty
                        : M.entry.consoleRelay);
            await exitPlan.prepare(settings.shutdownTimeout);
            exitPlan.assertCurrent();
            await commitAndExit(callback => host.send({ type: "bootstrap-handoff-commit", version: 1, nonce }, callback));
        }
        catch (error) {
            console.error(M.entry.takeoverFailed, error.message);
            // 断开连接会拒绝未提交的交接，并让宿主关闭其私有观察器。
            // 直接终止宿主会跳过这一步异步清理。
            if (host.pid && host.exitCode === null && host.signalCode === null) {
                let timer;
                try {
                    await new Promise((resolve, reject) => {
                        const exited = () => {
                            clearTimeout(timer);
                            resolve();
                        };
                        host.once("exit", exited);
                        timer = setTimeout(() => {
                            host.off("exit", exited);
                            reject(new Error(M.entry.cancelUnconfirmed));
                        }, settings.handshakeTimeout + settings.shutdownTimeout + 5000);
                        if (host.connected)
                            host.disconnect();
                    });
                }
                catch (cleanupError) {
                    console.error(M.entry.cancelCleanup, cleanupError.message);
                }
                finally {
                    clearTimeout(timer);
                }
            }
            process.exit(1);
        }
    }
}
//# sourceMappingURL=plugin.js.map
// Guard 自有导出登记。
import { registerModule as __guardRegisterExports } from "../protect/objects.js"
__guardRegisterExports("entry/plugin.ts", { YunzaiGuard })
