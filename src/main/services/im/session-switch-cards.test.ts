import { afterEach, describe, expect, it, vi } from "vitest"
import initSqlJs from "sql.js"
import { ImConversationStateStore } from "./conversation-state"
import { ImEventStore } from "./event-store"
import { ImReplyClient } from "./reply-client"
import { buildImProactiveReplies } from "./reply-segmentation"
import { ImSessionLinkStore } from "./session-link-store"
import { ImSessionSwitchCards } from "./session-switch-cards"
import { ensureImServiceSchema } from "./schema"
import { ImCardReceiptRouter } from "./card-receipt-router"
import {
  assertRemoteImCardSendV1,
  type RemoteImCardReceiptV1
} from "../../../shared/im-gateway-contract"
import type { ImGatewayClientPort } from "./gateway-client"
import { trackEvent } from "../event-reporter"

vi.mock("../event-reporter", () => ({ trackEvent: vi.fn() }))

const cleanups: Array<() => Promise<void>> = []
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup()
  vi.clearAllMocks()
})

async function fixture() {
  const SQL = await initSqlJs()
  const db = new SQL.Database()
  ensureImServiceSchema(db)
  let now = 100_000
  const persistence = {
    getDatabase: () => db,
    markDirty: vi.fn(),
    flushStrict: vi.fn(async () => undefined),
    now: () => now
  }
  const conversations = new ImConversationStateStore(persistence)
  await conversations.ensureConversation({ principalId: "user", conversationKey: "chat" })
  await conversations.registerTarget(
    "chat",
    {
      kind: "inbox",
      targetId: "current",
      threadId: "current-thread",
      workspacePath: "/inbox"
    },
    { activate: true }
  )
  const events = new ImEventStore(persistence)
  const order: string[] = []
  const gateway = {
    isAuthenticated: () => true,
    sendAcknowledgement: vi.fn(async () => undefined),
    acquireExecutionPermit: vi.fn(),
    renewExecutionPermit: vi.fn(),
    submitReply: vi.fn<ImGatewayClientPort["submitReply"]>(async () => {
      order.push("reply")
      return { state: "accepted" as const }
    }),
    sendCard: vi.fn(async (payload) => {
      assertRemoteImCardSendV1(payload)
      order.push("card")
      return { state: "accepted" as const }
    }),
    updateCard: vi.fn(async () => ({ state: "accepted" as const })),
    acknowledgeCardReceipt: vi.fn(async () => undefined)
  } satisfies ImGatewayClientPort
  const switchSession = vi.fn(async () => "已切换到【同名会话】。")
  const warnings = vi.fn()
  const instances: ImSessionSwitchCards[] = []
  const makeCards = () => {
    const instance = new ImSessionSwitchCards({
      links: events.sessionLinks,
      conversations,
      gateway,
      switchSession,
      now: persistence.now,
      warn: warnings
    })
    instances.push(instance)
    return instance
  }
  const cards = makeCards()
  const client = new ImReplyClient(
    gateway,
    events,
    persistence.now,
    () => false,
    () => cards.schedule()
  )
  const prepare = (deliveryId = "reply-1", threadId = "source-thread") =>
    events.sessionLinks.prepare({
      principalId: "user",
      conversationKey: "chat",
      threadId,
      kind: "thread",
      label: "同名会话",
      deliveryId
    })
  const enqueue = async (deliveryId = "reply-1", text = "真实回复正文") => {
    await events.enqueueProactiveReplies(
      buildImProactiveReplies({
        deliveryId,
        conversationKey: "chat",
        text,
        segmentation: { maxCharacters: 160 }
      })
    )
  }
  const receipt = (
    deliveryId = "reply-1",
    overrides: Partial<RemoteImCardReceiptV1> = {}
  ): RemoteImCardReceiptV1 => {
    const card = events.sessionLinks.getCard(deliveryId)!
    return {
      schemaVersion: 1,
      receiptId: "click-1",
      interactionId: card.interaction_id,
      principalId: "user",
      conversationKey: "chat",
      tag: card.tag,
      kind: "target_bind",
      feedback: [],
      occurredAt: new Date(now).toISOString(),
      ...overrides
    }
  }
  cleanups.push(async () => {
    await Promise.all(instances.map((instance) => instance.stop()))
    db.close()
  })
  return {
    SQL,
    db,
    persistence,
    conversations,
    events,
    gateway,
    order,
    cards,
    makeCards,
    client,
    prepare,
    enqueue,
    receipt,
    switchSession,
    warnings,
    advance: () => {
      now += 100_000
    }
  }
}

