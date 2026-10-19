import { DatabaseSync } from "node:sqlite"
import { afterEach, describe, expect, it } from "vitest"
import { NativeSqliteAdapter } from "../db/native-sqlite-adapter"
import { BotStore } from "./store"
import { LocalBotHost } from "./host"
import { createBotWorkTools } from "./work-tools"
import type { BotTaskOrigin } from "../../shared/bots/contracts"

const hosts: LocalBotHost[] = [],
  dbs: NativeSqliteAdapter[] = []
afterEach(async () => {
  await Promise.all(hosts.splice(0).map((h) => h.stop()))
  dbs.splice(0).forEach((d) => d.close())
})
function fixture() {
  const db = new NativeSqliteAdapter(new DatabaseSync(":memory:"))
  dbs.push(db)
  const store = new BotStore(db),
    bot = store.create({
      name: "Expert",
      instructions: "Keep full beta role",
      color: "#ea2845",
      modelRef: null
    })
  const host = new LocalBotHost(store, {
    onAvailable: () => () => {},
    acquire: () => ({
      release() {},
      execute: (signal) =>
        new Promise((resolve) =>
          signal.addEventListener("abort", () => resolve({ state: "completed" }), { once: true })
        )
    })
  })
  hosts.push(host)
  const source = host.send({
    botId: bot.id,
    requestId: "source",
    message: "Please create a draft work"
  })
  return { host, store, bot, source }
}
const tick = () => new Promise((resolve) => setTimeout(resolve, 15))
describe("work Runtime tools", () => {
  it("forwards a live main user's instruction once, including a lost tool reply replay", async () => {
    const f = fixture()
    await tick()
    const work = f.host.createWork({
      botId: f.bot.id,
      operationId: "target",
      title: "Draft",
      goal: "Prepare"
    })
    const send = createBotWorkTools(f.source.id, () => f.host, new AbortController().signal).find(
      (t) => t.name === "bot_work_send"
    )!
    const args = {
      requestKey: "supplement",
      workId: work.work.id,
      message: "Apply the user's requested change"
    }
    const invoke = (id: string, input = args) =>
      send.invoke({ type: "tool_call", id, name: send.name, args: input })
    const first = await invoke("first-send"),
      replay = await invoke("lost-reply-retry")
    const receipt = (value: unknown) =>
      JSON.parse(String((value as { content: unknown }).content)).receipt
    expect(receipt(first).id).toBe(receipt(replay).id)
    expect(receipt(first).threadId).toBe(work.work.threadId)
    expect(
      f.store
        .recentTasks()
        .filter((t) => t.origin.kind === "work" && t.origin.sourceTaskId === f.source.id)
    ).toHaveLength(1)
    expect(
      ((await invoke("changed", { ...args, message: "Different" })) as { status: string }).status
    ).toBe("error")
  })
  it.each([
    { kind: "notification", notificationKind: "workflow", key: "background" },
    { kind: "schedule", scheduleId: "routine" },
    {
      kind: "bot",
      fromBotId: "peer",
      fromBotName: "Peer",
      rootTaskId: "root",
      depth: 1,
      expectsReply: false
    }
  ] satisfies BotTaskOrigin[])(
    "rejects forwarding from autonomous $kind turns before durable acceptance",
    async (origin) => {
      const f = fixture()
      await tick()
      f.host.cancel(f.source.id)
      await tick()
      const work = f.host.createWork({
        botId: f.bot.id,
        operationId: "target",
        title: "Draft",
        goal: "Prepare"
      })
      const source = f.store.enqueue(
        { botId: f.bot.id, requestId: "autonomous", message: "Forward this" },
        origin
      )
      f.host.resume()
      await tick()
      expect(f.store.getTask(source.id).state).toBe("running")
      const send = createBotWorkTools(source.id, () => f.host, new AbortController().signal).find(
        (t) => t.name === "bot_work_send"
      )!
      const command = { taskId: source.id, callId: "blocked", key: "blocked" }
      expect(() => f.store.sendWork(command, work.work.id, "Forward")).toThrow("不能转达")
      expect(() => f.host.sendWork(command, work.work.id, "Forward")).toThrow("当前用户明确指令")
      const result = await send.invoke({
        type: "tool_call",
        id: "blocked",
        name: send.name,
        args: { requestKey: "blocked", workId: work.work.id, message: "Forward" }
      })
      expect((result as { status: string }).status).toBe("error")
      expect(
        f.store
          .recentTasks()
          .filter((t) => t.origin.kind === "work" && t.origin.sourceTaskId === source.id)
      ).toHaveLength(0)
    }
  )
  it("uses a live lease plus actual call ID, deduplicates both call and request key, and keeps normal replies unconstrained", async () => {
    const f = fixture()
    await tick()
    const tools = createBotWorkTools(f.source.id, () => f.host, new AbortController().signal)
    const create = tools.find((t) => t.name === "bot_work_create")!
    const args = {
      requestKey: "draft",
      title: "Draft",
      goal: "Produce the requested draft",
      contextMessageIds: []
    }
    const invoke = (callId: string, input = args) =>
      create.invoke({ type: "tool_call", id: callId, name: create.name, args: input })
    const first = await invoke("call-first"),
      second = await invoke("call-second")
    const receipt = (value: unknown) => JSON.parse(String((value as { content: unknown }).content))
    expect(receipt(second).receipt.work.id).toBe(receipt(first).receipt.work.id)
    expect(f.store.listWorks(f.bot.id).items).toHaveLength(1)
    expect(
      ((await invoke("call-first", { ...args, goal: "Different" })) as { status: string }).status
    ).toBe("error")
    const missing = await create.invoke(args)
    expect(String(missing)).toContain("可信工具调用")
    f.host.cancel(f.source.id)
    expect(((await invoke("call-third")) as { status: string }).status).toBe("error")
    expect(f.store.listWorks(f.bot.id).items).toHaveLength(1)
  })
  it("does not permit recursive visible work creation inside a work, or completing its own running source", async () => {
    const f = fixture()
    await tick()
    f.host.cancel(f.source.id)
    await tick()
    const work = f.host.createWork({ botId: f.bot.id, operationId: "new", title: "A", goal: "A" })
    await tick()
    const tools = createBotWorkTools(work.task.id, () => f.host, new AbortController().signal)
    const create = tools.find((t) => t.name === "bot_work_create")!
    const result = await create.invoke({
      type: "tool_call",
      id: "recursive",
      name: create.name,
      args: { requestKey: "recursive", title: "B", goal: "B", contextMessageIds: [] }
    })
    expect((result as { status: string }).status).toBe("error")
    const complete = tools.find((t) => t.name === "bot_work_complete")!
    expect(
      (
        (await complete.invoke({
          type: "tool_call",
          id: "complete",
          name: complete.name,
          args: { requestKey: "complete", workId: work.work.id, expectedVersion: work.work.version }
        })) as { status: string }
      ).status
    ).toBe("error")
    expect(f.store.getWork(f.bot.id, work.work.id).state).toBe("active")
  })
})
