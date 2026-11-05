import { DatabaseSync } from "node:sqlite"
import { afterEach, describe, expect, it, vi } from "vitest"
import { AIMessage, HumanMessage, ToolMessage } from "@langchain/core/messages"
import { BaseChatModel } from "@langchain/core/language_models/chat_models"
import { MemorySaver } from "@langchain/langgraph"
import { createAgent } from "langchain"
import { NativeSqliteAdapter } from "../db/native-sqlite-adapter"
import { BotStore } from "./store"
import { LocalBotHost, type BotRunPort } from "./host"
import { createBotGroupDeliveryCheck } from "./group-delivery"
import { deriveCheckpointTranscriptIndex } from "../../shared/checkpoint-transcript"
import { StopHookContextCollector } from "../ipc/stop-hook-context"
import { createTurnCompletionGateMiddleware } from "../agent/turn-completion-integrity"
import { botGroupActiveTasks } from "../../renderer/src/lib/bot-group-question"
import {
  clearCurrentRunMessageQueue,
  createCurrentRunMessageQueueMiddleware,
  queueCurrentRunMessage,
  setCurrentRunMessageQueueOwner,
  setCurrentRunInjectionNotifier,
  assertCurrentRunMessagesDurablyPersisted,
  resolveCurrentRunCompletedAssistantIdentity,
  registerCurrentRunCompletedAssistantRoute,
  routeCurrentRunCompletedAssistantMessage
} from "../agent/current-run-message-queue"

vi.mock("../storage", () => ({ getEnabledPluginSkillSourceMetadata: () => [] }))
const cleanups: (() => void | Promise<void>)[] = []
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
})
function fixture(direct = false, runtime?: BotRunPort) {
  const db = new NativeSqliteAdapter(new DatabaseSync(":memory:"))
  cleanups.push(() => db.close())
  const store = new BotStore(db)
  const host = runtime ? new LocalBotHost(store, runtime) : undefined
  if (host) cleanups.push(() => host.stop())
  const create = (name: string) =>
    store.create({ name, instructions: "", color: "#123456", modelRef: null })
  const a = create("Owner"),
    b = create("Implementer"),
    c = create("Reviewer")
  const group = store.saveGroup({ name: "Peer feedback", memberIds: [a.id, b.id, c.id] })
  store.sendGroup({
    groupId: group.id,
    requestId: "original",
    text: "Implement and review",
    targetBotIds: direct ? [a.id, b.id] : [a.id]
  })
  const root = store.recentTasks().find((t) => t.botId === a.id)!
  store.transition(root.id, "running")
  const target = direct
    ? store.recentTasks().find((t) => t.botId === b.id)!
    : store.delegate(root.id, b.id, "Implement report", "implementation", ["report.csv"])
  const reviewer = store.delegate(root.id, c.id, "Review only", "review")
  if (!runtime) store.transition(target.id, "running")
  if (!runtime) store.transition(reviewer.id, "running")
  const feedback = (key = "correction") =>
    store.delegate(reviewer.id, b.id, "Keep the original scope; fix rollback", key, [], target.id)
  return { db, store, host, root, target, reviewer, feedback, group, a, b, c }
}

