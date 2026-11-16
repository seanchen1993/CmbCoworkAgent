import { DatabaseSync } from "node:sqlite"
import { afterEach, expect, it, vi } from "vitest"
import type { DynamicStructuredTool } from "@langchain/core/tools"
import type { BotTask } from "../../shared/bots/contracts"
import { NativeSqliteAdapter } from "../db/native-sqlite-adapter"
import { LocalBotHost, type BotRunPort } from "./host"
import { BotStore } from "./store"
import { createBotScheduleTools } from "./tools"
import { createBotWorkTools } from "./work-tools"

const cleanup: Array<() => Promise<void>> = []
afterEach(async () => {
  for (const close of cleanup.splice(0)) await close()
})

function fixture(ordinaryThreads?: BotRunPort["ordinaryThreads"]) {
  const db = new NativeSqliteAdapter(new DatabaseSync(":memory:"))
  const hosts: LocalBotHost[] = []
  cleanup.push(async () => {
    for (const host of hosts.reverse()) await host.stop()
    db.close()
  })
  function reopen() {
    const store = new BotStore(db)
    const host = new LocalBotHost(store, {
      ordinaryThreads,
      onAvailable: () => () => {},
      scheduleObservationPublication: { persist: () => {}, announce: async () => {} },
      acquire: (_bot, task) => task.origin.kind === "user" && !task.workId ? {
        release() {},
        execute: signal => {
          store.beginInputPreparation(task.id)
          store.recordPreparedInput(task.id, task.message)
          return new Promise(resolve =>
            signal.addEventListener("abort", () => resolve({ state: "completed" }), { once: true }))
        }
      } : null
    }, 4, error => { throw error }, input => input.runAt ?? null)
    hosts.push(host)
    const request = async (botId: string, requestId: string, message: string): Promise<BotTask> => {
      const task = host.send({ botId, requestId, message })
      await vi.waitFor(() => expect(store.getTask(task.id).state).toBe("running"))
      return task
    }
    const tools = (task: BotTask) => [
      ...createBotWorkTools(task, () => host, new AbortController().signal),
      ...createBotScheduleTools(store.getBot(task.botId), task, () => host, new AbortController().signal)
    ]
    return { store, host, request, tools }
  }
  return { ...reopen(), reopen }
}

async function invoke(tools: DynamicStructuredTool[], name: string, args: object, id = name) {
  const selected = tools.find(tool => tool.name === name)
  if (!selected) throw new Error(`Missing tool ${name}`)
  return selected.invoke({ type: "tool_call", id, name, args })
}

