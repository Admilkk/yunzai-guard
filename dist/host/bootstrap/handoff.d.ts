import { type BootstrapProcessIdentity } from "./exit-watch.js";
interface BootstrapHandoffOptions {
    bootstrapPid: number;
    redisPid: number | null;
    timeout: number;
    signal: AbortSignal;
    bound?: (identities: readonly BootstrapProcessIdentity[]) => void;
}
/** 必须收到父进程私有 IPC 提交，并确认两个原始进程均已退出。 */
export declare function waitForBootstrapHandoff(options: BootstrapHandoffOptions): Promise<readonly BootstrapProcessIdentity[]>;
export {};