describe("same-task peer feedback ownership", () => {
  it.each([false, true])(
    "accepts an exact task in the same original group assignment (direct=%s)",
    (direct) => {
      const f = fixture(direct),
        note = f.feedback()
      expect(note.origin).toMatchObject({
        feedbackForTaskId: f.target.id,
        sourceTaskId: f.reviewer.id,
        rootTaskId: direct ? f.target.id : f.root.id,
        expectsReply: false
      })
      expect(f.feedback().id).toBe(note.id)
      expect(() =>
        f.store.delegate(f.reviewer.id, f.b.id, "Changed", "correction", [], f.target.id)
      ).toThrow()
      expect(f.store.injectIntoRun(note.id, f.target.id)).toBe(true)
      expect(f.store.peerHandoff(f.target.id).pending).toBe(false)
      if (!direct) expect(f.store.peerHandoff(f.target.id).outputFiles).toEqual(["report.csv"])
      f.store.settleRun(f.target.id, [note.id], "completed", null, "Verified", undefined, true)
      expect(f.store.getTask(note.id).state).toBe("completed")
      expect(f.store.groupMessages(f.group.id).some((m) => m.id === `result-${note.id}`)).toBe(
        false
      )
      expect(f.store.recentTasks().filter((t) => t.requestId === `reply-${note.id}`)).toHaveLength(
        0
      )
    }
  )
  it.each(["before-create", "before-consume", "both-consume"] as const)(
    "rejects old feedback after a new group input is consumed (%s)", mode => {
      const f = fixture(true)
      const post = f.store.publishGroupMessage(f.root.id, "old-review", `@${f.b.name} Old review`)
      const note = mode === "before-create" ? undefined : f.store.groupFeedback(f.root.id, post.messageId, f.target.id)!
      f.store.transition(f.target.id, "waiting_user")
      f.store.sendGroup({ groupId: f.group.id, requestId: "new-input", text: "New user input", targetBotIds: [f.a.id, f.b.id] })
      const inputFor = (botId: string) => f.store.recentTasks().find(t => t.botId === botId && t.origin.kind === "group" && t.origin.messageId === "new-input")!
      expect(f.store.injectIntoRun(inputFor(f.b.id).id, f.target.id)).toBe(true)
      if (mode === "both-consume") {
        f.store.transition(f.root.id, "waiting_user")
        expect(f.store.injectIntoRun(inputFor(f.a.id).id, f.root.id)).toBe(true)
      }
      expect(f.store.groupFeedback(f.root.id, post.messageId, f.target.id)).toBeUndefined()
      if (note) {
        expect(f.store.injectIntoRun(note.id, f.target.id)).toBe(false)
        expect(f.store.getTask(note.id).state).toBe("cancelled")
      }
      expect(f.store.groupMessages(f.group.id).some(m => m.id === post.messageId)).toBe(true)
      expect(f.store.getTask(f.target.id).state).toBe("waiting_user")
    }
  )

  it.each([true, false])("invalidates the original source/root after consumed user input (direct=%s)", direct => {
    const f = fixture(direct)
    f.store.transition(f.root.id, "waiting_user")
    f.store.sendGroup({ groupId: f.group.id, requestId: "new-input", text: "New input", targetBotIds: [f.a.id] })
    const input = f.store.recentTasks().find(t => t.origin.kind === "group" && t.origin.messageId === "new-input")!
    expect(f.store.injectIntoRun(input.id, f.root.id)).toBe(true)
    const post = f.store.publishGroupMessage(f.reviewer.id, "old-review", `@${f.b.name} Old review`)
    expect(f.store.groupFeedback(f.reviewer.id, post.messageId, f.target.id)).toBeUndefined()
    expect(() => f.feedback()).toThrow("反馈仅能补充")
  })

  it("queued user input alone does not invalidate feedback for the still-running original task", () => {
    const f = fixture(true)
    f.store.sendGroup({ groupId: f.group.id, requestId: "queued-input", text: "Later input", targetBotIds: [f.b.id] })
    const post = f.store.publishGroupMessage(f.root.id, "old-review", `@${f.b.name} Current review`)
    const note = f.store.groupFeedback(f.root.id, post.messageId, f.target.id)!
    expect(f.store.injectIntoRun(note.id, f.target.id)).toBe(true)
  })

  it.each(["failed", "outcome_unknown"] as const)(
    "keeps consumed user input as an assignment boundary after %s",
    (state) => {
      const f = fixture()
      const post = f.store.publishGroupMessage(f.reviewer.id, "old-review", `@${f.b.name} Original review`)
      const queuedFeedback = f.store.groupFeedback(f.reviewer.id, post.messageId, f.target.id)!
      f.store.transition(f.root.id, "waiting_user")
      f.store.sendGroup({ groupId: f.group.id, requestId: "new-input", text: "Use the revised scope", targetBotIds: [f.a.id] })
      const input = f.store.recentTasks().find(t => t.origin.kind === "group" && t.origin.messageId === "new-input")!
      expect(f.store.injectIntoRun(input.id, f.root.id)).toBe(true)
      f.store.settleRun(f.root.id, [input.id], state, "Connection error")
      expect(f.store.getTask(input.id).state).toBe(state)
      expect(f.store.getTask(f.target.id).state).toBe("running")
      const latePost = f.store.publishGroupMessage(f.reviewer.id, "late-review", `@${f.b.name} Original review again`)
      expect(f.store.groupFeedback(f.reviewer.id, latePost.messageId, f.target.id)).toBeUndefined()
      expect(f.store.injectIntoRun(queuedFeedback.id, f.target.id)).toBe(false)
      expect(f.store.getTask(queuedFeedback.id).state).toBe("cancelled")
      expect(f.store.groupMessages(f.group.id).some(m => m.id === latePost.messageId)).toBe(true)
    }
  )

  it.each(["failed", "outcome_unknown"] as const)(
    "does not mistake unconsumed user input for an assignment boundary after %s",
    (state) => {
      const f = fixture()
      f.store.sendGroup({ groupId: f.group.id, requestId: "new-input", text: "Later input", targetBotIds: [f.a.id] })
      f.store.settleRun(f.root.id, [], state, "Connection error")
      const input = f.store.recentTasks().find(t => t.origin.kind === "group" && t.origin.messageId === "new-input")!
      expect(input.state).toBe("queued")
      const post = f.store.publishGroupMessage(f.reviewer.id, "current-review", `@${f.b.name} Original review`)
      const note = f.store.groupFeedback(f.reviewer.id, post.messageId, f.target.id)!
      expect(note).toBeDefined()
      expect(f.store.injectIntoRun(note.id, f.target.id)).toBe(true)
    }
  )

  it("rejects another user request, another group, own feedback and extra output requirements", () => {
    const f = fixture()
    f.store.sendGroup({
      groupId: f.group.id,
      requestId: "different",
      text: "Different task",
      targetBotIds: [f.b.id]
    })
    const other = f.store
      .recentTasks()
      .find((t) => t.origin.kind === "group" && t.origin.messageId === "different")!
    expect(() =>
      f.store.delegate(f.reviewer.id, f.b.id, "Correction", "foreign", [], other.id)
    ).toThrow()
    const room = f.store.saveGroup({ name: "Other", memberIds: [f.b.id, f.c.id] })
    f.store.sendGroup({
      groupId: room.id,
      requestId: "foreign-room",
      text: "Work",
      targetBotIds: [f.b.id]
    })
    const foreign = f.store
      .recentTasks()
      .find((t) => t.origin.kind === "group" && t.origin.messageId === "foreign-room")!
    expect(() =>
      f.store.delegate(f.reviewer.id, f.b.id, "Correction", "room", [], foreign.id)
    ).toThrow()
    expect(() =>
      f.store.delegate(f.reviewer.id, f.c.id, "Self", "self", [], f.reviewer.id)
    ).toThrow()
    expect(() =>
      f.store.delegate(f.reviewer.id, f.b.id, "New outputs", "files", ["extra.txt"], f.target.id)
    ).toThrow()
    expect(f.store.getTask(f.target.id).origin).not.toHaveProperty("feedbackForTaskId")
  })
  it.each(["completed", "failed", "cancelled", "interrupted", "superseded"] as const)(
    "ends unconsumed feedback silently when target becomes %s",
    (state) => {
      const f = fixture(),
        note = f.feedback()
      f.store.settleRun(
        f.target.id,
        [],
        state,
        state === "completed" ? null : "Stopped",
        "Result",
        undefined,
        true
      )
      expect(f.store.getTask(note.id).state).toBe("cancelled")
      expect(f.store.pendingTasksForThread(f.target.threadId)).toHaveLength(0)
      expect(f.store.groupMessages(f.group.id).some((m) => m.id === `result-${note.id}`)).toBe(
        false
      )
    }
  )
  it("retains consumed feedback across checkpoint deferral without blocking or replaying the task", () => {
    const f = fixture(),
      note = f.feedback()
    f.store.injectIntoRun(note.id, f.target.id)
    f.store.deferTask(f.target.id, "checkpoint-1")
    expect(f.store.nextQueued([])?.id).toBe(f.target.id)
    expect(f.store.nextQueued([])?.id).not.toBe(note.id)
    f.store.transition(f.target.id, "running")
    f.store.settleRun(f.target.id, [], "completed", null, "Restored result", undefined, true)
    expect(f.store.getTask(note.id).state).toBe("completed")
  })
  it.each([false, true])(
    "restart fences feedback without publishing a new result (consumed=%s)",
    (consumed) => {
      const f = fixture(),
        note = f.feedback()
      if (consumed) f.store.injectIntoRun(note.id, f.target.id)
      f.store.recover()
      expect(["interrupted", "cancelled"]).toContain(f.store.getTask(note.id).state)
      expect(f.store.groupMessages(f.group.id).some((m) => m.id === `result-${note.id}`)).toBe(
        false
      )
      expect(f.store.nextQueued([])?.id).not.toBe(note.id)
    }
  )
  it("a sender cancellation invalidates feedback before consumption", () => {
    const f = fixture(true),
      note = f.feedback()
    f.store.settle(f.reviewer.id, "cancelled", "Cancelled")
    expect(f.store.injectIntoRun(note.id, f.target.id)).toBe(false)
    expect(f.store.getTask(note.id).state).toBe("cancelled")
    expect(f.store.getTask(f.target.id).state).toBe("running")
  })
  it("does not replace ordinary queued delegations or independently dispatch feedback", () => {
    const f = fixture(),
      note = f.feedback()
    const ordinary = f.store.delegate(f.reviewer.id, f.b.id, "New authorized review", "ordinary")
    expect(ordinary.origin).toMatchObject({ expectsReply: true })
    f.store.settleRun(f.target.id, [], "completed", null, "Finished", undefined, true)
    expect(f.store.nextQueued([])?.id).not.toBe(note.id)
    expect(f.store.nextQueued([])?.id).toBe(ordinary.id)
  })
})

