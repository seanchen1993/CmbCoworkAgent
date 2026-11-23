import { randomUUID } from "node:crypto"
import { tmpdir } from "node:os"
import { DatabaseSync } from "node:sqlite"
import { expect, it, vi } from "vitest"
import type { BotImEvent } from "../../../shared/bots/im-channel"
import type { RemoteImCardSendV1, RemoteImReplyV1 } from "../../../shared/im-gateway-contract"
import { NativeSqliteAdapter } from "../../db/native-sqlite-adapter"
import {
  cancelUserInputsForThread,
  getPendingUserInputForThread,
  requestUserInput
} from "../user-input"
import { handleBotImInteractionCommand } from "./bot-interaction-command"
import { botInteractionRoutes } from "./bot-interaction-route"
import { imCardPublisher } from "./card-publisher"
import { imConversationStateStore } from "./conversation-state"
import { unavailableImGatewayClient } from "./gateway-client"
import { imRemoteUserInputService } from "./remote-user-input-service"
import { ImReplyClient } from "./reply-client"
import { ensureImServiceSchema } from "./schema"

vi.mock("electron", () => ({
  BrowserWindow: { getAllWindows: () => [] },
  app: { getPath: () => tmpdir() }
}))
vi.mock("../../app-attention-events", () => ({ emitAppAttention: vi.fn() }))
vi.mock("../event-reporter", () => ({ trackEvent: vi.fn() }))
vi.mock("../../db", async (original) => ({
  ...(await original<typeof import("../../db")>()),
  getDb: () => database,
  getThread: () => ({ title: "测试任务" }),
  saveToDisk: () => {},
  flushStrict: async () => {}
}))
vi.mock("../../storage", async (original) => ({
  ...(await original<typeof import("../../storage")>()),
  getBuiltinRobotSettings: () => ({ enabled: true })
}))

let database: NativeSqliteAdapter

it("switches a group task between card and short-code answers through the Bot command and reply outbox", async () => {
  database = new NativeSqliteAdapter(new DatabaseSync(":memory:"))
  ensureImServiceSchema(database)
  const group = "group-A"
  const threadId = "independent-work-thread"
  const cards: RemoteImCardSendV1[] = []
  const replies: RemoteImReplyV1[] = []
  const gateway = {
    ...unavailableImGatewayClient,
    isAuthenticated: () => true,
    sendCard: async (card: RemoteImCardSendV1) => {
      cards.push(card)
      return { state: "accepted" as const }
    },
    updateCard: vi.fn(async () => ({ state: "accepted" as const })),
    submitReply: async (reply: RemoteImReplyV1) => {
      replies.push(reply)
      return { state: "accepted" as const }
    }
  }
  imCardPublisher.setGateway(gateway)
  const outbox = new ImReplyClient(gateway)
  const disconnect = botInteractionRoutes.setTransport(() => true)
  const unregister = botInteractionRoutes.register({
    threadId,
    realm: "test",
    principalId: "owner",
    conversationKey: group,
    kind: "group",
    prefix: "【独立任务】",
    botBindingRef: "binding:test:1",
    isCurrent: () => true
  })
  const questions = [
    {
      id: "format",
      header: "格式",
      question: "交付哪种格式？",
      options: [
        { label: "表格", description: "保留可以逐项核对的完整记录" },
        { label: "报告", description: "给出主要结论" }
      ]
    },
    {
      id: "scope",
      header: "范围",
      question: "统计哪些日期？",
      allowMultiple: true,
      options: [
        { label: "昨天", description: "上一日" },
        { label: "今天", description: "当前日" }
      ]
    }
  ]
  const ask = () => {
    const result = requestUserInput({ threadId, questions, allowDeferredRenderer: true })
    void result.catch(() => {})
    return result
  }
  const send = async (text: string, conversationKey = group) => {
    const id = randomUUID()
    await handleBotImInteractionCommand(
      {
        event: { conversationKey, message: { text } },
        route: { kind: "group", senderId: "member" }
      } as BotImEvent,
      "owner",
      id
    )
    await outbox.sendPending()
    return replies.find((r) => r.deliveryId === `bot-interaction-command:${id}`)!.message.content
  }
  const shortCode = (text: string) => {
    const match = text.match(/\/回答 ([A-F0-9]{6}) /u)
    expect(match).not.toBeNull()
    return match![1]
  }
  try {
    const result = ask()
    await vi.waitFor(() => expect(cards).toHaveLength(1))
    expect(cards[0]).toMatchObject({ conversationKey: group, botBindingRef: "binding:test:1" })
    const request = getPendingUserInputForThread(threadId)!
    const noticeId = `user-input-request:${request.requestId}:0`
    const notices = () => replies.filter((r) => r.deliveryId === noticeId)
    await send("/文字模式 开", "group-B")
    expect(notices()).toHaveLength(0)
    await send("/文字模式")
    await send("/文字模式 开")
    expect(notices()).toHaveLength(1)
    expect(notices()[0]).toMatchObject({ conversationKey: group, message: { type: "text" } })
    const first = shortCode(notices()[0].message.content)
    expect(await send(`/回答 ${first} 2`, "group-B")).toContain("不属于")
    const next = await send(`/回答 ${first} 2`)
    const second = shortCode(next)
    expect(second).not.toBe(first)
    expect(next).toContain("统计哪些日期")
    expect(await send(`/回答 ${first} 1`)).toContain("不存在")
    expect(await send(`/回答 ${second} 1，2`)).toContain("任务将继续")
    expect((await result).answers).toMatchObject({
      format: { type: "option", optionIndex: 1 },
      scope: { type: "options", options: [{ optionIndex: 0 }, { optionIndex: 1 }] }
    })
    expect(getPendingUserInputForThread(threadId)).toBeNull()
    expect(gateway.updateCard).toHaveBeenCalled()
    expect(
      await imRemoteUserInputService.resolveCardAnswers({
        principalId: "owner",
        conversationKey: group,
        requestId: request.requestId,
        feedback: []
      })
    ).toMatch(/不存在|不再/)
    const textOnly = ask()
    const nextId = getPendingUserInputForThread(threadId)!.requestId
    await send("/文字模式 关")
    const pendingText = replies.find((r) => r.deliveryId === `user-input-request:${nextId}:0`)!
    expect(cards).toHaveLength(1)
    const current = shortCode(await send(`/回答 ${shortCode(pendingText.message.content)} 1`))
    await send(`/回答 ${current} 其他 最近七天`)
    expect((await textOnly).answers.scope).toMatchObject({ type: "other", text: "最近七天" })
    expect(imConversationStateStore.getReplyMode("group-B")).toBe("text")
    ask()
    await vi.waitFor(() => expect(cards).toHaveLength(2))
  } finally {
    cancelUserInputsForThread(threadId, "测试结束")
    unregister()
    disconnect()
    imCardPublisher.setGateway(unavailableImGatewayClient)
    database.close()
  }
})
