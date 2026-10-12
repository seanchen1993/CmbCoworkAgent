import { HumanMessage } from "@langchain/core/messages"
import { setTimeout as delay } from "node:timers/promises"
import type { CurrentRunDurableQueue } from "../agent/current-run-message-queue"
import { BotDomainError } from "../../shared/bot-types"
import type { BotRuntimeRequest } from "./host"

export interface BotBackgroundResults {
  assertHealthy(): void
  activeCount(): number
  results(): { id: string; content: string }[]
}

/** One wait across all executors: a finished command must wake a model even if
 * an independent workflow is still running. Stable IDs are graph-acknowledged. */
export function botBackgroundResultsQueue(
  request: BotRuntimeRequest,
  human: CurrentRunDurableQueue,
  sources: BotBackgroundResults[]
): CurrentRunDurableQueue {
  return {
    take: async (input) => {
      const { store, run, lease, signal } = request
      const check = () => {
        signal.throwIfAborted()
        store.assertDispatch(lease, true)
        for (const source of sources) source.assertHealthy()
      }
      check()
      if (input.threadId !== run.id || input.ownerRunToken !== `${lease.owner}:${lease.fence}`)
        throw new BotDomainError("workflow_scope", "后台任务结果不属于当前执行进程")
      const applied = new Set(input.appliedIds)
      const pending = () =>
        sources.flatMap((source) => source.results()).filter((item) => !applied.has(item.id))
      let waitingCount = -1
      while (
        input.phase === "afterModel" &&
        sources.some((source) => source.activeCount() > 0) &&
        !pending().length &&
        !store.steering.hasPending(run.id)
      ) {
        check()
        const count = sources.reduce((total, source) => total + source.activeCount(), 0)
        if (waitingCount !== count && store.getRun(run.id).status === "running") {
          waitingCount = count
          store.activity(lease, `等待 ${count} 项后台任务完成`, "collaboration")
        }
        await delay(100, undefined, { signal })
      }
      check()
      const messages = await human.take(input)
      let size = messages.reduce((total, message) => total + String(message.content).length, 0)
      for (const result of pending()) {
        if (size + result.content.length > 96_000 && messages.length) break
        messages.push(new HumanMessage(result))
        size += result.content.length
      }
      return messages
    }
  }
}