describe("automatic public review routing", () => {
  it("routes a discussion review to the original live assignment without model task IDs", () => {
    const f = fixture(true)
    f.store.transition(f.reviewer.id, "completed")
    const reviewer = f.store.enqueue({ botId: f.c.id, message: "Review original", requestId: "public-review" },
      { kind: "discussion", groupId: f.group.id, messageId: "original", round: 1 })
    f.store.transition(reviewer.id, "running")
    const post = f.store.publishGroupMessage(reviewer.id, "review", `@${f.b.name} rollback must leave state unchanged`)
    const note = f.store.groupFeedback(reviewer.id, post.messageId, f.target.id)!
    expect(note.origin).toMatchObject({ feedbackMessageId: post.messageId, feedbackForTaskId: f.target.id, expectsReply: false })
    expect(f.store.groupFeedback(reviewer.id, post.messageId, f.target.id)?.id).toBe(note.id)
    expect(f.store.injectIntoRun(note.id, f.target.id)).toBe(true)
    expect(f.store.groupMessages(f.group.id).find(m => m.id === post.messageId)?.text).toContain("rollback")
  })
  it("delivers a multi-mention post once to each active named recipient", () => {
    const f = fixture(true)
    const post = f.store.publishGroupMessage(f.reviewer.id, "both", `@${f.a.name} @${f.b.name} preserve rollback`)
    const a = f.store.groupFeedback(f.reviewer.id, post.messageId, f.root.id)!
    const b = f.store.groupFeedback(f.reviewer.id, post.messageId, f.target.id)!
    expect(a.id).not.toBe(b.id)
    expect(f.store.groupFeedback(f.reviewer.id, post.messageId, f.root.id)?.id).toBe(a.id)
    expect(f.store.groupFeedback(f.reviewer.id, post.messageId, f.target.id)?.id).toBe(b.id)
    expect(f.store.injectIntoRun(a.id, f.root.id)).toBe(true)
    expect(f.store.injectIntoRun(b.id, f.target.id)).toBe(true)
  })
  it("does not steer open chatter, all-members mentions, unrelated assignments or oversized posts", () => {
    const f = fixture(true)
    for (const [key, text] of [["open", "Review done"], ["all", "@everyone review done"], ["large", `@${f.b.name} ${"x".repeat(30001)}`]]) {
      const post = f.store.publishGroupMessage(f.reviewer.id, key, text)
      expect(f.store.groupFeedback(f.reviewer.id, post.messageId, f.target.id)).toBeUndefined()
    }
    const post = f.store.publishGroupMessage(f.reviewer.id, "direct", `@${f.b.name} feedback`)
    f.store.sendGroup({ groupId: f.group.id, requestId: "next-user", text: "Unrelated", targetBotIds: [f.b.id] })
    const other = f.store.recentTasks().find(t => t.origin.kind === "group" && t.origin.messageId === "next-user")!
    f.store.transition(f.target.id, "completed")
    f.store.transition(other.id, "running")
    expect(f.store.groupFeedback(f.reviewer.id, post.messageId, other.id)).toBeUndefined()
    f.store.transition(other.id, "cancelled")
    expect(f.store.groupFeedback(f.reviewer.id, post.messageId, f.target.id)).toBeUndefined()
  })
  it.each([false, true])("only excludes actually consumed posts from later discussion (consumed=%s)", consumed => {
    const f = fixture(true)
    const older = f.store.publishGroupMessage(f.reviewer.id, "older", `@${f.b.name} earlier unread detail`)
    const post = f.store.publishGroupMessage(f.reviewer.id, "later", `@${f.b.name} latest correction`)
    const note = f.store.groupFeedback(f.reviewer.id, post.messageId, f.target.id)!
    if (consumed) f.store.injectIntoRun(note.id, f.target.id)
    f.store.transition(f.reviewer.id, "completed")
    f.store.settleRun(f.root.id, [], "completed", null, undefined, undefined, true)
    f.store.settleRun(f.target.id, consumed ? [note.id] : [], "completed", null, undefined, undefined, true)
    f.store.advanceGroupDiscussions()
    const discussion = f.store.getTask(f.store.groupDiscussionTask(f.group.id)!)
    expect(discussion.botId).toBe(f.b.id)
    expect(discussion.message).toContain("earlier unread detail")
    expect(discussion.message.includes("latest correction")).toBe(!consumed)
    expect(f.store.groupMessages(f.group.id).some(m => m.id === older.messageId)).toBe(true)
  })
})

