export interface PluginEntry {
    /** 目录名，同时是原生沙盒的 id。 */
    id: string;
    /** 核心目录或 Guard 自身，不能作为原生沙盒对象。 */
    reserved: boolean;
    description?: string;
}
/** 只读取目录项，不加载插件代码。 */
export declare function listPlugins(root: string): PluginEntry[];
