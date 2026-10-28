import type { SandboxEvent } from "./types.js";
/** 在插件上下文构建对象，不向插件提供真实 Bot、事件、插件或文件系统对象。 */
export declare function guestBootstrap(event: SandboxEvent, pluginIds?: string[]): string;