it("Host injects only at its ready boundary, keeps original execution and returns once", async () => {
  // Both tasks are owned by the real Host; publish through its normal room API.
  const injections = new Map<string, () => boolean>()
  let finish!: () => void
  const pending = new Promise<void>((resolve) => {
    finish = resolve
  })
  const steer = vi.fn(async (task, consume) => {
    injections.set(task.id, consume)
    return true
  })
  const execute = vi.fn(async () => {
    await pending
    return { state: "completed" as const, result: "Verified" }
  })
  const acquire = vi.fn<BotRunPort["acquire"]>((_bot, task) =>
    [f.target.id, f.reviewer.id].includes(task.id) ? { execute, steer, release: vi.fn() } : null
  )
  const f = fixture(false, { acquire, onAvailable: () => () => {} })
  const host = f.host!
  cleanups.push(() => finish())
  await vi.waitFor(() => expect(execute).toHaveBeenCalledTimes(2))
  const text = `@${f.b.name} Exact correction`
  const receipt = host.publishGroupMessage(f.reviewer.id, "host-feedback", text)
  host.publishGroupMessage(f.reviewer.id, "host-feedback", text)
  const notes = f.store.recentTasks().filter(t => t.origin.kind === "bot" && t.origin.feedbackMessageId === receipt.messageId)
  expect(notes).toHaveLength(1)
  const note = notes[0]
  expect(steer).not.toHaveBeenCalled()
  expect(host.peers(f.reviewer.id).find(p => p.id === f.b.id)).toEqual({ id: f.b.id, name: f.b.name })
  host.onSteeringReady(f.target.id)
  await vi.waitFor(() => expect(steer).toHaveBeenCalledOnce())
  expect(injections.get(note.id)!()).toBe(true)
  expect(injections.get(note.id)!()).toBe(true) // strict-flush retry, one consumption
  finish()
  await vi.waitFor(() => expect(f.store.getTask(f.target.id).state).toBe("completed"))
  expect(f.store.getTask(note.id).state).toBe("completed")
  expect(execute).toHaveBeenCalledTimes(2)
  expect(f.store.recentTasks().filter((t) => t.requestId === `reply-${f.target.id}`)).toHaveLength(
    1
  )
})

