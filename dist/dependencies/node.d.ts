export declare const windowsNode: Readonly<{
    version: "24.22.1";
    sha256: "d702daa815eabbff763c7d3808e235cf031cf2ca70211b56847bc72f51e240e5";
    url: "https://nodejs.org/dist/v24.22.1/win-x64/node.exe";
}>;
/** 发布包随附的固定运行时，位于插件根目录 runtime/ 下。 */
export declare const bundledNode: (root: string) => string;
/** 只接受固定摘要，不执行下载内容来判断版本。 */
export declare function nodeReady(file: string): boolean;
/** 下载并按固定摘要核验；也供发布打包脚本写入随附运行时。 */
export declare function downloadNode(target: string): Promise<void>;
/** 仅准备 Guard 自己的宿主运行时，不更换系统 Node、PATH 或 PM2 daemon。 */
export declare function prepareNode(root: string): Promise<string>;