describe("persistent session codes", () => {
  it("resolves collisions without changing IDs or reusing another conversation's code", async () => {
    const context = await fixture()
    const candidates = ["ABCDEFGH", "ABCDEFGH", "BCDEFGHJ"]
    const store = new ImSessionLinkStore(context.persistence, () => candidates.shift()!)
    const input = {
      principalId: "user",
      conversationKey: "chat",
      threadId: "a",
      kind: "thread" as const,
      label: "同名",
      deliveryId: "one"
    }
    expect(store.prepare(input)).toBe("ABCDEFGH")
    expect(store.prepare({ ...input, threadId: "b", deliveryId: "two" })).toBe("BCDEFGHJ")
    expect(store.prepare({ ...input, label: "改名后", deliveryId: "three" })).toBe("ABCDEFGH")
    expect(store.get("ABCDEFGH")?.target_label).toBe("改名后")
    const reopened = new context.SQL.Database(context.db.export())
    try {
      const persisted = new ImSessionLinkStore({
        ...context.persistence,
        getDatabase: () => reopened
      })
      expect(persisted.get("BCDEFGHJ")?.thread_id).toBe("b")
      expect(persisted.getCard("one")?.tag).toBe(store.getCard("one")?.tag)
      expect(persisted.prepare({ ...input, label: "重启后", deliveryId: "four" })).toBe("ABCDEFGH")
    } finally {
      reopened.close()
    }
    expect(() => store.prepare({ ...input, threadId: "b", deliveryId: "one" })).toThrow(
      "identity conflict"
    )
  })
})

