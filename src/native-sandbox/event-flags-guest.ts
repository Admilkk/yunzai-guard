type EventRecord = Record<string, unknown>

/** 仅在最终插件事件对象上重建 DTO 标记的核心游戏标志。 */
export function restoreNativeEventFlags<T extends EventRecord>(record: T): T {
  for (const [flag, game, other] of [
    ["isSr", "sr", "gs"],
    ["isGs", "gs", "sr"],
  ] as const) {
    const descriptor = Object.getOwnPropertyDescriptor(record, flag)
    if (
      !descriptor ||
      !("value" in descriptor) ||
      typeof descriptor.value !== "boolean" ||
      !descriptor.configurable
    )
      continue
    // 核心访问器通过闭包引用自身事件，不使用调用方的 this。
    const event: EventRecord = record
    Object.defineProperty(record, flag, {
      enumerable: false,
      configurable: false,
      get: () => event.game === game,
      set: value => {
        event.game = value ? game : other
      },
    })
  }
  return record
}
