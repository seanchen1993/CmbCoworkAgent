import { DatabaseSync } from "node:sqlite"
import { afterEach, describe, expect, it } from "vitest"
import { NativeSqliteAdapter } from "../db/native-sqlite-adapter"
import { BotStore } from "./store"

const databases: NativeSqliteAdapter[] = []
afterEach(() => databases.splice(0).forEach((db) => db.close()))
function fixture() {
  const db = new NativeSqliteAdapter(new DatabaseSync(":memory:"))
  databases.push(db)
  const store = new BotStore(db, () => 1000)
  const bot = store.create({ name: "A", instructions: "", color: "#ea2845", modelRef: null })
  const peer = store.create({ name: "B", instructions: "", color: "#ea2845", modelRef: null })
  return { store, bot, peer }
}

describe("Bot stopped task context", () => {
  it("provides actual stopped receipts, excluding other Bots, group work and unfinished tasks", () => {
    const { store, bot, peer } = fixture()
    const stopped = store.enqueue({ botId: bot.id, requestId: "stopped", message: "Prior work" })
    store.transition(stopped.id, "cancelled")
    const interrupted = store.enqueue(
      { botId: bot.id, requestId: "interrupted", message: "Original workflow result" },
      { kind: "notification", notificationKind: "workflow", key: "wf_old", runStartedAt: "old" }
    )
    store.transition(interrupted.id, "running")
    store.transition(interrupted.id, "interrupted")
    for (const [requestId, botId, origin] of [
      ["foreign", peer.id, undefined],
      ["group", bot.id, { kind: "group" as const, groupId: "g", messageId: "m" }]
    ] as const) {
      const task = store.enqueue({ botId, requestId, message: "PRIVATE_OR_GROUP" }, origin)
      store.transition(task.id, "cancelled")
    }
    const completed = store.enqueue({ botId: bot.id, requestId: "done", message: "Finished work" })
    store.transition(completed.id, "running")
    store.transition(completed.id, "completed")
    const active = store.enqueue({ botId: bot.id, requestId: "active", message: "Active work" })
    store.transition(active.id, "running")
    store.enqueue({ botId: bot.id, requestId: "queued", message: "Pending work" })
    const current = store.enqueue({ botId: bot.id, requestId: "new", message: "New assignment" })
    expect(store.stoppedTaskContext(current.id)).toEqual([
      {
        taskId: interrupted.id,
        state: "interrupted",
        source: "notification",
        reference: { kind: "workflow", key: "wf_old", runStartedAt: "old" },
        messagePreview: "Original workflow result"
      },
      { taskId: stopped.id, state: "cancelled", source: "user", messagePreview: "Prior work" }
    ])
    expect(store.stoppedTaskContext(interrupted.id)).toEqual([])
    expect(() => store.stoppedTaskContext("missing")).toThrow()
  })
  it("bounds receipt count and previews, including tied timestamps, without changing control state", () => {
    const { store, bot } = fixture()
    const ids: string[] = []
    for (let i = 0; i < 8; i++) {
      const t = store.enqueue({ botId: bot.id, requestId: `old-${i}`, message: "界".repeat(1000) })
      store.transition(t.id, "cancelled")
      ids.push(t.id)
    }
    const current = store.enqueue({ botId: bot.id, requestId: "current", message: "New work" })
    const before = { tasks: store.recentTasks(), revision: store.revision() }
    const result = store.stoppedTaskContext(current.id)
    expect(result.map((row) => "taskId" in row && row.taskId)).toEqual(ids.slice(-4).reverse())
    expect(
      result.every((row) => "messagePreview" in row && row.messagePreview === "界".repeat(240))
    ).toBe(true)
    expect({ tasks: store.recentTasks(), revision: store.revision() }).toEqual(before)
  })
  it("keeps stopped group work in scope after rejoining, excluding private, other rooms and members", () => {
    const { store, bot, peer } = fixture()
    const group = store.saveGroup({ name: "Group", memberIds: [bot.id, peer.id] })
    const stopped = store.enqueue(
      { botId: bot.id, requestId: "stopped-group", message: "Run once" },
      { kind: "group", groupId: group.id, messageId: "original" }
    )
    store.transition(stopped.id, "running")
    store.transition(stopped.id, "cancelled")
    const removed = store.saveGroup({ ...group, memberIds: [peer.id] }, group)
    store.saveGroup({ ...group, memberIds: [bot.id, peer.id] }, removed)
    for (const [requestId, botId, origin] of [
      ["private", bot.id, undefined],
      ["other-room", bot.id, { kind: "group" as const, groupId: "other", messageId: "other" }],
      ["other-member", peer.id, { kind: "group" as const, groupId: group.id, messageId: "peer" }]
    ] as const) {
      const task = store.enqueue({ botId, requestId, message: "OUT_OF_SCOPE" }, origin)
      store.transition(task.id, "cancelled")
    }
    store.sendGroup({
      groupId: group.id,
      requestId: "new-question",
      text: "Only ask a new question",
      targetBotIds: [bot.id]
    })
    const current = store
      .recentTasks()
      .find((task) => task.origin.kind === "group" && task.origin.messageId === "new-question")!
    const internal = store.enqueue(
      { botId: bot.id, requestId: "peer-task", message: "Internal work" },
      {
        kind: "bot",
        groupId: group.id,
        fromBotId: peer.id,
        rootTaskId: current.id,
        depth: 1,
        expectsReply: true
      }
    )
    const before = { tasks: store.recentTasks(), revision: store.revision() }
    expect(current.threadId).toBe(stopped.threadId)
    expect(store.stoppedTaskContext(current.id)).toEqual([
      { taskId: stopped.id, state: "cancelled", source: "group", messagePreview: "Run once" }
    ])
    expect(store.stoppedTaskContext(internal.id)).toEqual([])
    expect({ tasks: store.recentTasks(), revision: store.revision() }).toEqual(before)
  })
  it.each([false, true])(
    "reports a first cancelled background command without rewriting its failed %s group root",
    (inGroup) => {
      const { store, bot, peer } = fixture()
      const group = store.saveGroup({ name: "Group", memberIds: [bot.id, peer.id] })
      const origin = inGroup
        ? { kind: "group" as const, groupId: group.id, messageId: "original" }
        : undefined
      const source = store.enqueue(
        { botId: bot.id, requestId: "background-source", message: "Run once" },
        origin
      )
      store.transition(source.id, "running")
      const command = {
        id: "background",
        threadId: source.threadId,
        command: "node once.js",
        cwd: "/synthetic",
        startedAt: 1000
      }
      const result = {
        id: command.id,
        threadId: command.threadId,
        output: "Stopped",
        exitCode: null,
        truncated: false,
        cancelled: true
      }
      store.acceptCommand(source.id, command)
      for (const id of ["accepted", "completed", "unknown", "not-suppressed"]) {
        store.acceptCommand(source.id, { ...command, id })
      }
      store.settleCommand({ ...result, id: "not-suppressed" })
      store.transition(source.id, "failed", "Formal delivery failed")
      store.suppressCommands(source.threadId)
      store.settleCommand(result)
      store.settleCommand({ ...result, id: "completed", cancelled: false, exitCode: 0 })
      store.settleCommand({ ...result, id: "unknown", cancelled: false }, true)
      const current = store.enqueue(
        { botId: bot.id, requestId: "fresh", message: "Only ask a question" },
        origin
      )
      const before = { tasks: store.recentTasks(), revision: store.revision() }
      expect(
        before.tasks.every((task) => task.state !== "cancelled" && task.state !== "interrupted")
      ).toBe(true)
      expect(store.stoppedTaskContext(current.id)).toEqual([
        {
          commandId: command.id,
          state: "cancelled",
          source: "background_command",
          sourceTaskId: source.id,
          commandPreview: command.command
        }
      ])
      expect(store.getTask(source.id)).toMatchObject({
        state: "failed",
        error: "Formal delivery failed"
      })
      expect({ tasks: store.recentTasks(), revision: store.revision() }).toEqual(before)
      const otherRoom = store.enqueue(
        { botId: bot.id, requestId: "other-room", message: "New question" },
        { kind: "group", groupId: "other", messageId: "other" }
      )
      const otherScope = store.enqueue(
        { botId: bot.id, requestId: "other-scope", message: "New question" },
        inGroup ? undefined : { kind: "group", groupId: group.id, messageId: "group" }
      )
      const otherMember = store.enqueue(
        { botId: peer.id, requestId: "other-member", message: "New question" },
        origin
      )
      const internal = store.enqueue(
        { botId: bot.id, requestId: "internal", message: "Peer work" },
        {
          kind: "bot",
          ...(inGroup ? { groupId: group.id } : {}),
          fromBotId: peer.id,
          rootTaskId: source.id,
          depth: 1,
          expectsReply: true
        }
      )
      for (const task of [otherRoom, otherScope, otherMember, internal])
        expect(store.stoppedTaskContext(task.id)).toEqual([])
    }
  )
})
