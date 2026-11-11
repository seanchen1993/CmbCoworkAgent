import { beforeEach, expect, it, vi } from "vitest"
import type { BotImEvent } from "../../../shared/bots/im-channel"

const io = vi.hoisted(() => ({
  retry: vi.fn(),
  approval: vi.fn(),
  enqueue: vi.fn(),
  resend: vi.fn()
}))
vi.mock("./remote-user-input-service", () => ({
  imRemoteUserInputService: {
    resolveAnswer: vi.fn(),
    resendPendingAsText: async () => ({ resent: 0, failed: 0 })
  }
}))
vi.mock("./remote-approval-service", () => ({
  imRemoteApprovalService: {
    resolveCode: io.approval,
    resendPendingAsText: async () => ({ resent: 0, failed: 0 })
  }
}))
vi.mock("./human-gate-adapter", () => ({
  imHumanGateAdapter: {
    resolveCode: vi.fn(),
    resendPendingAsText: async () => ({ resent: 0, failed: 0 })
  }
}))
vi.mock("./biz-retry-adapter", () => ({
  imBizRetryAdapter: { resolveCode: io.retry, resendPendingAsText: io.resend }
}))
vi.mock("./conversation-state", () => ({
  imConversationStateStore: {
    ensureConversation: async () => {},
    getReplyMode: () => "card",
    setReplyMode: async () => {}
  }
}))
vi.mock("./event-store", () => ({ imEventStore: { enqueueProactiveReplies: io.enqueue } }))
import { handleBotImInteractionCommand } from "./bot-interaction-command"

beforeEach(() => {
  vi.clearAllMocks()
  io.retry.mockResolvedValue("已处理")
  io.resend.mockResolvedValue({ resent: 1, failed: 0 })
  io.enqueue.mockResolvedValue([])
})
const send = (text: string) =>
  handleBotImInteractionCommand(
    {
      event: { conversationKey: "group", message: { text } },
      route: { kind: "group", senderId: "member" }
    } as BotImEvent,
    "owner",
    "message"
  )

it.each([
  ["停止托管运行", "stop"],
  ["在当前会话继续托管", "continue"],
  ["开启新会话继续托管", "new_thread"]
])("handles %s without running the model", async (command, choice) => {
  await send(`/${command} AABB01`)
  expect(io.retry).toHaveBeenCalledWith({
    principalId: "owner",
    conversationKey: "group",
    code: "AABB01",
    choice
  })
  expect(io.enqueue.mock.calls[0][0][0]).toMatchObject({
    conversationKey: "group",
    message: { content: "已处理" }
  })
})

it("preserves multiline instructions and rejects messages attached to stop/new-thread", async () => {
  await send("/在当前会话继续托管 AABB01 保留这一行\n以及  两个空格")
  expect(io.retry.mock.calls[0][0].message).toBe("保留这一行\n以及  两个空格")
  await send("/停止托管运行 AABB01 顺便再改代码")
  expect(io.retry).toHaveBeenCalledOnce()
  expect(JSON.stringify(io.enqueue.mock.calls.at(-1))).toContain("附加消息仅用于")
})

it("does not grant local operation approval from a group text event", async () => {
  await send("/批准 AABB01")
  expect(io.approval).not.toHaveBeenCalled()
  expect(JSON.stringify(io.enqueue.mock.calls)).toContain("绑定 Bot 的本人")
})

it("resends a waiting managed decision when a group switches to text", async () => {
  await send("/文字模式 开")
  expect(io.resend).toHaveBeenCalledWith("group")
})
