import { createHash } from "node:crypto"
import { HumanMessage } from "@langchain/core/messages"
import type { BaseCheckpointSaver } from "@langchain/langgraph-checkpoint"

export interface CoordinatorNotificationDelivery {
  messageId: string
  content: string
  onCommitted: () => Promise<void>
  onPendingWrite?: (write: Promise<unknown>) => void
}

/** Consume only after the checkpoint containing this exact input is durable.
 * LangGraph may run the model before its asynchronous checkpoint puts finish.
 */
export function withCoordinatorNotificationDelivery<T extends BaseCheckpointSaver>(
  checkpointer: T,
  delivery: CoordinatorNotificationDelivery,
  flush: () => Promise<void>
): T {
  let committed: Promise<void> | undefined
  const put: T["put"] = (...args: Parameters<T["put"]>) => {
    const operation = (async () => {
      const result = await checkpointer.put(args[0], args[1], args[2], args[3])
      const [config, checkpoint] = args
      if (
        (config.configurable?.checkpoint_ns ?? "") === "" &&
        Array.isArray(checkpoint.channel_values.messages) &&
        checkpoint.channel_values.messages.some(
          (message) =>
            HumanMessage.isInstance(message) &&
            message.id === delivery.messageId &&
            message.content === delivery.content
        )
      ) {
        committed ??= (async () => {
          await flush()
          await delivery.onCommitted()
        })()
        await committed
      }
      return result
    })()
    delivery.onPendingWrite?.(operation)
    return operation
  }
  return new Proxy(checkpointer, {
    get(target, property) {
      if (property === "put") return put
      const value = Reflect.get(target, property, target)
      return typeof value === "function" ? value.bind(target) : value
    }
  })
}

/** Abort can reject the stream while checkpoint puts are still running. */
export function createCoordinatorNotificationWriteTracker() {
  const pending = new Set<Promise<unknown>>()
  return {
    track(write: Promise<unknown>): void {
      pending.add(write)
      void write.then(
        () => pending.delete(write),
        () => pending.delete(write)
      )
    },
    async settle(): Promise<void> {
      while (pending.size > 0) await Promise.allSettled([...pending])
    }
  }
}

export const COORDINATOR_NOTIFICATION_RECEIPTS_KEY = "cmb_coordinator_notification_receipts"

export function coordinatorNotificationReceipt(message: string): string {
  return createHash("sha256").update(message).digest("hex")
}

export function findCommittedCoordinatorNotifications(
  messages: unknown,
  notifications: readonly string[]
): string[] {
  if (!Array.isArray(messages)) return []
  const receipts = new Set<string>()
  for (const message of messages) {
    if (
      !HumanMessage.isInstance(message) ||
      message.additional_kwargs?.cmb_internal_coordinator_notification !== true
    )
      continue
    const saved = message.additional_kwargs[COORDINATOR_NOTIFICATION_RECEIPTS_KEY]
    if (Array.isArray(saved))
      for (const receipt of saved) if (typeof receipt === "string") receipts.add(receipt)
  }
  return notifications.filter((message) => receipts.has(coordinatorNotificationReceipt(message)))
}

/** Recover a crash between graph input persistence and the queue's acknowledgement. */
export async function readCommittedCoordinatorNotifications(
  threadId: string,
  notifications: readonly string[]
): Promise<string[]> {
  const { withCheckpointer } = await import("./runtime")
  return withCheckpointer(threadId, async (checkpointer) => {
    const tuple = await checkpointer.getTuple({
      configurable: { thread_id: threadId, checkpoint_ns: "" }
    })
    const committed = findCommittedCoordinatorNotifications(
      tuple?.checkpoint.channel_values.messages,
      notifications
    )
    if (committed.length > 0) await checkpointer.flushStrict()
    return committed
  })
}