it.each(["refused", "rewritten"] as const)("protects the %s creation title in model work lookup and recovery", async (decision) => {
  const f = fixture()
  const bot = f.store.create({ name: "Owner", instructions: "", color: "#123456", modelRef: null })
  const source = await f.request(bot.id, "source-create", "Create the report task.")
  const originalTitle = "Removed account name"
  const creation = {
    title: originalTitle, goal: "Use Removed account name in the report", requestKey: "create"
  }
  const created = await invoke(f.tools(source), "bot_work_create", creation)
  const { work, task } = JSON.parse(created.content).receipt
  f.store.transition(task.id, "running")
  f.store.beginInputPreparation(task.id)
  if (decision === "rewritten") {
    f.store.recordPreparedInput(task.id, "Use the approved public sample")
    const inFlight = await invoke(f.tools(source), "bot_work_list", {})
    expect(inFlight.status).not.toBe("error")
    expect(inFlight.content).not.toContain(originalTitle)
    f.store.settle(task.id, "completed", null, "Report prepared")
  } else {
    f.store.settle(task.id, "failed", "Input refused", undefined, undefined, false,
      { outcome: "error", code: "prompt_blocked" })
  }
  const replay = await invoke(f.tools(source), "bot_work_create", creation)
  expect(replay.content).not.toContain(originalTitle)
  expect(JSON.parse(replay.content).receipt).toMatchObject({
    work: { id: work.id, title: "原任务", goal: "" }, task: { id: task.id, workId: work.id }
  })
  const ordinary = await f.host.createWork({
    botId: bot.id, operationId: "public", title: "Public report", goal: "Use public inputs"
  })
  await f.host.stop()

  const reopened = f.reopen()
  const lookup = await reopened.request(bot.id, "lookup", "Find the report and confirm its original receipt.")
  const list = async (args: object) => {
    const result = await invoke(reopened.tools(lookup), "bot_work_list", args, JSON.stringify(args))
    expect(result.status).not.toBe("error")
    return JSON.parse(result.content).receipt
  }
  const directory = await list({})
  expect(directory.items).toEqual(expect.arrayContaining([
    expect.objectContaining({ id: work.id, title: "原任务" }),
    expect.objectContaining({ id: ordinary.work.id, title: "Public report" })
  ]))
  expect(directory.priority).toEqual(expect.arrayContaining([expect.objectContaining({ id: work.id, title: "原任务" })]))
  expect(await list({ query: originalTitle })).toMatchObject({ items: [], priority: [] })
  expect((await list({ query: "Public report" })).items).toMatchObject([{ id: ordinary.work.id }])
  const recovered = await list({ priorOperation: { kind: "work_create", targetId: work.id } })
  expect(recovered.items).toMatchObject([{ workId: work.id, title: "原任务", executionId: task.id }])
  const change = async (name: string, requestKey = name, args: object = {}) => {
    const result = await invoke(reopened.tools(lookup), name, {
      workId: work.id, expectedVersion: reopened.host.getWork(bot.id, work.id).version, requestKey, ...args
    }, requestKey)
    expect(result.status).not.toBe("error")
    expect(result.content).not.toContain(originalTitle)
    return JSON.parse(result.content).receipt
  }
  expect(await change("bot_work_stop", "pause-review", { scope: "review" })).toMatchObject({
    id: work.id, title: "原任务", scope: "review"
  })
  expect(await change("bot_work_stop")).toMatchObject({ id: work.id, title: "原任务", stopRequested: true })
  expect(await change("bot_work_continue")).toMatchObject({ id: work.id, title: "原任务", goal: "", state: "active" })
  expect(await change("bot_work_complete")).toMatchObject({ id: work.id, title: "原任务", goal: "", state: "completed" })
  expect(reopened.host.listWorks(bot.id, undefined, originalTitle).items).toMatchObject([
    { id: work.id, title: originalTitle }
  ])
  expect(reopened.store.getTask(task.id).message).toContain(originalTitle)
})

