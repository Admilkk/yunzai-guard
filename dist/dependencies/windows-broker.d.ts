/** 分发的 broker 与源码摘要必须同时匹配，不在用户机器调用编译器。 */
export declare function windowsBroker(repository: string, sourceDigest: string): {
    executable: string;
    sha256: string;
};
