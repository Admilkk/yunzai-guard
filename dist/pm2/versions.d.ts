/**
 * 接受 >= 5.0.0 的任意 SemVer，包括更高版本的预发布号（如 7.1.0-rc.1）；
 * 5.0.0 自身的预发布号早于正式版，仍拒绝。版本号只是门槛，
 * 守护进程结构与身份仍须另行检查。
 */
export declare function isSupportedPm2Version(value: unknown): boolean;
