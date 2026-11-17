import { DatabaseSync } from "node:sqlite"
import { afterEach, describe, expect, it, vi } from "vitest"
import { NativeSqliteAdapter } from "../db/native-sqlite-adapter"
import { BotStore } from "./store"
import { LocalBotHost, type BotRunPort } from "./host"
import { createBotWorkTools } from "./work-tools"
import type { BotTaskOrigin } from "../../shared/bots/contracts"
import { filterTaskSubagentTools } from "../agent/runtime-tool-catalog"

const validation = vi.hoisted(() => ({ check: vi.fn(async () => null as string | null) }))
vi.mock("../agent/standard-thread-turn", () => ({ validateExplicitSkillReference: validation.check }))
import { formatSkillUseBlock } from "../agent/skill-lifecycle/marker"
const selection = formatSkillUseBlock({ name: "fixture", path: "/skills/fixture/SKILL.md" })
const hosts: LocalBotHost[] = [],
  dbs: NativeSqliteAdapter[] = []
afterEach(async () => {
  await Promise.all(hosts.splice(0).map((h) => h.stop()))
  dbs.splice(0).forEach((d) => d.close())
})
function fixture(history?: BotRunPort["workHistory"], message = "Please create a draft work") {
  validation.check.mockResolvedValue(null)
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
    workHistory: history,
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
    message
  })
  return { host, store, bot, source }
}
const tick = () => new Promise((resolve) => setTimeout(resolve, 15))
describe("work Runtime tools", () => {
  it("keeps durable work tools on the parent turn and rejects direct temporary-agent calls", async () => {
    const f = fixture()
    await tick()
    const tools = createBotWorkTools(f.source, () => f.host, new AbortController().signal)
    expect(filterTaskSubagentTools(tools)).toEqual([])
    const args: Record<string, object> = {
      bot_feature_list: {},
      bot_feature_read: { followId: "item" },
      bot_feature_update: {
        action: "follow",
        projectId: "project",
        slug: "feature",
        requestKey: "child"
      },
      bot_skill_dispatch: { title: "Draft" },
      bot_work_projects: { query: "Project" },
      bot_work_list: {},
      bot_work_search: { workId: "missing", query: "history" },
      bot_work_read: { workId: "missing" },
      bot_work_create: { requestKey: "child", title: "Child work", goal: "Persistent side effect" },
      bot_work_send: { requestKey: "child", workId: "missing", message: "side effect" },
      bot_work_complete: { requestKey: "child", workId: "missing", expectedVersion: 1 },
      bot_work_continue: { requestKey: "child", workId: "missing", expectedVersion: 1 }
    }
    for (const tool of tools) {
      const result = (await tool.invoke(
        { type: "tool_call", id: `child-${tool.name}`, name: tool.name, args: args[tool.name] },
        { configurable: { cmb_subagent_owner_tool_call_id: "temporary-task" } }
      )) as { status: string; content: string }
      expect(result.status).toBe("error")
      expect(result.content).toContain("parent Bot")
    }
    expect(f.store.listWorks(f.bot.id).items).toEqual([])
    expect(f.store.recentTasks()).toHaveLength(1)
  })
  it("dispatches a selected skill once, preserving original input for activation only in its worker", async () => {
    const f = fixture(undefined, "生成文档\n" + selection)
    await tick()
    const dispatch = createBotWorkTools(f.source, () => f.host, new AbortController().signal)
      .find(t => t.name === "bot_skill_dispatch")!
    const call = (id: string) => dispatch.invoke({ type: "tool_call", id, name: dispatch.name, args: { title: "文档" } })
    const first = JSON.parse(String((await call("first") as any).content)).receipt
    const replay = JSON.parse(String((await call("replay") as any).content)).receipt
    expect(replay.work.id).toBe(first.work.id)
    expect(first.task.origin).toMatchObject({ kind: "work", dispatch: "create" })
    expect(replay.task.origin).toEqual(first.task.origin)
    expect(f.store.listWorks(f.bot.id).items).toHaveLength(1)
    expect(f.store.workInputContext(first.task.id)?.explicitSkill).toEqual({ name: "fixture", path: "/skills/fixture/SKILL.md" })
    expect(createBotWorkTools(first.task, () => f.host, new AbortController().signal).map(t => t.name)).not.toContain("bot_skill_dispatch")
  })
  it("reuses and reopens the same work atomically, and keeps replay and audience protection", async () => {
    const f = fixture(undefined, "继续原任务\n" + selection)
    await tick()
    const existing = f.store.createWork({ botId: f.bot.id, operationId: "old", title: "旧任务", goal: "整理" })
    f.store.transition(existing.task.id, "running")
    f.store.settle(existing.task.id, "completed", null, "已回复")
    f.store.changeWork(f.bot.id, existing.work.id, f.store.getWork(f.bot.id, existing.work.id).version, "done", "complete")
    expect(() => f.host.continueSkillWork({ taskId: f.source.id, callId: "invalid", key: "invalid" }, existing.work.id, "")).toThrow()
    expect(f.store.getWork(f.bot.id, existing.work.id).state).toBe("completed")
    const dispatch = createBotWorkTools(f.source, () => f.host, new AbortController().signal)
      .find(t => t.name === "bot_skill_dispatch")!
    const call = (id: string, workId = existing.work.id) => dispatch.invoke({ type: "tool_call", id, name: dispatch.name, args: { workId, goal: "更新文档" } })
    const firstResult = await call("follow") as any
    expect(firstResult.status, String(firstResult.content)).not.toBe("error")
    const first = JSON.parse(String(firstResult.content)).receipt
    const replayResult = await call("replay") as any
    expect(replayResult.status, String(replayResult.content)).not.toBe("error")
    const replay = JSON.parse(String(replayResult.content)).receipt
    expect(first.work).toMatchObject({ id: existing.work.id, threadId: existing.work.threadId, state: "active" })
    expect(first.work.workspace).toEqual(existing.work.workspace)
    expect(replay.task.id).toBe(first.task.id)
    expect(first.task.origin).toMatchObject({ kind: "work", dispatch: "follow_up" })
    expect(replay.task.origin).toEqual(first.task.origin)
    expect(f.store.workInputContext(first.task.id)?.explicitSkill?.name).toBe("fixture")
    if (f.store.getTask(first.task.id).state === "queued") f.store.transition(first.task.id, "running")
    f.store.settle(first.task.id, "completed", null, "已回复")
    f.store.changeWork(f.bot.id, first.work.id, f.store.getWork(f.bot.id, first.work.id).version, "done-again", "complete")
    const lateReplay = JSON.parse(String((await call("late-replay") as any).content)).receipt
    expect(lateReplay.task.id).toBe(first.task.id)
    expect(f.store.getWork(f.bot.id, existing.work.id).state).toBe("completed")
    const other = f.store.create({ name: "Other", instructions: "", color: "#168bea", modelRef: null })
    const privateWork = f.store.createWork({ botId: other.id, operationId: "other", title: "Other", goal: "Private" })
    expect((await call("other", privateWork.work.id) as any).status).toBe("error")
    expect(f.store.listWorks(f.bot.id).items).toHaveLength(1)
  })
  it("rejects an invalid skill or missing selection before creating work", async () => {
    for (const message of ["普通请求", "生成文档\n" + selection]) {
      const f = fixture(undefined, message)
      validation.check.mockResolvedValue("技能已禁用")
      await tick()
      const dispatch = createBotWorkTools(f.source, () => f.host, new AbortController().signal).find(t => t.name === "bot_skill_dispatch")!
      expect((await dispatch.invoke({ type: "tool_call", id: "invalid", name: dispatch.name, args: { title: "文档" } }) as any).status).toBe("error")
      expect(f.store.listWorks(f.bot.id).items).toHaveLength(0)
    }
  })
  it("offers original inputs only to their independent assignment under its live lease", async () => {
    const f = fixture()
    await tick()
    const mainTools = createBotWorkTools(f.source, () => f.host, new AbortController().signal)
    expect(mainTools.some(t => t.name === "bot_work_input")).toBe(false)
    // A short routing note is enough; the original instruction is host supplied.
    const create = mainTools.find(t => t.name === "bot_work_create")!
    const response = await create.invoke({ type: "tool_call", id: "dispatch", name: create.name,
      args: { requestKey: "dispatch", title: "Draft" } }) as { content: string }
    const receipt = JSON.parse(response.content).receipt
    expect(receipt.task.message).toBe("Draft")
    await tick()
    const input = createBotWorkTools(receipt.task, () => f.host, new AbortController().signal)
      .find(t => t.name === "bot_work_input")!
    expect(input).toBeDefined()
    const call = { type: "tool_call" as const, id: "read-source", name: input.name, args: {} }
    const result = await input.invoke(call) as { content: string }
    expect(JSON.parse(result.content).receipt.messages[0].text).toBe(f.source.message)
    const correction = f.store.enqueue({ botId: f.bot.id, requestId: "long-correction", message: "X".repeat(5000) + "Keep originals." })
    f.store.injectIntoRun(correction.id, f.source.id)
    const follow = f.store.sendWork(
      { taskId: f.source.id, callId: "follow", key: "follow" }, receipt.work.id, "Apply correction"
    )
    const followCall = { ...call, id: "read-correction", args: { assignmentId: follow.id, messageIndex: 1, offset: 4000 } }
    expect((await input.invoke(followCall) as { status: string }).status).toBe("error")
    f.store.injectIntoRun(follow.id, receipt.task.id)
    const applied = await input.invoke(followCall) as { content: string }
    expect(JSON.parse(applied.content).receipt.messages[0].text).toBe(correction.message.slice(4000))
    const child = await input.invoke(call, { configurable: { cmb_subagent_owner_tool_call_id: "temporary" } }) as { status: string }
    expect(child.status).toBe("error")
    await f.host.stop()
    const stale = await input.invoke(call) as { status: string }
    expect(stale.status).toBe("error")
  })
  it("reads only owned tasks under the live source lease, without enqueueing work", async () => {
    let queries = 0
    const f = fixture({
      query: async (work) => {
        queries++
        return {
          work: { id: work.id, title: work.title, goal: work.goal },
          entries: [],
          nextCursor: null,
          scanned: 0,
          truncated: false,
          coverage: "exhausted"
        }
      },
      resolve: async () => {
        throw new Error("unused")
      }
    })
    await tick()
    const linked = f.store.conversations.prepare({
      botId: f.bot.id,
      operationId: "linked",
      title: "Original",
      goal: "Read only",
      conversation: {
        kind: "local_thread",
        threadId: "existing",
        incarnation: { token: "original", legacyCreatedAt: 1 }
      }
    })
    f.store.conversations.bound(f.bot.id, linked.id, linked.conversation!.ref)
    const read = createBotWorkTools(f.source, () => f.host, new AbortController().signal).find(
      (tool) => tool.name === "bot_work_read"
    )!
    const before = f.store.recentTasks().length
    const result = await read.invoke({
      type: "tool_call",
      id: "read-history",
      name: read.name,
      args: { workId: linked.id }
    })
    expect(JSON.stringify(result)).toContain("bot-work-receipt")
    expect(queries).toBe(1)
    expect(f.store.recentTasks()).toHaveLength(before)
    const stranger = f.store.create({
      name: "Other",
      instructions: "Other",
      color: "#ea2845",
      modelRef: null
    })
    const other = f.store.conversations.prepare({
      botId: stranger.id,
      operationId: "stranger",
      title: "Other",
      goal: "Private",
      conversation: {
        kind: "local_thread",
        threadId: "other",
        incarnation: { token: "other", legacyCreatedAt: 2 }
      }
    })
    await expect(f.host.workHistory(f.source.id, { workId: other.id })).rejects.toThrow()
    expect(queries).toBe(1)
    await f.host.stop()
    await expect(f.host.workHistory(f.source.id, { workId: linked.id })).rejects.toThrow()
    expect(queries).toBe(1)
  })
  it("forwards a live main user's instruction once, including a lost tool reply replay", async () => {
    const f = fixture()
    await tick()
    const work = await f.host.createWork({
      botId: f.bot.id,
      operationId: "target",
      title: "Draft",
      goal: "Prepare"
    })
    const send = createBotWorkTools(f.source, () => f.host, new AbortController().signal).find(
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
    expect(receipt(first).message).toBe(args.message)
    expect(receipt(first).origin).toMatchObject({
      dispatch: "follow_up",
      sourceTaskId: f.source.id
    })
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
      const work = await f.host.createWork({
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
      const send = createBotWorkTools(source, () => f.host, new AbortController().signal).find(
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
    const tools = createBotWorkTools(f.source, () => f.host, new AbortController().signal)
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
    expect(receipt(first).receipt.task.message).toBe(args.goal)
    expect(receipt(first).receipt.task.origin).toMatchObject({
      dispatch: "create",
      sourceTaskId: f.source.id
    })
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
    const work = await f.host.createWork({
      botId: f.bot.id,
      operationId: "new",
      title: "A",
      goal: "A"
    })
    await tick()
    const tools = createBotWorkTools(work.task, () => f.host, new AbortController().signal)
    expect(tools.map((t) => t.name)).not.toContain("bot_work_create")
    expect(tools.map((t) => t.name)).not.toContain("bot_work_projects")
    expect(tools.map((t) => t.name)).toContain("bot_work_list")
    // Even a stale/mis-scoped catalogue cannot bypass the host's live authority check.
    const create = createBotWorkTools(
      { id: work.task.id },
      () => f.host,
      new AbortController().signal
    ).find((t) => t.name === "bot_work_create")!
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
    expect(f.store.listWorks(f.bot.id).items).toHaveLength(1)
  })
})
