import { expect, it } from "vitest"
import type { BotRun } from "../../../shared/bot-types"
import {
  botConversationTaskAddress,
  botConversationTaskPage,
  botConversationTaskScopeKey,
  canCancelBotConversationTask,
  selectBotConversationTasks
} from "./bot-conversation-tasks"

function run(index: number, changes: Partial<BotRun> = {}): BotRun {
  return {
    id: `run-${String(index).padStart(4, "0")}`,
    botId: "bot",
    conversationId: "conversation",
    messageId: `message-${index}`,
    parentRunId: null,
    rootRunId: `run-${index}`,
    depth: 0,
    lane: "user",
    source: "user",
    status: "queued",
    revision: 1,
    fence: 0,
    leaseOwner: null,
    leaseUntil: null,
    checkpoint: null,
    result: null,
    error: null,
    createdAt: index,
    updatedAt: index,
    waitingForBot: null,
    ...changes
  }
}
const scope = { conversationId: "conversation", dataEpoch: "initial" }

it("keeps a 2,000-task queue reachable in 20-row pages while mounting one inline representative", () => {
  const runs = Array.from({ length: 2000 }, (_, index) => run(index))
  const summary = selectBotConversationTasks(runs, scope)
  expect(summary.total).toBe(2000)
  expect(summary.queued).toBe(2000)
  expect(summary.inline.map((item) => item.id)).toEqual([runs[0].id])
  const seen: string[] = []
  for (let page = 0; page < 100; page++) {
    const value = botConversationTaskPage(summary.items, page)
    expect(value.pageCount).toBe(100)
    expect(value.items).toHaveLength(20)
    seen.push(...value.items.map((item) => item.id))
  }
  expect(seen).toEqual(runs.map((item) => item.id))
  expect(new Set(seen).size).toBe(2000)
})

it("prioritizes review, human input and running tasks without shuffling paginated progress updates", () => {
  const runs = [
    run(0),
    run(1, { status: "running", output: "visible stream" }),
    run(2, { status: "needs_review" }),
    run(3, { status: "waiting_input" }),
    run(4, { status: "running", waitingForComputer: true }),
    run(5, { status: "cancelling" })
  ]
  const summary = selectBotConversationTasks(runs, scope)
  expect(summary.inline.map((item) => item.id)).toEqual([
    runs[2].id,
    runs[3].id,
    runs[4].id,
    runs[1].id
  ])
  expect(summary).toMatchObject({ total: 6, attention: 3, running: 1, queued: 1, cancelling: 1 })
  const changed = selectBotConversationTasks(
    runs.map((item) => ({ ...item, activity: { kind: "thinking", description: "new progress" } })),
    scope
  )
  expect(changed.items.map((item) => item.id)).toEqual(summary.items.map((item) => item.id))
  expect(changed.inline[3].output).toBe("visible stream")
})

it("scopes mainline and branches separately, resolves duplicate revisions and omits settled tasks", () => {
  const original = run(0)
  const newest = { ...original, status: "needs_review" as const, revision: 2 }
  const branch = run(1, { threadRootId: "thread" })
  const runs = [
    newest,
    branch,
    original,
    run(2, { conversationId: "other" }),
    run(3, { status: "succeeded" }),
    run(4, { status: "failed" }),
    run(5, { status: "cancelled" })
  ]
  expect(selectBotConversationTasks(runs, scope).items).toEqual([newest])
  expect(selectBotConversationTasks(runs, { ...scope, threadRootId: "thread" }).items).toEqual([
    branch
  ])
  expect(
    selectBotConversationTasks([original, { ...original, revision: 2, status: "cancelled" }], scope)
      .total
  ).toBe(0)
  expect(botConversationTaskAddress(branch, scope)).toBeNull()
  expect(botConversationTaskAddress(branch, { ...scope, threadRootId: "thread" })).toEqual({
    conversationId: "conversation",
    threadRootId: "thread",
    runId: branch.id
  })
})

it("clamps pages after tasks settle and never exposes cancellation for review or terminal states", () => {
  const items = Array.from({ length: 21 }, (_, index) => run(index))
  expect(botConversationTaskPage(items, 200)).toMatchObject({
    page: 1,
    pageCount: 2,
    items: [items[20]]
  })
  expect(botConversationTaskPage(items.slice(0, 5), 1)).toMatchObject({
    page: 0,
    pageCount: 1,
    total: 5
  })
  expect(botConversationTaskPage(items, NaN).page).toBe(0)
  expect(botConversationTaskPage(items, -1).page).toBe(0)
  expect(botConversationTaskPage([], 100)).toMatchObject({
    page: 0,
    pageCount: 1,
    total: 0,
    items: []
  })
  for (const status of ["queued", "running", "waiting_input"] as const)
    expect(canCancelBotConversationTask({ status })).toBe(true)
  for (const status of ["needs_review", "cancelling", "succeeded", "failed", "cancelled"] as const)
    expect(canCancelBotConversationTask({ status })).toBe(false)
})

it("fences view, branch and data restore epochs independently", () => {
  expect(botConversationTaskScopeKey(scope)).not.toBe(
    botConversationTaskScopeKey({ ...scope, dataEpoch: "restored" })
  )
  expect(botConversationTaskScopeKey(scope)).not.toBe(
    botConversationTaskScopeKey({ ...scope, threadRootId: "thread" })
  )
  expect(botConversationTaskScopeKey(scope)).not.toBe(
    botConversationTaskScopeKey({ ...scope, conversationId: "other" })
  )
})