it("member-detail Stop cancels the real deferred owner after consuming public peer feedback", async () => {
  let finish!: () => void
  const pending = new Promise<void>((resolve) => { finish = resolve })
  const cancelCommands = vi.fn(async (threadId: string, ids: string[]) => {
    for (const id of ids)
      f.store.settleCommand({ id, threadId, output: "", exitCode: null, truncated: false, cancelled: true })
  })
  const execute = vi.fn(async (taskId: string, signal: AbortSignal) => {
    if (taskId === f.reviewer.id) {
      await new Promise<void>((resolve) => signal.addEventListener("abort", () => resolve(), { once: true }))
      return { state: "completed" as const }
    }
    await pending
    return { state: "deferred" as const, checkpointId: "member-stop-checkpoint" }
  })
  const f = fixture(false, {
    onAvailable: () => () => {},
    cancelCommands,
    acquire: (_bot, task) => [f.target.id, f.reviewer.id].includes(task.id)
      ? { execute: (signal) => execute(task.id, signal), steer: async (_note, consume) => consume(), release: () => {} }
      : null
  })
  cleanups.push(() => finish())
  const host = f.host!
  await vi.waitFor(() => expect(execute).toHaveBeenCalledTimes(2))
  const receipt = host.publishGroupMessage(f.reviewer.id, "member-stop-feedback", `@${f.b.name} Preserve rollback`)
  const note = f.store.recentTasks().find(t => t.origin.kind === "bot" && t.origin.feedbackMessageId === receipt.messageId)!
  host.onSteeringReady(f.target.id)
  await vi.waitFor(() => expect(f.store.getTask(note.id).state).toBe("running"))
  f.store.acceptCommand(f.target.id, {
    id: "member-stop-job", threadId: f.target.threadId, command: "long-work", cwd: "/tmp", startedAt: 1
  }, true)
  finish()
  await vi.waitFor(() => expect(f.store.getTask(f.target.id).state).toBe("queued"))
  const selected = botGroupActiveTasks(f.group.id, host.snapshot().tasks).find(t => t.botId === f.b.id)!
  expect(selected.id).toBe(f.target.id)
  host.cancel(selected.id)
  await vi.waitFor(() => expect(f.store.getTask(f.target.id).state).toBe("cancelled"))
  expect(cancelCommands).toHaveBeenCalledExactlyOnceWith(f.target.threadId, ["member-stop-job"])
  expect(f.store.getTask(note.id).state).toBe("cancelled")
  expect(f.store.getTask(f.reviewer.id).state).toBe("running")
  expect(execute.mock.calls.filter(([id]) => id === f.target.id)).toHaveLength(1)
})

