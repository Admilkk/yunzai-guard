import { timingSafeEqual } from "node:crypto";
/** 冷启动代次持有此记录，直到提交及系统进程退出均已确认。 */
export class Pm2BootstrapExit {
    child;
    nonce;
    watch;
    valid;
    onFailure;
    exited;
    released = false;
    committed = false;
    rootExited = false;
    resourcesExited = false;
    failure;
    settling = false;
    resolve;
    reject;
    timer;
    closing;
    /** 是否已失败。 */
    get failed() {
        return this.failure !== undefined;
    }
    /** 创建首次接管的原进程退出门控。 */
    constructor(child, nonce, watch, timeout, valid, onFailure) {
        this.child = child;
        this.nonce = nonce;
        this.watch = watch;
        this.valid = valid;
        this.onFailure = onFailure;
        this.exited = new Promise((resolve, reject) => {
            this.resolve = resolve;
            this.reject = reject;
        });
        void this.exited.catch(() => { });
        this.timer = setTimeout(() => this.fail("bootstrap-exit-timeout"), timeout);
        this.timer.unref();
        child.once("exit", this.onExit);
        child.on("message", this.onMessage);
        void watch.exited.then(() => {
            this.resourcesExited = true;
            this.check();
        }, () => this.fail("bootstrap-resource-watch-failed"));
    }
    /** 处理原进程的退出准备消息。 */
    onMessage = (message) => {
        if (!message || typeof message !== "object")
            return;
        const value = message;
        if (value.type !== "yunzai-guard-pm2-exit-commit" ||
            typeof value.nonce !== "string" ||
            value.nonce.length > 128)
            return;
        if (Buffer.byteLength(value.nonce) !== Buffer.byteLength(this.nonce) ||
            !timingSafeEqual(Buffer.from(value.nonce), Buffer.from(this.nonce)))
            return;
        if (this.committed || this.failure || this.released)
            return;
        if (!this.valid())
            return this.fail("bootstrap-generation-changed");
        this.committed = true;
        this.check();
    };
    /** 原进程退出时检查是否成功。 */
    onExit = (code, signal) => {
        if (code !== 0 || signal !== null)
            return this.fail("bootstrap-exit-not-successful");
        this.rootExited = true;
        this.check();
    };
    /** 关闭退出观察，只执行一次。 */
    closeWatch() {
        return (this.closing ??= Promise.resolve().then(() => this.watch.close()));
    }
    /** 清理定时器与监听器。 */
    cleanup() {
        clearTimeout(this.timer);
        this.child.removeListener("exit", this.onExit);
        this.child.removeListener("message", this.onMessage);
    }
    /** 条件满足时放行或判定失败。 */
    check() {
        if (this.failure || this.released || this.settling)
            return;
        if (!this.valid())
            return this.fail("bootstrap-generation-changed");
        if (!this.committed || !this.rootExited || !this.resourcesExited)
            return;
        this.settling = true;
        void this.closeWatch().then(() => {
            if (this.failure)
                return;
            if (!this.valid())
                return this.fail("bootstrap-generation-changed");
            this.released = true;
            this.cleanup();
            this.resolve();
        }, () => this.fail("bootstrap-observer-cleanup-failed"));
    }
    /** 以原因标记失败并清理。 */
    fail(reason) {
        if (this.failure || this.released)
            return;
        this.failure = reason;
        this.cleanup();
        this.reject(new Error(reason));
        void this.closeWatch().catch(() => { });
        try {
            this.onFailure(reason);
        }
        catch { }
    }
}
//# sourceMappingURL=bootstrap-exit.js.map
// Guard 自有导出登记。
import { registerModule as __guardRegisterExports } from "../protect/objects.js"
__guardRegisterExports("pm2/bootstrap-exit.ts", { Pm2BootstrapExit })
