export class NativeCoreControlDenied extends Error {
  readonly code = "NATIVE_CORE_DENIED"
}

/** 权限来自当前宿主请求，不能信任插件提供的 isMaster 字段。 */
export function requireNativeRestartCapability(
  args: unknown[],
  requestType: string | undefined,
  event: Record<string, unknown> | undefined,
  alreadyRequested: boolean,
  permitted: boolean,
): void {
  if (
    !permitted ||
    args.length ||
    requestType !== "native-call" ||
    event?.isMaster !== true ||
    alreadyRequested
  )
    throw new NativeCoreControlDenied(
      "Core restart requires an explicit plugin grant and one live host-authenticated master request",
    )
}
