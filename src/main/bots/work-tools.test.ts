import { DatabaseSync } from "node:sqlite"
import { afterEach, describe, expect, it } from "vitest"
import { NativeSqliteAdapter } from "../db/native-sqlite-adapter"
import { BotStore } from "./store"
import { LocalBotHost } from "./host"
import { createBotWorkTools } from "./work-tools"

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
