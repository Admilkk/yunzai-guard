import type { NativeIdentity, RefusalCode, NativeFailureResult, QualifiedNodeProfile } from "./protocol.js";
type ObjectValue = Record<string, unknown>;
declare const refusalCodes: Set<RefusalCode>;
/** 抛出原生身份错误。 */
declare function fail(code?: RefusalCode, result?: NativeFailureResult): never;
/** 校验为非 Proxy 的普通对象。 */
declare const object: (value: unknown) => ObjectValue;
/** 校验必需与可选字段。 */
declare const keys: (value: ObjectValue, required: string[], optional?: string[]) => void;
/** 校验正整数并检查上限。 */
declare const integer: (value: unknown, maximum?: number) => number;
/** 校验指定字节长度的十六进制令牌。 */
declare const token: (value: unknown, bytes?: number) => string;
/** 校验十进制数字字符串。 */
declare const decimal: (value: unknown) => string;
/** 以 JSON 文本比较两个值。 */
declare const equal: (a: unknown, b: unknown) => boolean;
/** 返回距截止时间的剩余毫秒数。 */
declare const remaining: (deadline: number) => number;
/** 使用受限的小型解码器，并额外拒绝 JSON.parse 不会拒绝的重复对象键。 */
export declare function parseNativeIdentityJson(text: string): unknown;
/** 解析并校验原生进程身份。 */
export declare function parseNativeIdentity(value: unknown): NativeIdentity;
/** 解析并校验合格的 Node 运行时配置。 */
declare function profile(value: unknown): QualifiedNodeProfile;
export { refusalCodes, fail, object, keys, integer, token, decimal, equal, remaining, profile };
export type { ObjectValue };
