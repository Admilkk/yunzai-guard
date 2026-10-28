import { acquirePm2AttachLock } from "./attach-lock.js"
import fs from "node:fs"
import { randomBytes } from "node:crypto"
import { fileURLToPath } from "node:url"
import {
  pm2AgentRegistrationExpression,
  pm2InspectorPreparationExpression,
} from "./agent-protocol.js"
import {
  ParentInspector,
  assertParentProof,
  assertParentUnchanged,
  inspectorDeadline,
  readParentProof,
  type InspectorDeadline,
} from "./inspector.js"
import { M } from "../shared/messages.js"

export interface Pm2AutoOptions {
  root: string
  launcherPath: string
  shutdownTimeout: number
  startupTimeout: number
  requestRestart: boolean
  bootstrapRedisPid?: number | null
}
export interface Pm2AutoRegistration {
  status: "registered"
  daemonPid: number
  pmId: number
  pid: number
  launcherPath: string
  requiresHandoff: boolean
  nonce?: string
  bootstrapExitBarrier?: 1
}

/** 判断当前进程是否由 PM2 启动。 */
export function hasPm2Environment(env: NodeJS.ProcessEnv = process.env): boolean {
  return (
    env.pm_id !== undefined || (env.PM2_HOME !== undefined && env.NODE_APP_INSTANCE !== undefined)
  )
}
/** 解析 PM2 应用编号。 */
export function pm2ApplicationId(value: string | undefined): number {
  if (value === undefined || !/^(0|[1-9]\d*)$/.test(value) || !Number.isSafeInteger(Number(value)))
    throw new Error(M.pm2.appIdentity)
  return Number(value)
}
/** 校验 daemon 返回的登记结果。 */
export function assertPm2Registration(
  value: unknown,
  expected: {
    pid: number
    pmId: number
    daemonPid: number
    launcherPath: string
    requestRestart: boolean
  },
): asserts value is Pm2AutoRegistration {
  if (!value || typeof value !== "object") throw new Error(M.pm2.registrationReply)
  const reply = value as Pm2AutoRegistration
  const canonical = (file: string) => {
    const resolved = fs.realpathSync.native(file)
    return process.platform === "win32" ? resolved.toLowerCase() : resolved
  }
  if (
    reply.status !== "registered" ||
    reply.pid !== expected.pid ||
    reply.pmId !== expected.pmId ||
    reply.daemonPid !== expected.daemonPid ||
    reply.requiresHandoff !== expected.requestRestart ||
    (expected.requestRestart && reply.bootstrapExitBarrier !== 1) ||
    typeof reply.launcherPath !== "string" ||
    canonical(reply.launcherPath) !== canonical(expected.launcherPath)
  )
    throw new Error(M.pm2.replyMismatch)
}
/** 经 IPC 认证一次性接管票据。 */
async function authenticateTicket(
  options: Pm2AutoOptions,
  pmId: number,
  ticket: string,
): Promise<Pm2AutoRegistration> {
  if (!/^[a-f0-9]{64}$/.test(ticket)) throw new Error(M.pm2.ticket)
  return new Promise((resolve, reject) => {
    const cleanup = () => {
      clearTimeout(timer)
      process.off("message", message)
      process.off("disconnect", disconnected)
    }
    const disconnected = () => {
      cleanup()
      reject(new Error(M.pm2.authDisconnected))
    }
    const message = (raw: unknown) => {
      if (!raw || typeof raw !== "object") return
      const reply = raw as Record<string, unknown>
      if (reply.type !== "yunzai-guard-pm2-registered" || reply.nonce !== ticket) return
      try {
        const result = { ...reply, status: "registered", requiresHandoff: false }
        assertPm2Registration(result, {
          pid: process.pid,
          pmId,
          daemonPid: process.ppid,
          launcherPath: options.launcherPath,
          requestRestart: false,
        })
        cleanup()
        delete process.env.YUNZAI_GUARD_PM2_TICKET
        resolve(result)
      } catch (error) {
        cleanup()
        reject(error)
      }
    }
    const timer = setTimeout(() => {
      cleanup()
      reject(new Error(M.pm2.authTimeout))
    }, 10000)
    process.on("message", message)
    process.once("disconnect", disconnected)
    process.send?.({ type: "yunzai-guard-pm2-check", nonce: ticket }, error => {
      if (error) {
        cleanup()
        reject(new Error(M.pm2.authSend))
      }
    })
  })
}

