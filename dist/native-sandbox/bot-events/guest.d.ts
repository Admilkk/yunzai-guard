import { type NativeBotEventFrame, type NativeBotEventValue } from "./protocol.js";
export interface NativeBotEventsGuestOptions {
    /** 宿主在本原生会话认证引导中签发的令牌。 */
    sessionId: string;
    /** 构建插件本地回复代理，此处不得传入宿主函数。 */
    restoreArgs?(args: NativeBotEventValue[]): unknown[] | Promise<unknown[]>;
}
/** 原回调对象始终留在受限插件进程。 */
export declare class NativeBotEventsGuest {
    private readonly send;
    private readonly options;
    readonly sessionId: string;
    private readonly subscriptions;
    private sequence;
    private receiver;
    private closed;
    private failed;
    private readonly deliveredExit;
    private readonly inFlightExit;
    private readonly exitContext;
    private exitDispatch?;
    /** 创建沙箱内的 Bot 事件监听代理。 */
    constructor(send: (frame: NativeBotEventFrame) => void, options: NativeBotEventsGuestOptions);
    /** 当前监听数量。 */
    get size(): number;
    /** 绑定监听回调中的 this。 */
    bindThis(botFacade: object): this;
    /** 确认代理未被释放。 */
    private active;
    /** 分配下一个监听序号。 */
    private next;
    /** 向宿主发布监听变化。 */
    private publish;
    /** 添加监听。 */
    on(event: unknown, callback: unknown, once?: boolean): this;
    /** 添加一次性监听。 */
    once(event: unknown, callback: unknown): this;
    /** 移除监听。 */
    off(event: unknown, callback: unknown): this;
    /** 移除监听（off 的别名）。 */
    removeListener(event: unknown, callback: unknown): this;
    /** 移除事件或全部事件的监听。 */
    clear(event?: unknown): this;
    /** 移除全部监听（clear 的别名）。 */
    removeAllListeners(event?: unknown): this;
    /** 执行宿主转来的事件回调。 */
    dispatch(id: unknown, input: unknown): Promise<void>;
    /** 原生清理器在 close 前调用此方法，不向宿主发送合成事件。 */
    dispatchExit(input?: unknown): Promise<void>;
    /** 以宿主关闭为准；此帧仅尽力通知插件正常关闭。 */
    close(): void;
}
