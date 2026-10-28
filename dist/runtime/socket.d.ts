import type { EmitEvent } from "../shared/types.js";
import type { RuntimeIdentity } from "./worker-monitor.js";
import type { RuntimeManifest } from "./protocol.js";
import { type Lifecycle } from "./reporter.js";
/** 通过本地套接字把 Node 子进程运行时接入宿主代理。 */
export declare function connectSocket(manifest: RuntimeManifest, identity: RuntimeIdentity, lifecycle: Lifecycle): {
    emit: EmitEvent;
    ready: Promise<void>;
};
