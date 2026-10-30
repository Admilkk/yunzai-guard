import { type AdapterId } from "./adapter/protocol.js";
export interface NativeBotSnapshot {
    uin: AdapterId[];
}
/** 解析并校验 Bot 快照。 */
export declare function parseNativeBotSnapshot(input: unknown): NativeBotSnapshot;
/** 不序列化 Bot、uin.toJSON 方法、活动 SDK 或账号对象。 */
export declare function snapshotNativeBot(bot: unknown): NativeBotSnapshot;