it("finds a previously accepted work revision after restart, without requeueing a cancelled execution", async () => {
  const f = fixture()
  const bot = f.store.create({ name: "Owner", instructions: "", color: "#123456", modelRef: null })
  const { work, task } = f.store.createWork({
    botId: bot.id, operationId: "work", title: "Report", goal: "Prepare report"
  })
  f.store.transition(task.id, "running")
  f.store.transition(task.id, "completed")
  const completed = f.store.changeWork(bot.id, work.id, f.store.getWork(bot.id, work.id).version, "complete", "complete")
  const source = await f.request(bot.id, "source-revision", "Add the extra line.")
  const args = { requestKey: "add-line", workId: work.id, expectedVersion: completed.version, message: "Add the extra line." }
  const sent = await invoke(f.tools(source), "bot_work_send", args, "original-send")
  const originalId = JSON.parse(sent.content).receipt.id
  const replay = await invoke(f.tools(source), "bot_work_send", args, "same-turn-replay")
  expect(JSON.parse(replay.content).receipt.id).toBe(originalId)
  await f.host.stop()

  const reopened = f.reopen()
  const retry = await reopened.request(bot.id, "retry-revision", "Did my earlier revision go through?")
  const priorOperation = { kind: "work_send", targetId: work.id, sourceRequestId: "source-revision" }
  const list = await invoke(reopened.tools(retry), "bot_work_list", { priorOperation })
  const [found] = JSON.parse(list.content).receipt.items
  expect(found).toMatchObject({ kind: "work_send", targetId: work.id, sourceRequestId: "source-revision",
    executionId: originalId, executionState: "queued" })
  expect(found).not.toHaveProperty("message")
  expect(found).not.toHaveProperty("origin")
  reopened.host.cancel(originalId)
  const revision = reopened.store.revision()
  const exact = await invoke(reopened.tools(retry), "bot_work_list", {
    priorOperation: { ...priorOperation, receiptId: found.receiptId }
  }, "exact-revision")
  expect(JSON.parse(exact.content).receipt.items).toMatchObject([{ executionId: originalId, executionState: "cancelled" }])
  expect(reopened.store.revision()).toBe(revision)
  expect(reopened.store.pendingWorkFamily(bot.id, work.id)).toEqual([])
  const wrong = await invoke(reopened.tools(retry), "bot_work_list", {
    priorOperation: { ...priorOperation, sourceRequestId: "retry-revision", receiptId: found.receiptId }
  }, "wrong-source")
  expect(wrong.status).toBe("error")

  const other = reopened.store.create({ name: "Other", instructions: "", color: "#123456", modelRef: null })
  const outsider = await reopened.request(other.id, "outside", "Read that operation")
  const denied = await invoke(reopened.tools(outsider), "bot_work_list", {
    priorOperation: { ...priorOperation, receiptId: found.receiptId }
  }, "other-bot")
  expect(denied.status).toBe("error")
  reopened.host.cancel(retry.id)
  const stopped = await invoke(reopened.tools(retry), "bot_work_list", { priorOperation }, "stopped-caller")
  expect(stopped.status).toBe("error")

  const fresh = await reopened.request(bot.id, "another-revision", "Please add that line again.")
  const another = await invoke(reopened.tools(fresh), "bot_work_send", {
    requestKey: args.requestKey, workId: work.id, message: args.message
  }, "new-send")
  expect(JSON.parse(another.content).receipt.id).not.toBe(originalId)
  expect(reopened.store.pendingWorkFamily(bot.id, work.id)).toHaveLength(1)
})

it("recovers the original fixed reminder across restart and deletion while permitting an explicit new reminder", async () => {
  const f = fixture()
  const bot = f.store.create({ name: "Owner", instructions: "", color: "#123456", modelRef: null })
  const source = await f.request(bot.id, "original-reminder", "Remind me to call.")
  const args = { action: "save", kind: "fixed_reminder", name: "Call", message: "Call the report owner",
    runAt: "2099-01-01T09:00:00Z", requestKey: "remind-call" }
  const saved = await invoke(f.tools(source), "bot_schedule", args, "save-reminder")
  const originalId = JSON.parse(saved.content).id
  await f.host.stop()

  const reopened = f.reopen()
  const retry = await reopened.request(bot.id, "retry-reminder", "Check the earlier reminder.")
  const revision = reopened.store.revision()
  const discovered = await invoke(reopened.tools(retry), "bot_schedule", {
    action: "recover", priorOperation: { sourceRequestId: "original-reminder" }
  })
  const [found] = JSON.parse(discovered.content).items
  expect(found).toMatchObject({ kind: "schedule_save", targetId: originalId, enabled: true,
    nextRunAt: new Date(args.runAt).toISOString() })
  expect(found).not.toHaveProperty("message")
  expect(reopened.store.schedules()).toHaveLength(1)
  expect(reopened.store.revision()).toBe(revision)

  reopened.host.cancel(retry.id)
  const fresh = await reopened.request(bot.id, "another-reminder", "Make a new reminder to call.")
  const another = await invoke(reopened.tools(fresh), "bot_schedule", args, "new-reminder")
  expect(JSON.parse(another.content).id).not.toBe(originalId)
  expect(reopened.store.schedules()).toHaveLength(2)

  reopened.host.cancel(fresh.id)
  const remove = await reopened.request(bot.id, "remove-reminder", "Remove only the first reminder.")
  await invoke(reopened.tools(remove), "bot_schedule", { action: "remove", id: originalId }, "remove-reminder")
  const removed = await invoke(reopened.tools(remove), "bot_schedule", {
    action: "recover", id: originalId, priorOperation: { receiptId: found.receiptId }
  }, "exact-reminder")
  expect(JSON.parse(removed.content).items).toMatchObject([{ status: "removed" }])
  expect(reopened.store.schedules()).toHaveLength(1)
})

