import { afterEach, describe, expect, it, vi } from "vitest"
import type { QueuedMessage } from "../types"
import type { useThreadContext } from "./thread-context"
import type { BotWorkConversationResolution } from "../../../shared/bots/conversation"
import {
  parkLinkedConversationQueue,
  parkOrdinaryConversationQueue
} from "./bot-conversation-transition"
const receipt = vi.fn(),
  reconcile = vi.fn()
afterEach(() => {
  vi.unstubAllGlobals()
  vi.clearAllMocks()
})
function fixture(botTarget = false) {
  let queue: QueuedMessage[] = Array.from({ length: 41 }, (_, i) => ({
    id: `draft-${i}`,
    text: `Original ${i}`,
    created_at: new Date(1),
    updated_at: new Date(1),
    ...(i < 2
      ? {
          handoffRequestedAt: new Date(1),
          ...(botTarget ? { botHandoffTarget: { botId: "owner", workId: "work" } } : {})
        }
      : {})
  }))
  let suppressed = false
  vi.stubGlobal("window", {
    api: {
      agent: { reconcileCurrentRunQueuedMessages: reconcile },
      bots: { requestReceipts: receipt }
    }
  })
  const context = {
    initializeThread: () => {},
    getThreadState: () => ({ queuedMessages: queue }),
    getThreadActions: () => ({
      deleteQueuedMessage: (id: string, done?: (error: string | null) => void) => {
        queue = queue.filter((d) => d.id !== id)
        done?.(null)
      },
      updateQueuedMessage: (
        id: string,
        patch: Partial<QueuedMessage>,
        done?: (error: string | null) => void
      ) => {
        queue = queue.map((d) => (d.id === id ? { ...d, ...patch } : d))
        done?.(null)
      },
      setQueueAutoDrainSuppressed: (value: boolean) => {
        suppressed = value
      }
    })
  } as unknown as ReturnType<typeof useThreadContext>
  return {
    context,
    get queue() {
      return queue
    },
    get suppressed() {
      return suppressed
    }
  }
}
describe("association queue transitions", () => {
  it("does not clear or reinterpret an old Bot handoff when associating a retained ordinary conversation", async () => {
    const f = fixture(true)
    await expect(parkOrdinaryConversationQueue(f.context, "original")).rejects.toThrow("此前 Bot")
    expect(reconcile).not.toHaveBeenCalled()
    expect(f.queue[0].handoffRequestedAt).toEqual(new Date(1))
    expect(f.queue[0].botHandoffTarget).toEqual({ botId: "owner", workId: "work" })
  })

  it("reconciles original desktop handoff and parks the remaining queue without dispatching it", async () => {
    const f = fixture()
    reconcile.mockResolvedValue({ pendingIds: [], injectedIds: [], durableIds: ["draft-0"] })
    await parkOrdinaryConversationQueue(f.context, "original")
    expect(reconcile).toHaveBeenCalledWith("original", ["draft-0", "draft-1"])
    expect(f.queue).toHaveLength(40)
    expect(f.queue.every((d) => d.parkedForConversationLink && !d.handoffRequestedAt)).toBe(true)
    expect(f.suppressed).toBe(true)
    expect(receipt).not.toHaveBeenCalled()
  })
  it("does not convert an existing pending desktop handoff into a new Bot request", async () => {
    const f = fixture()
    reconcile.mockResolvedValue({ pendingIds: ["draft-1"], injectedIds: [], durableIds: [] })
    await expect(parkOrdinaryConversationQueue(f.context, "original")).rejects.toThrow("已交接")
    expect(f.queue).toHaveLength(41)
    expect(f.suppressed).toBe(true)
  })
  it("clears accepted Bot drafts before detach, leaves absent drafts parked and keeps bounded reads", async () => {
    const f = fixture(true)
    receipt.mockImplementation(async (_bot: string, checks: { requestId: string }[]) =>
      checks.map((c) => ({ ...c, state: c.requestId === "draft-0" ? "accepted" : "absent" }))
    )
    const link = {
      bot: { id: "owner" },
      work: { id: "work", threadId: "original" }
    } as BotWorkConversationResolution
    await parkLinkedConversationQueue(f.context, link)
    expect(receipt).toHaveBeenCalledTimes(1)
    expect(receipt.mock.calls[0][1]).toHaveLength(2)
    expect(receipt.mock.calls[0][2]).toBe("work")
    expect(f.queue).toHaveLength(40)
    expect(
      f.queue.every(
        (d) => d.parkedForConversationLink && !d.handoffRequestedAt && !d.botHandoffTarget
      )
    ).toBe(true)
    expect(f.suppressed).toBe(true)
  })
  it("keeps unresolved Bot receipts and their source rather than reverting them to ordinary pending", async () => {
    const f = fixture(true),
      link = {
        bot: { id: "owner" },
        work: { id: "work", threadId: "original" }
      } as BotWorkConversationResolution
    receipt.mockResolvedValue([])
    await expect(parkLinkedConversationQueue(f.context, link)).rejects.toThrow("尚未核对")
    expect(f.queue[0].botHandoffTarget).toEqual({ botId: "owner", workId: "work" })
    expect(f.queue[0].handoffRequestedAt).toEqual(new Date(1))
  })
})
