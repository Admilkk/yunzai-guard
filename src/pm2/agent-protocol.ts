import { M } from "../shared/messages.js"
interface Pm2AgentModule {
  pm2AgentCapabilities: Readonly<{
    agentProtocol: 2
    bootstrapExitBarrier: 1
    cachedRegistryUpgrade: 1
  }>
  registerPm2Application: (request: unknown) => unknown
}

interface Pm2InspectorSessionModule {
  pm2InspectorSessionProtocol: 1
  preparePm2InspectorClose: (request: unknown) => unknown
}

/**
 * 调用登记代码前，验证受信模块的静态 ABI。
 * 函数必须自包含，其源码还会在父守护进程的执行环境中运行；
 * 因此文案经参数传入，序列化调用时须显式提供，不能依赖模块导入。
 * 这里只协商缓存实现的兼容性，不验证恶意守护进程的身份。
 */
export function assertPm2AgentModule(
  value: unknown,
  message: string = M.pm2.agentProtocol,
): asserts value is Pm2AgentModule {
  const invalid = (): never => {
    throw new Error(message)
  }
  if (value === null || typeof value !== "object") invalid()
  const capabilities = Object.getOwnPropertyDescriptor(value, "pm2AgentCapabilities")
  const register = Object.getOwnPropertyDescriptor(value, "registerPm2Application")
  const capability = capabilities && "value" in capabilities ? capabilities.value : undefined
  if (
    !register ||
    !("value" in register) ||
    typeof register.value !== "function" ||
    capability === null ||
    typeof capability !== "object" ||
    !Object.isFrozen(capability)
  )
    invalid()
  const prototype = Object.getPrototypeOf(capability)
  if (prototype !== Object.prototype && prototype !== null) invalid()
  const expected = { agentProtocol: 2, bootstrapExitBarrier: 1, cachedRegistryUpgrade: 1 }
  if (Reflect.ownKeys(capability).length !== 3) invalid()
  for (const [key, version] of Object.entries(expected)) {
    const descriptor = Object.getOwnPropertyDescriptor(capability, key)
    if (!descriptor || !("value" in descriptor) || descriptor.value !== version) invalid()
  }
}

/** 清理传输有独立 ABI，不依赖加载登记代理。 */
export function assertPm2InspectorSessionModule(
  value: unknown,
  message: string = M.pm2.cleanupTransport,
): asserts value is Pm2InspectorSessionModule {
  if (value === null || typeof value !== "object") throw new Error(message)
  const protocol = Object.getOwnPropertyDescriptor(value, "pm2InspectorSessionProtocol")
  const prepare = Object.getOwnPropertyDescriptor(value, "preparePm2InspectorClose")
  if (
    !protocol ||
    !("value" in protocol) ||
    protocol.value !== 1 ||
    !prepare ||
    !("value" in prepare) ||
    typeof prepare.value !== "function"
  )
    throw new Error(message)
}

/** 生成在 PM2 daemon 中登记应用的求值表达式，先校验代理模块形状。 */
export function pm2AgentRegistrationExpression(agentPath: string, request: unknown): string {
  return `(async()=>{const r=process.getBuiltinModule('module').createRequire(process.argv[1]);const agent=r(${JSON.stringify(agentPath)});(${assertPm2AgentModule.toString()})(agent,${JSON.stringify(M.pm2.agentProtocol)});return await agent.registerPm2Application(${JSON.stringify(request)})})()`
}

/** 生成在 PM2 daemon 中准备 Inspector 关闭的求值表达式。 */
export function pm2InspectorPreparationExpression(transportPath: string, request: unknown): string {
  return `(()=>{const r=process.getBuiltinModule('module').createRequire(process.argv[1]);const transport=r(${JSON.stringify(transportPath)});(${assertPm2InspectorSessionModule.toString()})(transport,${JSON.stringify(M.pm2.cleanupTransport)});return transport.preparePm2InspectorClose(${JSON.stringify(request)})})()`
}