it("the real queue preserves peer identity without replacing the user's history or StopHook request", async () => {
  const thread = "peer-test",
    token = "run-peer",
    original = new HumanMessage({ id: "user", content: "Only implement the original contract" })
  setCurrentRunMessageQueueOwner(thread, token)
  cleanups.push(() => clearCurrentRunMessageQueue(thread))
  const notifier = vi.fn(async () => {})
  setCurrentRunInjectionNotifier(notifier)
  const beforeInject = vi.fn(() => true)
  expect(
    queueCurrentRunMessage(
      thread,
      {
        id: "feedback",
        content: "Peer data, not user authorization",
        beforeInject,
        peerFeedback: { senderBotId: "reviewer", sourceTaskId: "source", targetTaskId: "target" }
      },
      token
    )
  ).toBe(true)
  const middleware = createCurrentRunMessageQueueMiddleware(token)
  const hook =
    typeof middleware.beforeModel === "function"
      ? middleware.beforeModel
      : middleware.beforeModel!.hook
  const update = (await hook(
    { messages: [original] } as never,
    { configurable: { thread_id: thread } } as never
  )) as { messages: HumanMessage[] }
  expect(update.messages).toHaveLength(1)
  const peer = update.messages[0]
  expect(peer.additional_kwargs).toMatchObject({
    cmb_internal_coordinator_notification: true,
    cmb_internal_bot_feedback: true,
    cmb_peer_feedback_source: { targetTaskId: "target" }
  })
  expect(peer._getType()).toBe("human")
  const messages = [original, peer]
  expect(
    deriveCheckpointTranscriptIndex({ channel_values: { messages } }).visibleMessages.map(
      (m) => m.id
    )
  ).toEqual(["user"])
  const collector = new StopHookContextCollector("Only implement the original contract")
  collector.processStreamChunk("values", { messages: messages.map((m) => m.toJSON()) })
  expect(collector.snapshot().userMessage).toBe("Only implement the original contract")
  expect(beforeInject).toHaveBeenCalledOnce()
  expect(
    await hook({ messages } as never, { configurable: { thread_id: thread } } as never)
  ).toBeUndefined()
})

it("feedback neither erases an existing delivery nor excuses an empty private result", () => {
  const f = fixture(),
    task = f.target
  const peer = new HumanMessage({
    content: "Review data",
    additional_kwargs: {
      cmb_internal_coordinator_notification: true,
      cmb_internal_bot_feedback: true
    }
  })
  const delivered = [
    new HumanMessage("Original"),
    new AIMessage({
      content: "",
      tool_calls: [{ id: "send", name: "bot_send_message", args: {} }]
    }),
    new ToolMessage({
      tool_call_id: "send",
      content: JSON.stringify({
        kind: "bot-group-message",
        groupId: f.group.id,
        taskId: task.id,
        messageId: "post"
      })
    }),
    peer,
    new AIMessage("")
  ]
  expect(createBotGroupDeliveryCheck(task)(delivered)).toBeUndefined()

})

