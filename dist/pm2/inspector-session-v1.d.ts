import { ChildProcess } from "node:child_process";
import type { Pm2DaemonGod, Pm2DaemonContext, Pm2InspectorCloseOptions } from "./types.js";
export declare const pm2InspectorSessionProtocol = 1;
interface InspectorCloseRequest {
    child: ChildProcess;
    nonce: string;
    url: string;
    closed: boolean;
    dispose(): void;
}
interface InspectorCloseRegistry {
    protocol: 1;
    requests: Map<ChildProcess, InspectorCloseRequest>;
}
/** 校验 Inspector 端点地址。 */
export declare function validateInspectorUrl(value: unknown, closeOnly?: boolean): asserts value is string;
/** 读取 daemon 上的 Inspector 关闭登记表。 */
export declare function closeRegistryFor(god: Pm2DaemonGod): InspectorCloseRegistry | undefined;
/** 独立准备清理，使后续登记失败时仍能关闭本次端点。 */
export declare function preparePm2InspectorCloseWithGod(god: Pm2DaemonGod, options: Pm2InspectorCloseOptions, context: Pm2DaemonContext): {
    status: "prepared";
    daemonPid: number;
    pmId: number;
    pid: number;
    nonce: string;
    url: string;
};
/** 在当前 daemon 中准备关闭 Inspector。 */
export declare function preparePm2InspectorClose(options: Pm2InspectorCloseOptions): {
    status: "prepared";
    daemonPid: number;
    pmId: number;
    pid: number;
    nonce: string;
    url: string;
};
export {};
