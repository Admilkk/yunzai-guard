import fs from "node:fs";
import path from "node:path";
import { M } from "../shared/messages.js";
import { field, notice } from "../shared/notice.js";
import { readJsonFile, writeJsonFile } from "../shared/files.js";
import { inWindow } from "../shared/update-window.js";
import { compareVersions } from "../shared/version.js";
import { fetchRelease, gitBranch, gitSync, releaseBranch, versionAt } from "../update/git.js";
import { crossesMajor, fetchLatestRelease, isNewer } from "../update/release.js";
import { clearWork, stageCommit, stageRelease, swapPackage, workPaths, } from "../update/install.js";
import { exportCommit } from "../update/git.js";
import { planUpdate, readManifest } from "../update/plan.js";
/**
 * 判断等待中的业务侧更新是否到了执行时机：
 * now 立即；window 只在维护时段；idle 等业务连续空闲，超过最长等待后直接执行。
 */
export function pendingDue(input) {
    const { since, settings, lastActivityAt, now } = input;
    if (settings.workerRestart === "now")
        return true;
    if (settings.workerRestart === "window")
        return inWindow(settings.window, new Date(now));
    if (now - since >= settings.maxWaitHours * 3600_000)
        return true;
    return now - lastActivityAt >= settings.idleSeconds * 1000;
}
const firstCheckDelayMs = 15000;
const maxPending = 5;
const maxNoticeChars = 1500;
/** 读取插件当前版本。 */
function readVersion(pluginDir) {
    try {
        const parsed = JSON.parse(fs.readFileSync(path.join(pluginDir, "package.json"), "utf8"));
        return typeof parsed.version === "string" ? parsed.version : "unknown";
    }
    catch {
        return "unknown";
    }
}
/** 把更新说明整理成分类条目，去掉 Markdown 链接与提交引用；每类最多 3 条。 */
export function changelog(notes) {
    /** 去掉 Markdown 链接、提交引用、作用域前缀与强调符号。 */
    const plain = (text) => text
        .replace(/\s*\(\[[0-9a-f]{7,}\]\([^)]*\)\)/g, "")
        .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
        .replace(/^\*\*[^*]+:\*\*\s*/, "")
        .replace(/[*_`]/g, "")
        .trim();
    const sections = [];
    for (const line of notes.replace(/\r/g, "").split("\n")) {
        const heading = /^#{3,}\s+(.+)$/.exec(line);
        const item = /^\s*[*-]\s+(.+)$/.exec(line);
        if (heading)
            sections.push({ title: plain(heading[1]), items: [] });
        else if (item) {
            if (!sections.length)
                sections.push({ title: "", items: [] });
            sections.at(-1).items.push(plain(item[1]));
        }
    }
    const lines = sections
        .filter(section => section.items.length)
        .slice(0, 4)
        .flatMap(section => [
        section.title,
        ...section.items.slice(0, 3).map(text => `· ${text.slice(0, 80)}`),
        section.items.length > 3 ? `· 等 ${section.items.length} 项` : "",
    ])
        .filter(Boolean);
    if (lines.length)
        return lines;
    // 非约定格式的说明：保留前几行纯文本。
    return notes
        .replace(/\r/g, "")
        .split("\n")
        .map(line => plain(line.replace(/^[#>*\-\s]+/, "")))
        .filter(Boolean)
        .slice(0, 4)
        .map(line => line.slice(0, 80));
}
/**
 * 版本检查与更新编排：周期查询公开发布、通知主人、暂存发布包。
 * 文件替换由宿主生命周期队列在业务进程停止后执行。
 */
export class UpdateService {
    #options;
    #file;
    #stored = { pending: [] };
    #timer;
    #checking;
    #busy = false;
    #stopped = false;
    #phase = "idle";
    #message;
    #error;
    #hostRestartPending = false;
    /** 启动或提交更新时解析，避免状态查询反复执行 git show。 */
    #previousVersion;
    #plan;
    #pending;
    #verifyFile;
    /** 载入持久化检查结果、待发通知与回滚目标，并解析上一版本。 */
    constructor(options) {
        this.#options = options;
        this.#file = path.join(options.stateDir, "update.json");
        this.#verifyFile = path.join(options.stateDir, "update-verify.json");
        try {
            const value = (readJsonFile(this.#file) ?? {});
            this.#stored = {
                etag: typeof value.etag === "string" ? value.etag : undefined,
                checkedAt: typeof value.checkedAt === "number" ? value.checkedAt : undefined,
                release: value.release,
                notified: typeof value.notified === "string" ? value.notified : undefined,
                pending: Array.isArray(value.pending)
                    ? value.pending
                        .filter((item) => typeof item === "string")
                        .slice(-maxPending)
                    : [],
                lastResult: value.lastResult,
                previousCommit: typeof value.previousCommit === "string" &&
                    /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(value.previousCommit)
                    ? value.previousCommit
                    : undefined,
            };
        }
        catch {
            // 首次运行或文件损坏时从空状态开始。
        }
        if (this.#stored.previousCommit)
            this.#previousVersion = versionAt(options.pluginDir, this.#stored.previousCommit);
    }
    /** 读取轻量元数据与已解析的回滚版本，供面板、命令与 CLI 展示；不启动子进程。 */
    state() {
        const git = fs.existsSync(path.join(this.#options.pluginDir, ".git"));
        const branch = git ? gitBranch(this.#options.pluginDir) : undefined;
        const settings = this.#options.settings();
        const current = readVersion(this.#options.pluginDir);
        const release = this.#stored.release;
        return {
            current,
            installMode: git ? "git" : "release",
            gitBranch: branch,
            autoUpdate: !git || branch === releaseBranch,
            enabled: settings.check,
            intervalMs: settings.intervalMs,
            checking: Boolean(this.#checking),
            checkedAt: this.#stored.checkedAt,
            error: this.#error,
            latest: release && {
                version: release.version,
                name: release.name,
                notes: release.notes,
                url: release.url,
                publishedAt: release.publishedAt,
            },
            available: Boolean(release && isNewer(release.version, current)),
            phase: this.#phase,
            message: this.#message,
            hostRestartPending: this.#hostRestartPending,
            rollback: this.#previous(),
            lastResult: this.#stored.lastResult,
            plan: this.#plan && { level: this.#plan.level, changed: this.#plan.changed.length },
            pending: this.#pending && {
                version: this.#pending.staged.version,
                since: this.#pending.since,
                rollback: this.#pending.rollback,
            },
        };
    }
    /** 开始周期检查；首次检查稍后进行，避免与启动抢占资源。 */
    start() {
        this.#stopped = false;
        this.#schedule(firstCheckDelayMs);
    }
    /** 停止周期检查。 */
    stop() {
        this.#stopped = true;
        clearTimeout(this.#timer);
    }
    /** 补发留存的通知。 */
    flush() {
        if (!this.#stored.pending.length)
            return;
        this.#stored.pending = this.#stored.pending.filter(text => !this.#options.send(text));
        this.#save();
    }
    /** 发送通知；业务进程不在线时留存，defer 为真时不尝试立即发送。 */
    notify(text, defer = false) {
        const body = text.slice(0, maxNoticeChars);
        if (!defer && this.#options.send(body))
            return;
        this.#stored.pending = [...this.#stored.pending, body].slice(-maxPending);
        this.#save();
    }
    /** 检查最新版本；并发调用共用同一次请求。manual 为真时忽略 ETag 并无视关闭开关。 */
    check(manual = false) {
        if (!manual && !this.#options.settings().check)
            return Promise.resolve(this.state());
        this.#checking ??= this.#fetch(manual).finally(() => {
            this.#checking = undefined;
        });
        return this.#checking.then(() => this.state());
    }
    /**
     * 暂存最新发布、比较组件得出更新级别，再交给生命周期队列。force 允许重装当前版本或跨主版本升级，
     * 低于当前版本的发布仍拒绝；必须成功检查发布信息，不以旧缓存替代失败响应。
     * immediate 为真时，需要重启业务进程的更新马上执行，不等待空闲。
     * 已有等待生效的更新时，再次请求更新即视为要求马上生效。
     */
    async apply(force, immediate = false) {
        if (this.#pending)
            return this.applyPending();
        if (this.#busy)
            return { ok: false, message: M.update.busy };
        const state = this.state();
        if (!state.autoUpdate)
            return { ok: false, message: M.update.gitSource };
        this.#busy = true;
        let target;
        try {
            this.#phase = "downloading";
            this.#message = undefined;
            await this.check(true);
            if (this.#error)
                throw new Error(this.#error);
            const release = this.#stored.release;
            if (!release)
                throw new Error(this.#error ?? M.update.fetchFailed("无发布信息"));
            const current = state.current;
            target = release.version;
            if ((compareVersions(release.version, current) ?? 0) < 0)
                throw new Error(M.update.downgrade(current, release.version));
            if (!force && !isNewer(release.version, current)) {
                this.#phase = "idle";
                this.#busy = false;
                return {
                    ok: false,
                    message: `已是最新版本 ${current}，如需重新安装请使用强制更新`,
                };
            }
            if (!force && crossesMajor(release.version, current))
                throw new Error(M.update.majorBlocked(current, release.version));
            this.#message = `正在下载 ${release.version}`;
            const pluginDir = this.#options.pluginDir;
            const staged = state.installMode === "git"
                ? await stageCommit(pluginDir, (await fetchRelease(pluginDir, release.version, force)).commit, release.version, (commit, file) => exportCommit(pluginDir, commit, file))
                : await stageRelease(release, pluginDir, current);
            return this.#install(staged, current, false, immediate, force);
        }
        catch (error) {
            this.#fail(error.message);
            return { ok: false, message: error.message, failed: true, to: target };
        }
    }
    /** 比较组件、通知开始并排入生命周期队列。 */
    #install(staged, current, rollback, immediate, force = false) {
        const plan = planUpdate(readManifest(this.#options.pluginDir), readManifest(staged.directory));
        this.#plan = plan;
        const deferred = plan.level === "worker" && !immediate && this.#options.settings().workerRestart !== "now";
        const effect = {
            static: "本次仅更新 Web 控制台，机器人运行不受影响。",
            core: "Web 控制台将热替换，机器人运行不受影响。",
            worker: deferred
                ? "Web 控制台将先行更新，业务侧更新将在机器人空闲时生效；如需立即生效，请再次发送 #guard更新。"
                : "业务进程将重启一次。",
            host: "宿主将重新启动一次。",
        }[plan.level];
        const verb = rollback ? "还原" : "更新";
        this.#phase = "installing";
        this.#message = `正在${verb}至 ${staged.version}`;
        this.#options.record(rollback ? "update-rollback-staged" : "update-staged", {
            from: current,
            to: staged.version,
            force,
            level: plan.level,
            changed: plan.changed.length,
            reason: plan.reason,
        });
        const impact = {
            static: ["仅更新 Web 控制台，机器人不受影响"],
            core: ["热替换 Web 控制台，机器人不受影响"],
            worker: deferred
                ? ["Web 控制台先行更新，业务侧在机器人空闲时生效", "如需立即生效，请再次发送 #guard更新"]
                : ["业务进程将重启一次"],
            host: ["宿主将重启一次，机器人会短暂离线"],
        }[plan.level];
        const text = `开始${verb}：${current} → ${staged.version}。${effect}`;
        this.notify(notice(`🔄 开始${verb}`, field("版本", `${current} → ${staged.version}`), field("影响", impact[0]), impact[1]));
        this.#options.install({ ...staged, plan }, current, rollback, immediate);
        return { ok: true, message: text };
    }
    /** 读取保留的上一版本号；没有或不完整时返回 undefined。 */
    #previous() {
        if (fs.existsSync(path.join(this.#options.pluginDir, ".git"))) {
            const version = this.#previousVersion;
            return version ? { version } : undefined;
        }
        try {
            const manifest = JSON.parse(fs.readFileSync(path.join(workPaths(this.#options.pluginDir).previous, "package.json"), "utf8"));
            return typeof manifest.version === "string" ? { version: manifest.version } : undefined;
        }
        catch {
            return undefined;
        }
    }
    /** 把保留的上一版本复制为暂存包；Git 安装导出原提交。 */
    async #stagePrevious(version) {
        const pluginDir = this.#options.pluginDir;
        if (fs.existsSync(path.join(pluginDir, ".git"))) {
            const commit = this.#stored.previousCommit;
            if (!commit)
                throw new Error(M.update.noPrevious);
            return stageCommit(pluginDir, commit, version, (target, file) => exportCommit(pluginDir, target, file));
        }
        const paths = workPaths(pluginDir);
        clearWork(pluginDir);
        fs.mkdirSync(paths.staged, { recursive: true });
        const directory = path.join(paths.staged, "yunzai-guard");
        // 调度失败会清理暂存目录，原备份须保留到真正替换文件时。
        fs.cpSync(paths.previous, directory, { recursive: true });
        return { version, directory };
    }
    /**
     * 还原到上一版本：同样按组件比较，能热替换时不重启。
     * 有等待生效的更新时，还原即取消这次更新，控制台回到当前文件。
     */
    async rollback() {
        const pending = this.#pending;
        if (pending) {
            this.#pending = undefined;
            await this.#options.cancelPending();
            clearWork(this.#options.pluginDir);
            this.#busy = false;
            this.#phase = "idle";
            this.#message = undefined;
            this.#options.record("update-pending-cancelled", { version: pending.staged.version });
            return { ok: true, message: M.update.pendingCancelled(pending.staged.version) };
        }
        if (this.#busy)
            return { ok: false, message: M.update.busy };
        const state = this.state();
        if (!state.autoUpdate)
            return { ok: false, message: M.update.gitSource };
        const previous = this.#previous();
        if (!previous)
            return { ok: false, message: M.update.noPrevious };
        this.#busy = true;
        try {
            const current = readVersion(this.#options.pluginDir);
            const staged = await this.#stagePrevious(previous.version);
            return this.#install(staged, current, true, true);
        }
        catch (error) {
            this.#fail(error.message);
            return { ok: false, message: error.message, failed: true, to: previous.version };
        }
    }
    /** 由生命周期队列在业务进程停止后调用，执行文件替换。 */
    swap(staged) {
        this.#phase = "restarting";
        this.#message = M.update.restarting(staged.version);
        if (!staged.commit)
            return swapPackage(staged, this.#options.pluginDir);
        // Git 安装：切换到目标提交；还原时切回原提交，完成后记录原提交供之后还原。
        // reset --hard 只改写内容变化的文件，热更新时同样可用。
        const directory = this.#options.pluginDir;
        const before = gitSync(directory, ["rev-parse", "HEAD"]);
        const previousVersion = versionAt(directory, before);
        gitSync(directory, ["reset", "--hard", "--quiet", staged.commit]);
        return {
            rollback: () => {
                gitSync(directory, ["reset", "--hard", "--quiet", before]);
            },
            commit: () => {
                this.#stored.previousCommit = before;
                this.#previousVersion = previousVersion;
                this.#save();
            },
        };
    }
    /** 业务侧更新改为等待：控制台已换成新版本，业务进程择时重启。 */
    defer(staged, from, rollback) {
        this.#pending = { staged, from, since: Date.now(), rollback };
        this.#phase = "pending";
        this.#message = undefined;
        this.#options.record("update-deferred", { from, to: staged.version });
        this.notify(notice("⏳ 等待空闲生效", field("版本", `${from} → ${staged.version}`), `Web 控制台已${rollback ? "还原" : "更新"}，业务侧更新将在机器人空闲时生效`, "如需立即生效，请再次发送 #guard更新"));
    }
    /** 等待中的更新；用于判断是否到了执行时机。 */
    get pending() {
        return this.#pending && { version: this.#pending.staged.version, since: this.#pending.since };
    }
    /** 立即执行等待中的更新：重启业务进程使其生效。 */
    applyPending() {
        const pending = this.#pending;
        if (!pending)
            return Promise.resolve({ ok: false, message: M.update.noPending });
        this.#pending = undefined;
        this.#phase = "installing";
        this.#options.record("update-pending-apply", { to: pending.staged.version });
        try {
            this.#options.install(pending.staged, pending.from, pending.rollback, true);
        }
        catch (error) {
            this.#pending = pending;
            this.#phase = "pending";
            return Promise.resolve({ ok: false, message: error.message });
        }
        return Promise.resolve({ ok: true, message: M.update.pendingStarted });
    }
    /** 宿主重新启动前记录待确认的更新，新宿主上线后据此确认成功或还原。 */
    markVerify(value) {
        writeJsonFile(this.#verifyFile, { ...value, attempts: 0, at: Date.now() });
    }
    /** 读取待确认的更新并累加启动次数；没有时返回 undefined。 */
    takeVerify() {
        try {
            const value = readJsonFile(this.#verifyFile);
            if (typeof value?.from !== "string" || typeof value.to !== "string")
                return undefined;
            const attempts = (Number.isSafeInteger(value.attempts) ? Number(value.attempts) : 0) + 1;
            writeJsonFile(this.#verifyFile, { ...value, attempts });
            return {
                from: value.from,
                to: value.to,
                rollback: value.rollback === true,
                revert: value.revert === true,
                attempts,
            };
        }
        catch {
            return undefined;
        }
    }
    /** 清除待确认记录。 */
    clearVerify() {
        fs.rmSync(this.#verifyFile, { force: true });
    }
    /** 新宿主上的更新未能上线：把保留的上一版本暂存起来用于还原。 */
    async stageRevert(version) {
        this.#busy = true;
        const staged = await this.#stagePrevious(version);
        return { ...staged, plan: { level: "host", changed: [] } };
    }
    /** 更新结束：记录结果并通知主人。 */
    finish(result) {
        const at = Date.now();
        this.#busy = false;
        this.#pending = undefined;
        clearWork(this.#options.pluginDir);
        this.#phase = result.ok ? "idle" : "failed";
        this.#hostRestartPending = result.ok && result.mode === "host-pending";
        this.#message = result.ok ? undefined : result.message;
        const verb = result.rollback ? "还原" : "更新";
        const effect = {
            hot: "机器人运行未中断",
            worker: "业务进程已重启",
            relaunch: "宿主已重新启动",
            "host-pending": "需重启宿主后完全生效",
        }[result.mode];
        const version = field("版本", `${result.from} → ${result.to}`);
        const text = result.ok
            ? notice(`✅ ${verb}完成`, version, effect)
            : notice(`❌ ${verb}失败`, version, field("原因", result.message ?? "原因未知"));
        this.#stored.lastResult = {
            ok: result.ok,
            version: result.to,
            message: result.ok ? `${verb}成功` : (result.message ?? `${verb}失败`),
            at,
        };
        this.#save();
        this.#options.record(result.ok ? "update-complete" : "update-failed", {
            from: result.from,
            to: result.to,
            mode: result.mode,
            message: result.message,
        });
        this.notify(text);
    }
    /** 记录暂存阶段的失败；结果文本由调用方回复给发起人。 */
    #fail(message) {
        this.#busy = false;
        this.#phase = "failed";
        this.#message = message;
        this.#options.record("update-failed", { message });
        clearWork(this.#options.pluginDir);
    }
    /** 安排下一次检查。 */
    #schedule(delay) {
        clearTimeout(this.#timer);
        if (this.#stopped)
            return;
        this.#timer = setTimeout(() => {
            void this.check().finally(() => this.#schedule(this.#options.settings().intervalMs));
        }, delay);
        this.#timer.unref();
    }
    /** 查询发布并在发现未通知过的新版本时提醒主人。 */
    async #fetch(manual) {
        const current = readVersion(this.#options.pluginDir);
        try {
            const result = await fetchLatestRelease(current, manual ? undefined : this.#stored.etag);
            if (result.release)
                this.#stored.release = result.release;
            this.#stored.etag = result.etag;
            this.#stored.checkedAt = Date.now();
            this.#error = undefined;
        }
        catch (error) {
            this.#error = error.message;
            this.#options.record("update-check-failed", { message: this.#error });
            return;
        }
        const release = this.#stored.release;
        if (release &&
            isNewer(release.version, current) &&
            this.#stored.notified !== release.version &&
            this.#options.settings().notify) {
            this.#stored.notified = release.version;
            this.#options.record("update-available", { current, latest: release.version });
            this.notify(notice("🆕 发现新版本", field("版本", `${current} → ${release.version}`), ...changelog(release.notes), "发送 #guard更新 开始更新", field("详情", release.url)));
        }
        this.#save();
    }
    /** 保存状态；写入失败只影响跨重启的去重与补发。 */
    #save() {
        try {
            writeJsonFile(this.#file, this.#stored);
        }
        catch {
            // 状态文件不可写时仅丢失缓存，不影响更新流程。
        }
    }
}
//# sourceMappingURL=update.js.map
// Guard 自有导出登记。
import { registerModule as __guardRegisterExports } from "../protect/objects.js"
__guardRegisterExports("host/update.ts", { pendingDue, changelog, UpdateService })