it.each([
  { kind: "fixedReminder", explicit: false },
  { kind: "workMonitor", explicit: false },
  { kind: "desktopWork", explicit: false },
  { kind: "fixedReminder", explicit: true },
  { kind: "workMonitor", explicit: true }
] as const)(
  "replays and recovers a $kind edit without rolling back later state (explicit type: $explicit)",
  async ({ kind, explicit }) => {
    const clock = vi.spyOn(Date, "now").mockReturnValue(Date.parse("2099-01-01T08:00:00Z"))
    try {
      const f = fixture()
      const bot = f.store.create({ name: "Owner", instructions: "", color: "#123456", modelRef: null })
      const { work, task } = f.store.createWork({
        botId: bot.id, operationId: "report", title: "Report", goal: "Prepare report"
      })
      f.store.transition(task.id, "running")
      f.store.transition(task.id, "completed")
      const source = await f.request(bot.id, "create-routine", "Arrange this follow-up.")
      const expiresAt = "2099-01-01T10:00:00.000Z"
      const mode = kind === "fixedReminder" ? { kind: "fixed_reminder", expiresAt }
        : kind === "workMonitor" ? { workMonitor: { workId: work.id, mode: "report", expiresAt } }
        : { workId: work.id }
      const created = await invoke(f.tools(source), "bot_schedule", {
        action: "save", name: "Report follow-up", message: "Check report", frequency: "once",
        runAt: "2099-01-01T09:00:00Z", requestKey: "create", ...mode
      }, "create")
      expect(created.status).not.toBe("error")
      const original = JSON.parse(created.content)
      f.host.cancel(source.id)

      const edit = await f.request(bot.id, "move-routine", explicit
        ? "Move the existing follow-up to 09:30 and make it expire at 10:15."
        : "Move the existing follow-up to 09:30.")
      const runAt = "2099-01-01T09:30:00.000Z"
      const newExpiry = "2099-01-01T10:15:00.000Z"
      const args = { action: "save", id: original.id, runAt, requestKey: "move",
        ...(explicit && kind === "fixedReminder" ? { kind: "fixed_reminder", expiresAt: newExpiry } : {}),
        ...(explicit && kind === "workMonitor" ? { workMonitor: { workId: work.id, mode: "report", expiresAt: newExpiry } } : {})
      }
      const save = (callId: string, fields = args) => invoke(f.tools(edit), "bot_schedule", fields, callId)
      const accepted = await save("move-first")
      expect(accepted.status).not.toBe("error")
      const edited = JSON.parse(accepted.content)
      expect(edited).toMatchObject({ id: original.id, nextRunAt: runAt, version: original.version + 1,
        sourceTaskId: original.sourceTaskId, [kind]: kind === "desktopWork" ? true : {
          ...original[kind],
          ...(kind === "workMonitor" ? { generation: original.workMonitor.generation + 1 } : {}),
          ...(explicit ? { expiresAt: newExpiry } : {})
        } })
      if (kind === "desktopWork") expect(edited.workId).toBe(work.id)

      const replay = await save("move-replay")
      expect(replay.status).not.toBe("error")
      expect(JSON.parse(replay.content)).toEqual(edited)
      expect(f.store.schedules()).toEqual([edited])
      const conflict = await save("move-changed-input", { ...args, runAt: "2099-01-01T09:45:00Z" })
      expect(conflict.status).toBe("error")
      expect(f.store.schedules()).toEqual([edited])

      clock.mockReturnValue(Date.parse(runAt))
      f.host.resume()
      await Promise.resolve()
      const [triggered] = f.store.schedules()
      expect(triggered).toMatchObject({ id: original.id, enabled: false, nextRunAt: null })
      const revision = f.store.revision()
      const afterTrigger = await save("move-after-trigger")
      expect(afterTrigger.status).not.toBe("error")
      expect(JSON.parse(afterTrigger.content)).toEqual(triggered)
      expect(f.store.schedules()).toEqual([triggered])
      expect(f.store.revision()).toBe(revision)
      if (explicit) {
        const differentExpiry = "2099-01-01T10:30:00.000Z"
        const changedExpiry = kind === "fixedReminder" ? { ...args, expiresAt: differentExpiry }
          : { ...args, workMonitor: { workId: work.id, mode: "report", expiresAt: differentExpiry } }
        const rejected = await save("move-after-trigger-with-changed-expiration", changedExpiry)
        expect(rejected.status).toBe("error")
        expect(rejected.content).toContain("工作命令标识已用于不同内容")
        expect(f.store.revision()).toBe(revision)
      }
      const later = f.host.saveSchedule(bot.id, {
        name: "Renamed in the panel", message: triggered.message, frequency: "once", runAt, enabled: false
      }, triggered)
      const afterRename = await save("move-after-later-change")
      expect(afterRename.status).not.toBe("error")
      expect(JSON.parse(afterRename.content)).toEqual(later)
      expect(f.store.schedules()).toEqual([later])
      expect(f.store.recentTasks().filter(task => task.origin.kind === "schedule")).toHaveLength(1)

      f.host.removeSchedule(later.id, later.version)
      const afterRemoval = await save("move-after-removal")
      expect(afterRemoval.status).toBe("error")
      expect(afterRemoval.content).toContain("原例行已删除")
      expect(f.store.schedules()).toEqual([])
      if (explicit) {
        f.host.cancel(edit.id)
        const stopped = await save("move-after-source-stopped")
        expect(stopped.status).toBe("error")
        expect(stopped.content).toContain("当前执行已停止")
      }
      await f.host.stop()

      const reopened = f.reopen()
      const query = await reopened.request(bot.id, "recover-move", "Did the reschedule go through?")
      const recovered = await invoke(reopened.tools(query), "bot_schedule", {
        action: "recover", id: original.id, priorOperation: { sourceRequestId: "move-routine" }
      }, "recover-move")
      expect(recovered.status).not.toBe("error")
      expect(JSON.parse(recovered.content).items).toMatchObject([
        { kind: "schedule_save", targetId: original.id, sourceRequestId: "move-routine", status: "removed" }
      ])
      expect(reopened.store.schedules()).toEqual([])
    } finally {
      clock.mockRestore()
    }
  }
)

