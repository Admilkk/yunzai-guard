/** 仅暴露当前用户的非敏感身份，不提供宿主家目录或账号列表。 */
export declare function linuxSandboxIdentity(user: {
    username: string;
    uid: number;
    gid: number;
}): {
    passwd: string;
    group: string;
};