it.each([false, true])("the actual graph preserves feedback order and final checks (reused provider ID=%s)", async (reuseId) => {
  const thread = `peer-real-graph-${reuseId}`,
    token = "peer-owner",
    saver = new MemorySaver()
  setCurrentRunMessageQueueOwner(thread, token)
  cleanups.push(() => clearCurrentRunMessageQueue(thread))
  setCurrentRunInjectionNotifier(async () => {})
  const checkFinalDelivery = vi.fn(() => undefined)
  let calls = 0
  class Model extends BaseChatModel {
    _llmType() {
      return "peer-feedback-graph"
    }
    bindTools() {
      return this
    }
    async _generate(messages: import("@langchain/core/messages").BaseMessage[]) {
      calls++
      if (calls === 1)
        queueCurrentRunMessage(
          thread,
          {
            id: "graph-feedback",
            content: "Peer: rollback must be atomic",
            beforeInject: () => true,
            peerFeedback: { senderBotId: "reviewer", sourceTaskId: "review", targetTaskId: "task" }
          },
          token
        )
      else {
        expect(
          messages
            .filter(
              (m) =>
                HumanMessage.isInstance(m) &&
                !m.additional_kwargs.cmb_internal_coordinator_notification
            )
            .map((m) => m.content)
        ).toEqual(["Original authorized scope"])
        expect(
          messages.some(
            (m) => m.id === "graph-feedback" && m.additional_kwargs.cmb_internal_bot_feedback
          )
        ).toBe(true)
      }
      const content = calls === 1 ? "Draft before feedback" : "Corrected within original scope"
      return { generations: [{ text: content, message: new AIMessage({ id: reuseId ? "same-provider-id" : `provider-${calls}`, content }) }] }
    }
  }
  const agent = createAgent({
    model: new Model({}),
    tools: [],
    checkpointer: saver,
    middleware: [
      createTurnCompletionGateMiddleware({ ownerRunToken: token, todoGateEnabled: false, checkFinalDelivery }),
      createCurrentRunMessageQueueMiddleware(token)
    ]
  })
  const config = { configurable: { thread_id: thread }, recursionLimit: 20 }
  const result = await agent.invoke(
    { messages: [new HumanMessage({ id: "original", content: "Original authorized scope" })] },
    config
  )
  expect(result.messages.at(-1)?.content).toBe("Corrected within original scope")
  expect(calls).toBe(2)
  expect(checkFinalDelivery).toHaveBeenCalledOnce()
  const tuple = await saver.getTuple(config)
  const persisted = tuple?.checkpoint.channel_values.messages as HumanMessage[]
  expect(persisted.map(m => m.content)).toEqual([
    "Original authorized scope", "Draft before feedback", "Peer: rollback must be atomic", "Corrected within original scope"
  ])
  expect(persisted.filter((m) => m.id === "graph-feedback")).toHaveLength(1)
  expect(
    persisted.find((m) => m.id === "graph-feedback")?.additional_kwargs.cmb_peer_feedback_source
  ).toMatchObject({ sourceTaskId: "review", targetTaskId: "task" })
})

