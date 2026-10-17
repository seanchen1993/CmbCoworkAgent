import { formatBotMessageReply } from "../../../shared/bots/message-reply"
import { describe, expect, it } from "vitest"
import type { BotDefinition, BotTask, BotTaskOrigin } from "../../../shared/bots/contracts"
import { BOT_REPLY_FILES_PREFIX } from "../../../shared/bots/file-delivery"
import {
  privateBotTasksByBot,
  botTaskPreview,
  botConversationState,
  botFileRefreshKey
} from "./bot-task-view"

const bot: BotDefinition = {
  id: "a",
  hostId: "local",
  threadId: "private-a",
  name: "A",
  instructions: "",
  modelRef: null,
  color: "#168bea",
  archived: false,
  version: 1,
  createdAt: 1,
  updatedAt: 1
}
function task(id: string, origin: BotTaskOrigin, threadId = bot.threadId): BotTask {
  return {
    id,
    botId: bot.id,
    threadId,
    requestId: id,
    message: id,
    origin,
    state: "queued",
    error: null,
    createdAt: 1,
    updatedAt: 1
  }
}

describe("Bot activity follows the original Runtime", () => {
  const idle = {
    hasPendingApproval: false,
    hasPendingUserInput: false,
    workflowRunning: false,
    hasRunningCoordinatorWorker: false
  }
  const completed = { ...task("launch", { kind: "user" }), state: "completed" as const }
  it("keeps a detached workflow or worker busy after the launching turn completes", () => {
    expect(botConversationState([completed], { ...idle, workflowRunning: true })).toBe("running")
    expect(botConversationState([completed], { ...idle, hasRunningCoordinatorWorker: true })).toBe(
      "running"
    )
    expect(botConversationState([completed], idle)).toBeNull()
  })
  it("prioritizes child approval and user input over running work", () => {
    const running = { ...completed, state: "running" as const }
    expect(botConversationState([running], { ...idle, hasPendingApproval: true })).toBe(
      "waiting_user"
    )
    expect(
      botConversationState([completed], {
        ...idle,
        workflowRunning: true,
        hasPendingUserInput: true
      })
    ).toBe("waiting_user")
  })
  it("preserves host task state when no local thread summary exists", () => {
    expect(botConversationState([task("queued", { kind: "user" })])).toBe("queued")
    expect(botConversationState([{ ...completed, state: "running" }])).toBe("running")
    expect(botConversationState([{ ...completed, state: "waiting_user" }])).toBe("waiting_user")
    expect(botConversationState([completed])).toBeNull()
  })
})

it("refreshes files after every settled outcome, including partial cancelled work", () => {
  const queued = task("queued", { kind: "user" })
  expect(botFileRefreshKey([queued, { ...queued, state: "running" }])).toBe("")
  const completed = { ...queued, state: "completed" as const }
  expect(botFileRefreshKey([completed, { ...queued, id: "next", state: "waiting_user" }])).toBe(
    botFileRefreshKey([completed])
  )
  expect(botFileRefreshKey([completed, { ...queued, id: "partial", state: "cancelled" }])).not.toBe(
    botFileRefreshKey([completed])
  )
  expect(botFileRefreshKey([{ ...completed, state: "failed" }])).not.toBe("")
})

