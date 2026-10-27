import type { MessagePort } from "node:worker_threads"
import { AuditSender } from "../audit/sender.js"
import { createAuditDeadline, parseAuditFrame, type AuditSealFrame } from "../audit/protocol.js"
import type { EmitEvent, GuardSettings } from "../shared/types.js"
import type { RuntimeIdentity, WorkerAuditCloseOptions } from "./worker-monitor.js"
import { addInvalidReplies, createReporter, reportFailure, type Lifecycle } from "./reporter.js"

/** 通过 MessagePort 把线程运行时接入父线程审计通道。 */
export function connectPort(
  port: MessagePort,
  settings: GuardSettings,
  identity: RuntimeIdentity,
  channelNonce: string,
  lifecycle: Lifecycle,
): EmitEvent {
  let degraded = false
  let exiting = false
  let prepared: WorkerAuditCloseOptions | undefined
  let seal: AuditSealFrame | undefined
  let invalidReplies = 0
  const criticalSequences = new Set<number>()
  const sender = new AuditSender({
    generation: identity.generation,
    maxQueue: settings.audit.maxQueue,
    channelNonce,
    completion: "hop",
    isConnected: () => !degraded,
    /** 发送审计帧；重启类事件额外登记为关键序号。 */
    write(frame, callback) {
      if (frame.event.action === "restart") {
        criticalSequences.add(frame.auditSeq)
        // 保留关键记录原有的投递存活期，普通审计不额外维持进程。
        port.ref()
      }
      try {
        port.postMessage(frame)
        callback()
      } catch (error) {
        criticalSequences.delete(frame.auditSeq)
        if (!criticalSequences.size) port.unref()
        fail("worker-audit-delivery-failed")
        throw error
      }
    },
  })
  const fail = (reason: string) => {
    if (degraded) return
    degraded = true
    sender.dispose()
    criticalSequences.clear()
    port.unref()
    if (!exiting) reportFailure(settings, identity, reason)
  }
  const nestedCoverage = createReporter(sender, identity, lifecycle.coverage)
  port.on("message", (message: unknown) => {
    const frame = parseAuditFrame(message)
    if (!frame || frame.generation !== identity.generation || frame.channelNonce !== channelNonce) {
      invalidReplies++
      return
    }
    if (frame.type === "audit-hop-ack") {
      if (sender.ack(frame)) criticalSequences.delete(frame.auditSeq)
      else invalidReplies++
      if (!criticalSequences.size) port.unref()
    } else if (frame.type === "audit-prepare-flush") {
      if (prepared && prepared.nonce !== frame.closeNonce) invalidReplies++
      else if (!prepared) {
        prepared = {
          nonce: frame.closeNonce,
          deadline: createAuditDeadline(frame.remainingBudgetMs),
        }
        lifecycle.prepare(prepared)
      }
    } else if (
      frame.type !== "audit-flush-result" ||
      !seal ||
      !prepared ||
      frame.closeNonce !== prepared.nonce ||
      frame.cutoff !== seal.lastSentSeq ||
      frame.evidence !== "parent-hop-only"
    )
      invalidReplies++
  })
  port.on("close", () => fail("worker-audit-port-closed"))
  process.once("exit", () => {
    exiting = true
    if (prepared && !seal) {
      try {
        seal = sender.sealNow({
          nonce: prepared.nonce,
          nestedCoverage: nestedCoverage(),
        })
        seal = addInvalidReplies(seal, invalidReplies)
        port.postMessage(seal)
      } catch {
        // 同步退出不能等待投递；父进程会记录缺失的封账。
      }
    }
    sender.dispose()
  })
  port.unref()
  return event => {
    sender.offer(
      event as unknown as Record<string, unknown>,
      event.action === "deny" || event.action === "restart",
    )
  }
}
