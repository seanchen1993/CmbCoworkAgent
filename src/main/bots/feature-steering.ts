import { steerAgentRun } from "../agent/agent-run-service"
import { getLocalThreadRunLease } from "../agent/thread-run-lease"
import { getPendingUserInputForThread, submitUserInputResponse } from "../services/user-input"
import type { LocalBotHost } from "./host"
import type { FeatureOwner } from "./feature-store"

/** Uses the same physical-run queue as ordinary chat. No restart or new project session. */
export async function steerFeatureTurn(input: {
  host: LocalBotHost
  owner: FeatureOwner
  threadId: string
  operationId: string
  message: string
  verify(): void
}): Promise<boolean> {
  const { host, owner, threadId, operationId, message, verify } = input
  const existing = host.featureTurns.operation(threadId)
  const source = existing ? host.featureStore.receipt(existing) : undefined
  if (source && (source.followId !== owner.id || source.state !== "active"))
    throw new Error("该项目会话正由另一项交办执行，请打开原任务补充。")
  const lease = getLocalThreadRunLease(threadId)
  if (!lease) {
    if (existing) throw new Error("项目会话正在切换运行，请稍后重试补充。")
    return false
  }
  verify()
  const bindingId = owner.audience.startsWith("im:") ? owner.audience.slice(3) : undefined
  const binding = bindingId ? host.imGateway.binding(bindingId) : undefined
  if (bindingId && (binding?.binding.state !== "active" || binding.binding.botId !== owner.botId))
    throw new Error("原招乎绑定已解除")
  const current = () => {
    try {
      const bot = host.getBot(owner.botId)
      if (bot.archived || bot.deleting) return false
      host.featureStore.owner(owner.id, owner)
      if (bindingId && binding) {
        const latest = host.imGateway.binding(bindingId)
        if (
          latest?.binding.state !== "active" ||
          latest.binding.botId !== owner.botId ||
          latest.binding.version !== binding.binding.version ||
          latest.realm !== binding.realm ||
          latest.principal !== binding.principal
        )
          return false
      }
      verify()
      const latest = getLocalThreadRunLease(threadId)
      return (
        host.featureTurns.operation(threadId) === existing &&
        latest?.owner === lease.owner &&
        latest.runId === lease.runId &&
        (!existing || host.featureStore.receipt(existing).state === "active")
      )
    } catch {
      // A removed Feature/revoked group is a withdrawn input, not a transient
      // transcript error to restore into the next model boundary indefinitely.
      return false
    }
  }
  let consumed = false
  host.featureStore.active(operationId, threadId)
  const result = await steerAgentRun({
    threadId,
    owner: lease.owner,
    runId: lease.runId,
    message: {
      id: `feature-input-${operationId}`,
      content: message,
      beforeInject: current,
      onInjected: () => {
        consumed = true
        host.featureStore.finish(operationId)
        host.featureChanged(owner)
      },
      onDiscarded: () => {
        host.featureStore.finish(
          operationId,
          "执行已结束或停止，补充未被接收。请查看原会话后重试。"
        )
        host.featureChanged(owner)
      }
    }
  })
  if (!result.queued) throw new Error("补充尚未接收，原执行保持不变，请稍后重试。")
  if (!consumed && current()) {
    const question = getPendingUserInputForThread(threadId)
    if (question)
      submitUserInputResponse(
        { requestId: question.requestId, answers: {}, ignored: true },
        { notifyRenderer: true, reason: "用户已发送新的消息，已跳过此前的问题。" }
      )
  }
  return true
}