/** 经 PM2 IPC 请求关闭 Inspector。 */
export async function closePm2InspectorOverIpc(
  expected: {
    nonce: string
    url: string
    pmId: number
    daemonPid: number
  },
  deadline?: InspectorDeadline,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const cleanup = () => {
      clearTimeout(timer)
      process.off("message", message)
      process.off("disconnect", disconnected)
    }
    const disconnected = () => {
      cleanup()
      reject(new Error(M.pm2.cleanupDisconnected))
    }
    const message = (raw: unknown) => {
      if (!raw || typeof raw !== "object") return
      const value = raw as Record<string, unknown>
      if (value.type !== "yunzai-guard-pm2-inspector-closed" || value.nonce !== expected.nonce)
        return
      cleanup()
      if (
        value.pid !== process.pid ||
        value.pmId !== expected.pmId ||
        value.daemonPid !== expected.daemonPid ||
        value.url !== expected.url
      )
        reject(new Error(M.pm2.cleanupAckMismatch))
      else resolve()
    }
    const remainingMs = deadline ? Math.floor(deadline.remainingMs()) : 10000
    if (!Number.isSafeInteger(remainingMs) || remainingMs <= 0) {
      reject(new Error(M.pm2.cleanupDeadline))
      return
    }
    const timer = setTimeout(
      () => {
        cleanup()
        reject(new Error(M.pm2.cleanupAckTimeout))
      },
      Math.min(10000, remainingMs),
    )
    process.on("message", message)
    process.once("disconnect", disconnected)
    if (!process.connected || !process.send) {
      cleanup()
      reject(new Error(M.pm2.cleanupIpc))
      return
    }
    process.send(
      { type: "yunzai-guard-pm2-inspector-close", nonce: expected.nonce, url: expected.url },
      error => {
        if (error) {
          cleanup()
          reject(new Error(M.pm2.cleanupSend))
        }
      },
    )
  })
}

/**
 * 仅通过已验证的当前父进程联系既有守护进程。
 * 宿主独占的共享截止时间覆盖登记及后续交接；
 * 它不序列化到守护进程请求中，也不在登记后重置。
 */
export async function registerCurrentPm2Application(
  options: Pm2AutoOptions,
  sharedDeadline?: InspectorDeadline,
): Promise<Pm2AutoRegistration | null> {
  if (!hasPm2Environment()) return null
  if (
    options.requestRestart &&
    options.bootstrapRedisPid !== null &&
    (!Number.isSafeInteger(options.bootstrapRedisPid) || Number(options.bootstrapRedisPid) <= 1)
  )
    throw new Error(M.pm2.coldStartRedis)
  const pmId = pm2ApplicationId(process.env.pm_id)
  if (!process.connected || !process.send) throw new Error(M.pm2.parentIpc)
  options = {
    ...options,
    root: fs.realpathSync.native(options.root),
    launcherPath: fs.realpathSync.native(options.launcherPath),
  }
  const ticket = process.env.YUNZAI_GUARD_PM2_TICKET
  if (ticket !== undefined) return authenticateTicket(options, pmId, ticket)
  const deadline = sharedDeadline ?? inspectorDeadline(options.startupTimeout)
  const proof = readParentProof()
  assertParentProof(proof, process.env.PM2_HOME)
  const release = await acquirePm2AttachLock(proof)
  try {
    assertParentUnchanged(proof)
    const session = await ParentInspector.connect(proof, { deadline })
    let registration: Pm2AutoRegistration | undefined
    let cleanupRequest: Parameters<typeof closePm2InspectorOverIpc>[0] | undefined
    let registrationFailed = false
    let registrationError: unknown
    try {
      const identity = await session.identity()
      await session.verifyParent()
      const nonce = randomBytes(32).toString("hex")
      const request = {
        ...options,
        pmId,
        pid: process.pid,
        nonce,
        expectedDaemonPid: proof.pid,
        pm2Root: identity.pm2Root,
        ...(session.opened ? { ownInspectorUrl: session.url } : {}),
      }
      const agent = fileURLToPath(new URL("./agent-v2.js", import.meta.url))
      const transport = fileURLToPath(new URL("./inspector-session-v1.js", import.meta.url))
      if (session.opened) cleanupRequest = { nonce, url: session.url, pmId, daemonPid: proof.pid }
      const closeOptions = {
        pmId,
        pid: process.pid,
        nonce,
        expectedDaemonPid: proof.pid,
        pm2Root: identity.pm2Root,
        url: session.url,
      }
      // 加载登记代码前先准备清理；即使代理过期或缺失，
      // 仍可通过应用原始 IPC 关闭本次持有的临时端点。
      if (session.opened)
        await session.evaluate(pm2InspectorPreparationExpression(transport, closeOptions))
      if (session.wildcard) {
        throw new Error(M.pm2.wildcardEndpoint)
      }
      const value = await session.evaluate<unknown>(pm2AgentRegistrationExpression(agent, request))
      assertPm2Registration(value, {
        pid: process.pid,
        pmId,
        daemonPid: proof.pid,
        launcherPath: options.launcherPath,
        requestRestart: options.requestRestart,
      })
      registration = { ...value, nonce }
    } catch (error) {
      registrationFailed = true
      registrationError = error
      throw error
    } finally {
      try {
        await session.close(
          cleanupRequest ? () => closePm2InspectorOverIpc(cleanupRequest!, deadline) : undefined,
        )
      } catch (cleanupError) {
        if (registrationFailed)
          throw new AggregateError([registrationError, cleanupError], M.pm2.registrationCleanup)
        throw cleanupError
      }
    }
    return registration
  } finally {
    await release()
  }
}