it("keeps ordinary routine edits on their original path when a request key is supplied", async () => {
  const f = fixture()
  const bot = f.store.create({ name: "Owner", instructions: "", color: "#123456", modelRef: null })
  const schedule = f.host.saveSchedule(bot.id, {
    name: "Ordinary routine", message: "Check report", frequency: "once",
    runAt: "2099-01-01T09:00:00.000Z", enabled: true
  })
  const source = await f.request(bot.id, "edit-ordinary", "Rename the routine.")
  const save = (name: string, callId: string) => invoke(f.tools(source), "bot_schedule", {
    action: "save", id: schedule.id, name, requestKey: "legacy-key"
  }, callId)
  expect((await save("New title", "rename")).status).not.toBe("error")
  const second = await save("Another title", "rename-again")
  expect(second.status).not.toBe("error")
  expect(JSON.parse(second.content)).toMatchObject({ id: schedule.id, name: "Another title", version: schedule.version + 2 })
  const recovery = await invoke(f.tools(source), "bot_schedule", {
    action: "recover", id: schedule.id, priorOperation: { sourceRequestId: "edit-ordinary" }
  }, "recover-ordinary")
  expect(JSON.parse(recovery.content).items).toEqual([])
})

it.each(["fixedReminder", "workMonitor"] as const)("preserves the edited %s expiration when changing only the run time", async (kind) => {
  const clock = vi.spyOn(Date, "now").mockReturnValue(Date.parse("2099-01-01T08:00:00Z"))
  try {
    const f = fixture()
    const bot = f.store.create({ name: "Owner", instructions: "", color: "#123456", modelRef: null })
    const { work, task } = f.store.createWork({
      botId: bot.id, operationId: "report", title: "Report", goal: "Prepare report"
    })
    f.store.transition(task.id, "running")
    f.store.transition(task.id, "completed")
    const source = await f.request(bot.id, "follow-up", "Arrange this follow-up and set its expiration.")
    const target = (expiresAt?: string) => kind === "fixedReminder"
      ? { kind: "fixed_reminder", expiresAt }
      : { workMonitor: { workId: work.id, mode: "report", expiresAt } }
    const save = async (requestKey: string, args: object) => {
      const result = await invoke(f.tools(source), "bot_schedule", { action: "save", requestKey, ...args }, requestKey)
      expect(result.status).not.toBe("error")
      return JSON.parse(result.content)
    }
    const saved = await save("create-follow-up", {
      name: "Report follow-up", message: "Check report", frequency: "once", runAt: "2099-01-01T09:00:00Z",
      ...target("2099-01-01T10:00:00Z")
    })
    const expiresAt = "2099-01-01T10:15:00.000Z"
    const changed = await save("change-expiration", { id: saved.id, ...target(expiresAt) })
    expect(changed[kind].expiresAt).toBe(expiresAt)
    const edited = await save("change-time", { id: saved.id, runAt: "2099-01-01T09:30:00Z", ...target() })

    clock.mockReturnValue(Date.parse("2099-01-01T10:30:00Z"))
    f.host.resume()
    const [expired] = f.store.schedules()
    expect(expired).toMatchObject({ id: saved.id, enabled: false, nextRunAt: null,
      [kind]: { expiresAt, ended: "expired" } })
    expect(edited[kind].expiresAt).toBe(expiresAt)
    expect(f.store.recentTasks().filter(task => task.origin.kind === "schedule")).toEqual([])
    expect(f.store.pendingScheduledWorkPublications()).toEqual([])
  } finally {
    clock.mockRestore()
  }
})