describe("private Bot conversation task scope", () => {
  it("keeps native background work busy after its parent turn completes", () => {
    expect(botConversationState([], undefined, true)).toBe("running")
    expect(
      botConversationState(
        [],
        {
          hasPendingApproval: true,
          hasPendingUserInput: false,
          hasRunningCoordinatorWorker: false,
          workflowRunning: false
        },
        true
      )
    ).toBe("waiting_user")
    expect(botConversationState([], undefined, false)).toBeNull()
  })
  it("keeps private user, routine, peer and background work in queue order", () => {
    const entries = [
      task("user", { kind: "user" }),
      task("routine", { kind: "schedule", scheduleId: "daily" }),
      task("peer", {
        kind: "bot",
        fromBotId: "b",
        rootTaskId: "root",
        depth: 1,
        expectsReply: true
      }),
      task("result", { kind: "notification", notificationKind: "workflow", key: "done" })
    ]
    expect(privateBotTasksByBot([bot], entries).get(bot.id)).toEqual(entries)
  })

  it("excludes group messages, handoffs and results from private stop/withdraw controls", () => {
    const origins: BotTaskOrigin[] = [
      { kind: "group", groupId: "team", messageId: "m" },
      {
        kind: "bot",
        groupId: "team",
        fromBotId: "b",
        rootTaskId: "root",
        depth: 1,
        expectsReply: true
      },
      { kind: "notification", groupId: "team", notificationKind: "coordinator", key: "done" }
    ]
    const privateTask = task("private", { kind: "user" })
    const groupTasks = origins.map((origin, index) => task(String(index), origin, "group-team-a"))
    // Also fail closed if a malformed group record points at the private thread.
    const malformed = task("bad-group", origins[0])
    expect(
      privateBotTasksByBot([bot], [...groupTasks, malformed, privateTask]).get(bot.id)
    ).toEqual([privateTask])
  })

  it("does not attribute another thread or a deleted Bot to the current conversation", () => {
    const wrongThread = task("other", { kind: "user" }, "private-b")
    const missingBot = { ...task("missing", { kind: "user" }), botId: "deleted" }
    expect(privateBotTasksByBot([bot], [wrongThread, missingBot]).size).toBe(0)
  })
})

it.each(["completed", "已完成"])(
  "projects %s peer receipts without leaking routing state into task previews",
  (label) => {
    const receipt = {
      ...task("reply-one", {
        kind: "bot",
        fromBotId: "b",
        fromBotName: "核验 Bot",
        rootTaskId: "root",
        depth: 1,
        expectsReply: false
      }),
      message: `核验 Bot 的协作任务已结束（${label}）。\n实际合计：**50.75**`
    }
    expect(botTaskPreview(receipt)).toBe("核验 Bot：实际合计：50.75")
    expect(botTaskPreview({ ...receipt, origin: { kind: "user" } })).toContain(label)
    const withFiles = {
      ...receipt,
      message: `${receipt.message}${BOT_REPLY_FILES_PREFIX}\n{"filePath":"/peer/report.md"}`
    }
    expect(botTaskPreview(withFiles)).toBe("核验 Bot：实际合计：50.75")
    expect(botTaskPreview({ ...withFiles, origin: { kind: "user" } })).toContain("/peer/report.md")
    expect(withFiles.message).toContain("/peer/report.md")
  }
)

it("shows only original visible user text and attachment names in recent work", () => {
  const reply = { id: "original", ordinal: 3, role: "assistant" as const, text: "41" }
  const current = task("request", {
    kind: "user",
    replyTo: { id: reply.id, ordinal: reply.ordinal, role: reply.role }
  })
  current.message = formatBotMessageReply(
    '请核对附件。\n<attachment filename="核验.csv" path="shared/private-dir/核验.csv" type="text/csv">amount\n12.50</attachment>',
    reply
  )
  const preview = botTaskPreview(current)
  expect(preview).not.toContain("\n")
  expect(preview).toContain("请核对附件")
  expect(preview).toContain("核验.csv")
  expect(preview).not.toMatch(/CMBDEVCLAW|attachment|private-dir|12\.50/)
})

it("hides the partial final attachment in a bounded snapshot without reading its body", () => {
  const current = task("bounded", { kind: "user" })
  current.message = (
    '请核对。\n<attachment filename="visible.csv" path="shared/private-dir/visible.csv" size="9999">' +
    "private body ".repeat(1000)
  ).slice(0, 600)
  const preview = botTaskPreview(current)
  expect(preview).toContain("visible.csv")
  expect(preview).toContain("请核对")
  expect(preview).not.toMatch(/attachment|private-dir|private body/)
})
