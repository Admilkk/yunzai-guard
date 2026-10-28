import fs from "node:fs";
import path from "node:path";
import { registerHooks } from "node:module";
import { pathToFileURL } from "node:url";
import { coreProtocolVersion } from "../web/core-protocol.js";
import { M } from "../shared/messages.js";
const generationKey = "guard-core";
let hooksInstalled = false;
/**
 * 让同一代控制台的模块图整体重新加载：入口地址带上代号后，它导入的本地模块继承同一代号，
 * 得到一份独立的新模块实例。宿主自身导入的模块不带代号，不受影响。
 */
function installGenerationHooks() {
    if (hooksInstalled)
        return;
    hooksInstalled = true;
    registerHooks({
        resolve(specifier, context, nextResolve) {
            const result = nextResolve(specifier, context);
            const parent = context.parentURL;
            if (!parent?.startsWith("file:") || !result.url.startsWith("file:"))
                return result;
            const generation = new URL(parent).searchParams.get(generationKey);
            if (!generation || new URL(result.url).search)
                return result;
            return { ...result, url: `${result.url}?${generationKey}=${generation}` };
        },
    });
}
/**
 * 控制台的宿主端：在宿主进程内加载、停止与替换控制台。
 * 热替换时以新代号重新加载控制台模块，宿主与业务进程不受影响；旧模块停止服务后不再运行任何任务，
 * 但 ES 模块无法卸载，其代码会保留到宿主下次重启（每次约数 MB）。
 * 控制台从哪个插件目录加载由调用方决定，等待业务侧更新时可以先从暂存目录运行新版本。
 */
export class CoreHost {
    #options;
    #running;
    #generation = 0;
    /** 上一个控制台交出的内存会话，下一次启动时交给新控制台。 */
    #handover;
    /** 创建控制台管理器。 */
    constructor(options) {
        this.#options = options;
    }
    /** 当前控制台所在的插件目录。 */
    get pluginDir() {
        return this.#running?.pluginDir;
    }
    /** 当前控制台的版本。 */
    get version() {
        return this.#running?.version;
    }
    /** 从指定插件目录加载并启动控制台。 */
    async start(pluginDir) {
        if (this.#running)
            return true;
        const entry = path.join(pluginDir, "dist", "web", "index.js");
        if (!fs.existsSync(entry)) {
            this.#options.record("core-start-failed", { pluginDir, message: "missing-entry" });
            return false;
        }
        // 首次加载与宿主共用共享模块；之后每次替换都用新代号加载一份独立的模块图。
        const generation = this.#generation++;
        let url = pathToFileURL(entry).href;
        if (generation > 0) {
            installGenerationHooks();
            url += `?${generationKey}=${generation}`;
        }
        let panel;
        let listening;
        try {
            panel = (await import(url));
            if (panel.coreProtocol !== coreProtocolVersion)
                throw new Error(`protocol ${String(panel.coreProtocol)}`);
            listening = await panel.startPanel({ ...this.#options.panel(), handover: this.#handover });
        }
        catch (error) {
            this.#options.record("core-start-failed", { pluginDir, message: error.message });
            return false;
        }
        const version = panel.panelVersion();
        this.#running = { panel, pluginDir, version };
        this.#handover = undefined;
        this.#options.record("core-started", { pluginDir, version, listening, generation });
        return true;
    }
    /** 停止控制台：交出内存会话后关闭端口与连接。 */
    async stop() {
        const running = this.#running;
        if (!running)
            return;
        this.#running = undefined;
        try {
            this.#handover = running.panel.panelHandover();
            await running.panel.stopPanel();
        }
        catch (error) {
            this.#options.record("core-stop-failed", { message: error.message });
        }
        this.#options.record("core-stopped", { pluginDir: running.pluginDir });
    }
    /**
     * 换成另一个插件目录中的控制台。新控制台未能启动时回到原目录，返回 false。
     * 控制台在两次监听之间短暂不可用，浏览器会自动重连。
     */
    async swap(pluginDir) {
        const previous = this.#running?.pluginDir;
        await this.stop();
        if (await this.start(pluginDir))
            return true;
        if (previous)
            await this.start(previous);
        return false;
    }
    /** 请求控制台生成一次性登录链接。 */
    async loginLink() {
        const running = this.#running;
        if (!running)
            throw new Error(M.web.linkPanelOff);
        return running.panel.panelLoginLink();
    }
}
//# sourceMappingURL=core.js.map
// Guard 自有导出登记。
import { registerModule as __guardRegisterExports } from "../protect/objects.js"
__guardRegisterExports("host/core.ts", { CoreHost })
