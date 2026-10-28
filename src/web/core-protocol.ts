/**
 * 宿主与控制台之间的接口版本。
 * 控制台在宿主进程内加载，宿主通过 StartPanelOptions 与控制器接口提供能力；这些接口只有类型，
 * 编译后没有运行时内容，组件清单无法据此察觉改动。修改 StartPanelOptions、PanelControllers、
 * UpdateController 或 web/index.ts 导出的函数签名时必须递增此值：本文件同属宿主与控制台，
 * 改动它会让更新按宿主级处理，避免新控制台搭配缺少新能力的旧宿主。
 */
export const coreProtocolVersion = 2
