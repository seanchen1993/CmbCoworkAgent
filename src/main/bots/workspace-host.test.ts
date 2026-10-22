import { DatabaseSync } from "node:sqlite"
import { afterEach, describe, expect, it, vi } from "vitest"
import { NativeSqliteAdapter } from "../db/native-sqlite-adapter"
import { BotStore } from "./store"
import { LocalBotHost } from "./host"
import type { BotWorkWorkspace } from "../../shared/bots/work"

const hosts: LocalBotHost[] = [],
  dbs: NativeSqliteAdapter[] = []
afterEach(async () => {
  await Promise.all(hosts.splice(0).map((h) => h.stop()))
  dbs.splice(0).forEach((db) => db.close())
})
function fixture(running = false) {
  const db = new NativeSqliteAdapter(new DatabaseSync(":memory:"))
  dbs.push(db)
  const store = new BotStore(db)
  const bot = store.create({ name: "Bot", instructions: "", color: "#123456", modelRef: null })
  const workspaces = {
    resolve: vi.fn(async (): Promise<BotWorkWorkspace> => ({ kind: "default", path: "/default" })),
    projects: vi.fn(async () => ({ items: [], nextCursor: null }))
  }
  const host = new LocalBotHost(store, {
    workspaces,
    onAvailable: () => () => {},
    acquire: () =>
      running
        ? {
            release() {},
            execute: (signal) =>
              new Promise((resolve) => {
                signal.addEventListener("abort", () => resolve({ state: "completed" }), {
                  once: true
                })
              })
          }
        : null
  })
  hosts.push(host)
  const input = { botId: bot.id, operationId: "op", title: "周日计划", goal: "安排周日读书会" }
  return { db, store, bot, workspaces, host, input }
}
const tick = () => new Promise((resolve) => setTimeout(resolve, 20))
describe("fixed work workspace lifecycle", () => {
  it("pins the default once, preserves it through restart and completion/continuation, and replays without IO", async () => {
    const f = fixture()
    const receipt = await f.host.createWork(f.input)
    expect(receipt.work.workspace).toEqual({ kind: "default", path: "/default" })
    expect(f.store.listWorks(f.bot.id).items[0].workspace).toEqual(receipt.work.workspace)
    expect(f.store.workSummaries(f.bot.id, [receipt.work.id])[0].workspace).toEqual(
      receipt.work.workspace
    )
    f.store.transition(receipt.task.id, "running")
    f.store.settle(receipt.task.id, "completed", null, "计划")
    const completed = f.store.changeWork(
      f.bot.id,
      receipt.work.id,
      f.store.getWork(f.bot.id, receipt.work.id).version,
      "done",
      "complete"
    )
    f.store.changeWork(f.bot.id, receipt.work.id, completed.version, "resume", "continue")
    f.workspaces.resolve.mockRejectedValue(new Error("default changed or removed"))
    expect((await f.host.createWork(f.input)).work.id).toBe(receipt.work.id)
    expect(f.workspaces.resolve).toHaveBeenCalledTimes(1)
    const reloaded = new BotStore(f.db).getWork(f.bot.id, receipt.work.id)
    expect(reloaded.workspace).toEqual(receipt.work.workspace)
    expect(reloaded.threadId).toBe(receipt.work.threadId)
    expect(reloaded.state).toBe("active")
  })
  it("deduplicates simultaneous creates and rejects changing the requested directory on replay", async () => {
    const f = fixture()
    const input = { ...f.input, workspace: { kind: "directory" as const, path: "/project" } }
    f.workspaces.resolve.mockResolvedValue({ kind: "directory", path: "/project" })
    const [a, b] = await Promise.all([f.host.createWork(input), f.host.createWork(input)])
    expect(a.work.id).toBe(b.work.id)
    expect(f.store.listWorks(f.bot.id).items).toHaveLength(1)
    await expect(
      f.host.createWork({ ...input, workspace: { kind: "directory", path: "/other" } })
    ).rejects.toThrow("不同内容")
  })
  it("fails before any persistent work or execution on invalid workspace", async () => {
    const f = fixture()
    f.workspaces.resolve.mockRejectedValue(new Error("missing directory"))
    await expect(f.host.createWork(f.input)).rejects.toThrow("missing directory")
    expect(f.store.listWorks(f.bot.id).items).toEqual([])
    expect(f.store.recentTasks()).toEqual([])
  })
  it("rechecks the live source after asynchronous directory lookup", async () => {
    const f = fixture(true)
    const source = f.host.send({ botId: f.bot.id, requestId: "source", message: "在项目中写计划" })
    await tick()
    let release!: (workspace: BotWorkWorkspace) => void
    f.workspaces.resolve.mockImplementation(
      () =>
        new Promise((resolve) => {
          release = resolve
        })
    )
    const pending = f.host.createWork(f.input, { taskId: source.id, callId: "call", key: "create" })
    f.host.cancel(source.id)
    release({ kind: "directory", path: "/project" })
    await expect(pending).rejects.toThrow("已停止")
    expect(f.store.listWorks(f.bot.id).items).toEqual([])
  })
  it("rejects external project discovery and workspace selection before touching local directories", async () => {
    const f = fixture(true)
    const binding = f.store.mock.create({
      simulation: true,
      botId: f.bot.id,
      operationId: "binding",
      kind: "dm",
      channelKey: "channel",
      label: "channel",
      allowedSenderIds: ["alice"]
    })
    f.host.injectMockEvent({
      simulation: true,
      bindingId: binding.id,
      eventId: "event",
      messageId: "message",
      senderId: "alice",
      text: "在私人项目写计划",
      mentionsBotIds: []
    })
    await tick()
    const source = f.store.recentTasks().find((t) => t.mockSource)!
    await expect(f.host.workProjects(source.id, "private")).rejects.toThrow("本机主对话")
    await expect(
      f.host.createWork(
        {
          ...f.input,
          workspace: { kind: "directory", path: "/private" }
        },
        { taskId: source.id, callId: "call", key: "create" }
      )
    ).rejects.toThrow("模拟渠道")
    expect(f.workspaces.projects).not.toHaveBeenCalled()
    expect(f.workspaces.resolve).not.toHaveBeenCalled()
    const receipt = await f.host.createWork(f.input, {
      taskId: source.id,
      callId: "safe",
      key: "safe"
    })
    expect(receipt.work.workspace).toBeUndefined()
    expect(receipt.work.source?.bindingId).toBe(binding.id)
    expect(f.workspaces.resolve).not.toHaveBeenCalled()
  })
})