describe("App-owned switch cards on the unchanged gateway contract", () => {
  it("sends exactly one target_bind card after every reply segment, including after restart", async () => {
    const context = await fixture()
    const code = context.prepare()
    await context.enqueue("reply-1", "正文".repeat(200))
    await context.cards.flush()
    expect(context.gateway.sendCard).not.toHaveBeenCalled()
    await context.client.sendPending()
    await context.cards.flush()
    expect(context.gateway.submitReply.mock.calls.length).toBeGreaterThan(1)
    expect(context.order.at(-1)).toBe("card")
    expect(context.order.filter((value) => value === "card")).toHaveLength(1)
    expect(context.gateway.sendCard.mock.calls[0][0]).toMatchObject({
      kind: "target_bind",
      conversationKey: "chat"
    })
    expect(JSON.stringify(context.gateway.sendCard.mock.calls[0][0].content)).toContain(
      `/切换 @${code}`
    )
    expect(context.switchSession).not.toHaveBeenCalled()
    await context.cards.stop()
    await context.makeCards().flush()
    expect(context.gateway.sendCard).toHaveBeenCalledTimes(1)
  })

  it("does not let a card overtake an unconfirmed final segment", async () => {
    const context = await fixture()
    context.prepare()
    await context.enqueue("reply-1", "正文".repeat(200))
    context.gateway.submitReply
      .mockImplementationOnce(async () => ({ state: "accepted" }))
      .mockImplementationOnce(async () => {
        throw new Error("temporary offline")
      })
    await context.client.sendPending()
    await context.cards.flush()
    expect(context.gateway.sendCard).not.toHaveBeenCalled()
    context.advance()
    await context.client.sendPending()
    await context.cards.flush()
    expect(context.gateway.sendCard).toHaveBeenCalledTimes(1)
  })

  it("uses a stable send key when the gateway may have accepted the first attempt", async () => {
    const context = await fixture()
    context.prepare()
    await context.enqueue()
    context.gateway.sendCard.mockImplementationOnce(
      async () => ({ state: "rejected", resultUnknown: true }) as never
    )
    await context.client.sendPending()
    await context.cards.flush()
    context.advance()
    await context.cards.stop()
    await context.makeCards().flush()
    const [first, second] = context.gateway.sendCard.mock.calls.map(([payload]) => payload)
    expect(first.idempotencyKey).toBe(second.idempotencyKey)
    expect(first.tag).toBe(second.tag)
    expect(first.interactionId).toBe(second.interactionId)
    expect(context.events.sessionLinks.getCard("reply-1")?.state).toBe("sent")
    expect(
      vi.mocked(trackEvent).mock.calls.filter(([, , detail]) => detail?.kind === "card")
    ).toEqual([
      [
        "im.message.delivered",
        "im",
        {
          direction: "outbound",
          kind: "card",
          cardKind: "target_bind",
          outcome: "sent"
        }
      ]
    ])
  })

  it("counts an exhausted card delivery once while preserving the text fallback", async () => {
    const context = await fixture()
    const code = context.prepare()
    await context.enqueue()
    context.gateway.sendCard.mockResolvedValue({ state: "rejected" } as never)
    await context.client.sendPending()
    await context.cards.flush()
    for (let attempt = 1; attempt < 3; attempt++) {
      context.advance()
      await context.cards.flush()
    }
    await context.cards.flush()
    expect(context.gateway.sendCard).toHaveBeenCalledTimes(3)
    expect(context.events.sessionLinks.getCard("reply-1")?.state).toBe("skipped")
    expect(context.events.sessionLinks.get(code)?.thread_id).toBe("source-thread")
    expect(
      vi.mocked(trackEvent).mock.calls.filter(([, , detail]) => detail?.kind === "card")
    ).toEqual([
      [
        "im.message.delivered",
        "im",
        {
          direction: "outbound",
          kind: "card",
          cardKind: "target_bind",
          outcome: "failed"
        }
      ]
    ])
  })

  it.each(["text", "already-current"])(
    "keeps the code without sending a card for %s",
    async (mode) => {
      const context = await fixture()
      const code = context.prepare()
      await context.enqueue()
      if (mode === "text") await context.conversations.setReplyMode("chat", "text")
      else
        await context.conversations.registerTarget(
          "chat",
          {
            kind: "thread",
            targetId: "source",
            threadId: "source-thread",
            grantId: "grant",
            grantVersion: 1,
            title: "同名",
            workspacePath: "/repo"
          },
          { activate: true }
        )
      await context.client.sendPending()
      await context.cards.flush()
      expect(context.gateway.sendCard).not.toHaveBeenCalled()
      expect(context.events.sessionLinks.get(code)?.thread_id).toBe("source-thread")
    }
  )

  it("checks the click's owner, route, tag and interaction ID before switching", async () => {
    const context = await fixture()
    context.prepare()
    for (const invalid of [
      { principalId: "other" },
      { conversationKey: "other-chat" },
      { interactionId: "other-card" }
    ]) {
      expect(await context.cards.handleReceipt(context.receipt("reply-1", invalid))).toContain(
        "不属于"
      )
    }
    const card = context.events.sessionLinks.getCard("reply-1")!
    expect(
      await context.cards.handleReceipt(context.receipt("reply-1", { tag: `${card.tag}:approve` }))
    ).toContain("无法识别")
    expect(context.switchSession).not.toHaveBeenCalled()
    expect(context.events.sessionLinks.getCard("reply-1")?.state).toBe("pending")
  })

  it("restores buttons across restart and never reapplies an old receipt or consumed card", async () => {
    const context = await fixture()
    const code = context.prepare()
    await context.enqueue()
    await context.client.sendPending()
    await context.cards.flush()
    await context.cards.stop()
    const restarted = context.makeCards()
    const click = context.receipt()
    expect(await restarted.handleReceipt(click)).toContain("已切换")
    await restarted.flush()
    expect(context.switchSession).toHaveBeenCalledWith({
      principalId: "user",
      conversationKey: "chat",
      code
    })
    expect(context.gateway.updateCard).toHaveBeenCalled()
    await restarted.stop()
    const restartedAgain = context.makeCards()
    expect(await restartedAgain.handleReceipt(click)).toContain("已切换")
    expect(await restartedAgain.handleReceipt({ ...click, receiptId: "another-click" })).toContain(
      "已处理"
    )
    expect(context.switchSession).toHaveBeenCalledTimes(1)
  })

  it("dispatches a target_bind receipt through the existing router without a new gateway kind", async () => {
    const context = await fixture()
    context.prepare()
    const oldResolver = vi.fn()
    const acknowledgeReceipt = vi.fn(async () => undefined)
    const router = new ImCardReceiptRouter({
      events: context.events,
      cards: {
        interactions: { resolveTag: oldResolver },
        acknowledgeReceipt
      } as never
    })
    router.registerSessionSwitchCards(context.cards)
    await router.handle(context.receipt())
    expect(context.switchSession).toHaveBeenCalledTimes(1)
    expect(oldResolver).not.toHaveBeenCalled()
    expect(acknowledgeReceipt).toHaveBeenCalledWith("click-1")
    const response = context.events
      .listOutbox()
      .find((row) => row.deliveryId === "card-receipt:click-1")
    expect(response?.content).toContain("已切换")
  })

  it("requires an explicit code command after a crash during a click rather than silently switching again", async () => {
    const context = await fixture()
    context.prepare()
    const card = context.events.sessionLinks.getCard("reply-1")!
    await context.events.sessionLinks.claimCard(card, "click-1")
    expect(await context.makeCards().handleReceipt(context.receipt())).toContain("尚未确认")
    expect(context.switchSession).not.toHaveBeenCalled()
  })

  it("drains a bounded batch without losing the remaining cards", async () => {
    const context = await fixture()
    for (let index = 0; index < 10; index++) {
      context.prepare(`delivery-${index}`)
      await context.enqueue(`delivery-${index}`)
    }
    const client = new ImReplyClient(context.gateway, context.events, context.persistence.now)
    await client.sendPending()
    await context.cards.flush()
    expect(context.gateway.sendCard).toHaveBeenCalledTimes(4)
    await context.cards.flush()
    await context.cards.flush()
    expect(context.gateway.sendCard).toHaveBeenCalledTimes(10)
  })
})
