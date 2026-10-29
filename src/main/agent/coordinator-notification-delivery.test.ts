import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { HumanMessage } from "@langchain/core/messages"
import { FakeListChatModel } from "@langchain/core/utils/testing"
import { MemorySaver } from "@langchain/langgraph"
import { createAgent, createMiddleware } from "langchain"
import { describe, expect, it, vi } from "vitest"
import { SqlJsSaver } from "../checkpointer/sqljs-saver"
import {
  COORDINATOR_NOTIFICATION_RECEIPTS_KEY,
  coordinatorNotificationReceipt,
  createCoordinatorNotificationWriteTracker,
  withCoordinatorNotificationDelivery,
  findCommittedCoordinatorNotifications
} from "./coordinator-notification-delivery"

function notice(id: string, raw: string) {
  return new HumanMessage({
    id,
    content: raw,
    additional_kwargs: {
      cmb_internal_coordinator_notification: true,
      [COORDINATOR_NOTIFICATION_RECEIPTS_KEY]: [coordinatorNotificationReceipt(raw)]
    }
  })
}
const failModel = createMiddleware({
  name: "providerFailure",
  wrapModelCall: async () => {
    throw new Error("485")
  }
})

describe("coordinator notification delivery boundary", () => {
  it.each([false, true])(
    "waits for actual checkpoint writes before settlement, including cancellation=%s",
    async (cancelled) => {
      const directory = mkdtempSync(join(tmpdir(), "cmb-delivery-race-"))
      let release!: () => void
      let reached!: () => void
      const gate = new Promise<void>((resolve) => {
        release = resolve
      })
      const pending = new Promise<void>((resolve) => {
        reached = resolve
      })
      class DelayedSaver extends SqlJsSaver {
        override async put(...args: Parameters<SqlJsSaver["put"]>) {
          if (
            Array.isArray(args[1].channel_values.messages) &&
            args[1].channel_values.messages.length > 0
          ) {
            reached()
            await gate
          }
          return super.put(...args)
        }
      }
      const saver = new DelayedSaver(join(directory, "thread.sqlite"))
      const controller = new AbortController()
      const tracker = createCoordinatorNotificationWriteTracker()
      const config = { configurable: { thread_id: "delayed-put" }, signal: controller.signal }
      const committed = vi.fn(async () => {
        expect(
          findCommittedCoordinatorNotifications(
            (await saver.getTuple(config))?.checkpoint.channel_values.messages,
            ["A"]
          )
        ).toEqual(["A"])
      })
      const graph = createAgent({
        model: new FakeListChatModel({ responses: ["ok"] }),
        checkpointer: withCoordinatorNotificationDelivery(
          saver,
          {
            messageId: "notice-A",
            content: "A",
            onCommitted: committed,
            onPendingWrite: tracker.track
          },
          () => saver.flushStrict()
        )
      })
      const completion = graph.invoke({ messages: [notice("notice-A", "A")] }, config)
      const observed = completion.catch((error) => error)
      try {
        await pending
        expect(committed).not.toHaveBeenCalled()
        if (cancelled) controller.abort(new Error("cancelled"))
        let settled = false
        const settlement = tracker.settle().then(() => {
          settled = true
        })
        await Promise.resolve()
        expect(settled).toBe(false)
        release()
        await settlement
        await observed
        expect(committed).toHaveBeenCalledTimes(1)
      } finally {
        release()
        await completion.catch(() => {})
        await saver.close()
        rmSync(directory, { recursive: true, force: true })
      }
    }
  )

  it("consumes failed A once, delivers only B later, and preserves A for user continuation", async () => {
    const saver = new MemorySaver()
    const config = { configurable: { thread_id: "batches" } }
    const queued = new Set(["A"])
    const failed = createAgent({
      model: new FakeListChatModel({ responses: ["unused"] }),
      checkpointer: withCoordinatorNotificationDelivery(
        saver,
        {
          messageId: "notice-A",
          content: "A",
          onCommitted: async () => {
            queued.delete("A")
          }
        },
        async () => {}
      ),
      middleware: [failModel]
    })
    await expect(failed.invoke({ messages: [notice("notice-A", "A")] }, config)).rejects.toThrow(
      "485"
    )
    expect(queued.size).toBe(0)
    queued.add("B")
    const next = createAgent({
      model: new FakeListChatModel({ responses: ["processed"] }),
      checkpointer: withCoordinatorNotificationDelivery(
        saver,
        {
          messageId: "notice-B",
          content: "B",
          onCommitted: async () => {
            queued.delete("B")
          }
        },
        async () => {}
      )
    })
    await next.invoke({ messages: [notice("notice-B", "B")] }, config)
    await next.invoke({ messages: [new HumanMessage("continue")] }, config)
    const messages = (await saver.getTuple(config))?.checkpoint.channel_values
      .messages as HumanMessage[]
    expect(messages.filter(HumanMessage.isInstance).map((m) => m.content)).toEqual([
      "A",
      "B",
      "continue"
    ])
    expect(queued.size).toBe(0)
  })

  it("recovers durable receipts after acknowledgement failure and a SQLite reopen", async () => {
    const directory = mkdtempSync(join(tmpdir(), "cmb-delivery-reopen-"))
    const path = join(directory, "thread.sqlite")
    const saver = new SqlJsSaver(path)
    const config = { configurable: { thread_id: "reopen" } }
    try {
      const graph = createAgent({
        model: new FakeListChatModel({ responses: ["unused"] }),
        checkpointer: withCoordinatorNotificationDelivery(
          saver,
          {
            messageId: "notice-A",
            content: "A",
            onCommitted: async () => {
              throw new Error("ack failed")
            }
          },
          () => saver.flushStrict()
        )
      })
      await expect(graph.invoke({ messages: [notice("notice-A", "A")] }, config)).rejects.toThrow(
        "ack failed"
      )
      await saver.close()
      const reopened = new SqlJsSaver(path)
      try {
        expect(
          findCommittedCoordinatorNotifications(
            (await reopened.getTuple(config))?.checkpoint.channel_values.messages,
            ["A", "B"]
          )
        ).toEqual(["A"])
      } finally {
        await reopened.close()
      }
    } finally {
      await saver.close()
      rmSync(directory, { recursive: true, force: true })
    }
  })

  it("does not acknowledge failed persistence or a different input", async () => {
    class FailedSaver extends MemorySaver {
      override async put(...args: Parameters<MemorySaver["put"]>) {
        if (
          Array.isArray(args[1].channel_values.messages) &&
          args[1].channel_values.messages.length > 0
        )
          throw new Error("put failed")
        return super.put(...args)
      }
    }
    const committed = vi.fn(async () => {})
    const saver = new FailedSaver()
    const graph = createAgent({
      model: new FakeListChatModel({ responses: ["unused"] }),
      checkpointer: withCoordinatorNotificationDelivery(
        saver,
        { messageId: "notice-A", content: "A", onCommitted: committed },
        async () => {}
      )
    })
    await expect(
      graph.invoke(
        { messages: [notice("notice-A", "A")] },
        { configurable: { thread_id: "failed-put" } }
      )
    ).rejects.toThrow("put failed")
    expect(committed).not.toHaveBeenCalled()
    const ordinary = createAgent({
      model: new FakeListChatModel({ responses: ["ok"] }),
      checkpointer: withCoordinatorNotificationDelivery(
        new MemorySaver(),
        { messageId: "notice-A", content: "A", onCommitted: committed },
        async () => {}
      )
    })
    await ordinary.invoke(
      { messages: [new HumanMessage("ordinary")] },
      { configurable: { thread_id: "ordinary" } }
    )
    expect(committed).not.toHaveBeenCalled()
    expect(
      findCommittedCoordinatorNotifications(
        [
          new HumanMessage({
            content: "A",
            additional_kwargs: {
              [COORDINATOR_NOTIFICATION_RECEIPTS_KEY]: [coordinatorNotificationReceipt("A")]
            }
          })
        ],
        ["A"]
      )
    ).toEqual([])
  })
})