it("uses the same read-only receipt query for an exact ordinary-thread rename", async () => {
  const conversation = { kind: "local_thread" as const, threadId: "native-thread",
    incarnation: { token: "incarnation", legacyCreatedAt: 1 } }
  const write = vi.fn(() => ({ conversation, title: "New title", updatedAt: 1, workspacePath: null }))
  const f = fixture({
    list: async () => ({ items: [], nextCursor: null, scanned: 0 }),
    read: async () => { throw new Error("unused") },
    resolve: async () => { throw new Error("unused") },
    rename: async (_input, commit) => commit(write)
  })
  const bot = f.store.create({ name: "Owner", instructions: "", color: "#123456", modelRef: null })
  const source = await f.request(bot.id, "source-rename", "Rename the original conversation.")
  await invoke(f.tools(source), "bot_thread_rename", {
    conversation, expectedTitle: "Old title", title: "New title", requestKey: "rename"
  })
  await f.host.stop()
  const reopened = f.reopen()
  const retry = await reopened.request(bot.id, "retry-rename", "Did the rename go through?")
  const result = await invoke(reopened.tools(retry), "bot_work_list", {
    priorOperation: { kind: "thread_rename", targetId: conversation.threadId, sourceRequestId: source.requestId }
  })
  expect(JSON.parse(result.content).receipt.items).toMatchObject([{ kind: "thread_rename", recordedTitle: "New title" }])
  expect(write).toHaveBeenCalledOnce()
})