// Exercise the production notifier as well as the queue: a Bot-only tool result
// can be in graph state without a visible transcript row (CU1103 regression).
describe("peer feedback with checkpoint-only predecessors", () => {
  async function installProductionNotifier(owner: () => boolean = () => true) {
    const { readFileSync } = await import("node:fs")
    const { transpileModule, ModuleKind, ScriptTarget } = await import("typescript")
    const source = readFileSync(new URL("../agent/runtime.ts", import.meta.url), "utf8")
    const begin = source.indexOf("setCurrentRunInjectionNotifier(async (threadId, messages, context) => {")
    const end = source.indexOf("\nconst BASE_PROMPT", begin)
    expect(begin).toBeGreaterThan(0)
    expect(end).toBeGreaterThan(begin)
    const callback = transpileModule(source.slice(begin, end), {
      compilerOptions: { target: ScriptTarget.ES2022, module: ModuleKind.CommonJS }
    }).outputText
    const flush = vi.fn(), identities = vi.fn(() => []), resolve = vi.fn(() => undefined)
    const writes = vi.fn((_thread: string, messages: unknown[]) => messages.length)
    const moveAfterAnchor = vi.fn(), moveAfterLast = vi.fn(), strict = vi.fn(async () => {})
    const send = vi.fn()
    const dependencies = {
      setCurrentRunInjectionNotifier, isCurrentRunMessageQueueOwner: owner,
      flushTranscriptBeforeCurrentRunInjection: flush, getThreadMessageIdentityContext: identities,
      resolveCurrentRunInjectionAnchorId: resolve, resolveCurrentRunCompletedAssistantIdentity,
      replaceThreadMessageId: vi.fn(() => true), upsertThreadMessages: writes,
      assertCurrentRunMessagesDurablyPersisted,
      moveThreadMessagesAfterAnchor: moveAfterAnchor, moveThreadMessagesAfterLastNonAssistant: moveAfterLast,
      flushStrict: strict, registerCurrentRunCompletedAssistantRoute,
      BrowserWindow: { getAllWindows: () => [{ isDestroyed: () => false, webContents: { isDestroyed: () => false, send } }] }
    }
    new Function(...Object.keys(dependencies), callback)(...Object.values(dependencies))
    return { flush, identities, resolve, writes, moveAfterAnchor, moveAfterLast, strict, send }
  }
  const peer = {
    id: "peer-note", content: "Please check the original contract",
    peerFeedback: { senderBotId: "reviewer", sourceTaskId: "source", targetTaskId: "target" }
  }
  const tool = () => new ToolMessage({ id: "graph-only-tool", tool_call_id: "send", content: "Posted" })
  it.each(["beforeModel", "afterModel"] as const)(
    "injects pure peer in %s without requiring a visible tool row and preserves assistant identity",
    async (phase) => {
      const spies = await installProductionNotifier()
      const thread = `peer-invisible-${phase}`, token = "owner"
      setCurrentRunMessageQueueOwner(thread, token)
      cleanups.push(() => clearCurrentRunMessageQueue(thread))
      queueCurrentRunMessage(thread, peer, token)
      const middleware = createCurrentRunMessageQueueMiddleware(token)
      const chosen = middleware[phase]!
      const hook = typeof chosen === "function" ? chosen : chosen.hook
      const reply = new AIMessage({ id: "original-assistant", content: "Waiting for results" })
      const update = await hook(
        { messages: phase === "afterModel" ? [tool(), reply] : [tool()] } as never,
        { configurable: { thread_id: thread } } as never
      ) as { messages: HumanMessage[]; jumpTo?: string }
      expect(update.messages[0].additional_kwargs.cmb_internal_bot_feedback).toBe(true)
      if (phase === "afterModel") {
        expect(update.jumpTo).toBe("model")
        expect(reply.id).toMatch(/^current-run-assistant:/)
        expect(spies.flush).toHaveBeenCalledOnce()
        expect(spies.strict).toHaveBeenCalledOnce()
        expect(spies.writes.mock.calls[0][1]).toEqual([
          expect.objectContaining({ id: reply.id, role: "assistant", content: "Waiting for results" })
        ])
        expect(spies.send).toHaveBeenCalledExactlyOnceWith(`agent:stream:${thread}`, expect.objectContaining({
          data: expect.objectContaining({ type: "message_id_alias", fromId: "original-assistant", toId: reply.id })
        }))
        expect(routeCurrentRunCompletedAssistantMessage(thread, {
          id: "original-assistant", role: "assistant", content: "Waiting for results"
        }, token)?.stableId).toBe(reply.id)
      } else {
        expect(reply.id).toBe("original-assistant")
        expect(spies.flush).not.toHaveBeenCalled()
        expect(spies.identities).not.toHaveBeenCalled()
        expect(spies.writes).not.toHaveBeenCalled()
        expect(spies.send).not.toHaveBeenCalled()
      }
    }
  )
  it("classifies the actual batch after a user message is withdrawn", async () => {
    const spies = await installProductionNotifier()
    const thread = "peer-withdrawn-user", token = "owner"
    setCurrentRunMessageQueueOwner(thread, token)
    cleanups.push(() => clearCurrentRunMessageQueue(thread))
    queueCurrentRunMessage(thread, { id: "withdrawn", content: "User", beforeInject: () => false }, token)
    queueCurrentRunMessage(thread, peer, token)
    const chosen = createCurrentRunMessageQueueMiddleware(token).beforeModel!
    const hook = typeof chosen === "function" ? chosen : chosen.hook
    const update = await hook({ messages: [tool()] } as never, { configurable: { thread_id: thread } } as never) as { messages: HumanMessage[] }
    expect(update.messages.map(m => m.id)).toEqual([peer.id])
    expect(spies.flush).not.toHaveBeenCalled()
  })
  it.each([false, true])("retains strict transcript validation for user batches (mixed=%s)", async (mixed) => {
    const spies = await installProductionNotifier()
    const thread = `peer-visible-${mixed}`, token = "owner"
    setCurrentRunMessageQueueOwner(thread, token)
    cleanups.push(() => clearCurrentRunMessageQueue(thread))
    queueCurrentRunMessage(thread, { id: "user", content: "Actual user message" }, token)
    if (mixed) queueCurrentRunMessage(thread, peer, token)
    const chosen = createCurrentRunMessageQueueMiddleware(token).beforeModel!
    const hook = typeof chosen === "function" ? chosen : chosen.hook
    await expect(hook({ messages: [tool()] } as never, { configurable: { thread_id: thread } } as never))
      .rejects.toThrow("Cannot resolve current-run injection predecessor")
    expect(spies.flush).toHaveBeenCalledOnce()
    expect(spies.identities).toHaveBeenCalledOnce()
  })
  it("does not acknowledge pure peer after ownership changes", async () => {
    await installProductionNotifier(() => false)
    const thread = "peer-stale-owner", token = "owner"
    setCurrentRunMessageQueueOwner(thread, token)
    cleanups.push(() => clearCurrentRunMessageQueue(thread))
    queueCurrentRunMessage(thread, peer, token)
    const chosen = createCurrentRunMessageQueueMiddleware(token).beforeModel!
    const hook = typeof chosen === "function" ? chosen : chosen.hook
    await expect(hook({ messages: [tool()] } as never, { configurable: { thread_id: thread } } as never))
      .rejects.toMatchObject({ name: "AbortError" })
  })
})
