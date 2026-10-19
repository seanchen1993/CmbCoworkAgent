import { describe, expect, it } from "vitest"
import type { BotTask, BotTaskState } from "../../../shared/bots/contracts"
import type { UserInputRequest } from "@/types"
import { botGroupActiveTasks, botGroupQuestion } from "./bot-group-question"

const task: BotTask = {
  id: "task",
  botId: "member",
  threadId: "group-room-member",
  requestId: "user-turn",
  message: "Choose a format",
  state: "waiting_user",
  error: null,
  createdAt: 1,
  updatedAt: 1,
  origin: { kind: "group", groupId: "room", messageId: "message" }
}
const request: UserInputRequest = {
  requestId: "question",
  threadId: task.threadId,
  createdAt: "2026-10-19T00:00:00Z",
  questions: [{ id: "format", header: "Format", question: "Which format?", options: [] }]
}

describe("group question ownership", () => {
  it("shows one activity per member and never masks an active question with a queued receipt", () => {
    const queued = { ...task, id: "queued", state: "queued" as const }
    const running = { ...task, id: "running", state: "running" as const }
    const other = { ...task, id: "other", botId: "other-member" }
    expect(botGroupActiveTasks("room", [queued, running, task, other])).toEqual([task, other])
    expect(botGroupActiveTasks("room", [task, running, queued])).toEqual([task])
  })

  it("does not mix other rooms, private tasks or terminal receipts into room activity", () => {
    expect(
      botGroupActiveTasks("room", [
        { ...task, origin: { kind: "user" } },
        { ...task, origin: { kind: "group", groupId: "other-room", messageId: "m" } },
        { ...task, state: "completed" },
        { ...task, state: "cancelled" },
        { ...task, state: "failed" }
      ])
    ).toEqual([])
  })
  it("reuses the exact live request during the Host waiting-state transition", () => {
    expect(botGroupQuestion("room", task, request)).toBe(request)
    expect(botGroupQuestion("room", { ...task, state: "running" }, request)).toBe(request)
    expect(botGroupQuestion("room", task, null)).toBeNull()
  })

  it("does not expose a private, different-member or different-room question", () => {
    expect(botGroupQuestion("another-room", task, request)).toBeNull()
    expect(botGroupQuestion("room", { ...task, origin: { kind: "user" } }, request)).toBeNull()
    expect(botGroupQuestion("room", { ...task, botId: "another-member" }, request)).toBeNull()
    expect(botGroupQuestion("room", task, { ...request, threadId: "private" })).toBeNull()
  })

  it.each<BotTaskState>([
    "queued",
    "completed",
    "cancelled",
    "failed",
    "interrupted",
    "superseded",
    "outcome_unknown"
  ])("hides a retained request when its task is %s", (state) => {
    expect(botGroupQuestion("room", { ...task, state }, request)).toBeNull()
  })
})
