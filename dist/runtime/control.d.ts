export type ControlType = "restart-request" | "stop-request" | "update-request" | "update-force-request" | "rollback-request" | "preload-ready" | "worker-online";
export interface ControlFrame {
    type: ControlType;
    generation: number;
    pid: number;
    sequence: number;
    signature: string;
}
/** 判断是否为需要签名的控制消息类型。 */
export declare function isControlType(value: unknown): value is ControlType;
/** 每代实例使用独立密钥；不与会出现在审计帧中的 nonce 共用。 */
export declare function createControlSigner(key: string, generation: number, pid: number): (type: ControlType) => ControlFrame;
/** 宿主只接受本代、正确身份且未消费过的控制帧。 */
export declare function createControlVerifier(key: string, generation: number, pid: number): (frame: unknown) => boolean;
