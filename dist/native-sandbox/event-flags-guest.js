/** 仅在最终插件事件对象上重建 DTO 标记的核心游戏标志。 */
export function restoreNativeEventFlags(record) {
    for (const [flag, game, other] of [
        ["isSr", "sr", "gs"],
        ["isGs", "gs", "sr"],
    ]) {
        const descriptor = Object.getOwnPropertyDescriptor(record, flag);
        if (!descriptor ||
            !("value" in descriptor) ||
            typeof descriptor.value !== "boolean" ||
            !descriptor.configurable)
            continue;
        // 核心访问器通过闭包引用自身事件，不使用调用方的 this。
        const event = record;
        Object.defineProperty(record, flag, {
            enumerable: false,
            configurable: false,
            get: () => event.game === game,
            set: value => {
                event.game = value ? game : other;
            },
        });
    }
    return record;
}
//# sourceMappingURL=event-flags-guest.js.map
// Guard 自有导出登记。
import { registerModule as __guardRegisterExports } from "../protect/objects.js"
__guardRegisterExports("native-sandbox/event-flags-guest.ts", { restoreNativeEventFlags })
