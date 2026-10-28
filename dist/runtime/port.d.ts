import type { MessagePort } from "node:worker_threads";
import type { EmitEvent, GuardSettings } from "../shared/types.js";
import type { RuntimeIdentity } from "./worker-monitor.js";
import { type Lifecycle } from "./reporter.js";
/** 通过 MessagePort 把线程运行时接入父线程审计通道。 */
export declare function connectPort(port: MessagePort, settings: GuardSettings, identity: RuntimeIdentity, channelNonce: string, lifecycle: Lifecycle): EmitEvent;
