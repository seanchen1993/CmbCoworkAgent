import { DatabaseSync } from "node:sqlite"
import { afterEach, describe, expect, it } from "vitest"
import { NativeSqliteAdapter } from "../db/native-sqlite-adapter"
import { BotStore } from "./store"
import { LocalBotHost, type BotRunPort } from "./host"
import { createBotWorkTools } from "./work-tools"
import type { BotTaskOrigin } from "../../shared/bots/contracts"
import { filterTaskSubagentTools } from "../agent/runtime-tool-catalog"
import { buildBotPrompt } from "./prompt"

const hosts: LocalBotHost[] = [],
  dbs: NativeSqliteAdapter[] = []
afterEach(async () => {
  await Promise.all(hosts.splice(0).map((h) => h.stop()))
  dbs.splice(0).forEach((d) => d.close())
})
function fixture(history?: BotRunPort["workHistory"], ordinaryThreads?: BotRunPort["ordinaryThreads"]) {
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
    ordinaryThreads,
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
  it("journals an ordinary rename once and revalidates cancellation before applying a queued rename", async () => {
    const ref = { kind: "local_thread" as const, threadId: "ordinary", incarnation: { token: "original", legacyCreatedAt: 1 } }
    let writes = 0
    let applyPending: (() => unknown) | undefined
    const port: NonNullable<BotRunPort["ordinaryThreads"]> = {
      list: async () => ({ items: [], nextCursor: null, scanned: 0 }),
      read: async () => { throw new Error("unused") }, resolve: async () => { throw new Error("unused") },
      rename: async (input, commit) => commit(() => { writes++; return { conversation: ref, title: input.title, workspacePath: null, updatedAt: 1 } })
    }
    const f = fixture(undefined, port); await tick()
    const source = { taskId: f.source.id, callId: "rename-call", key: "rename-operation" }
    const input = { conversation: ref, expectedTitle: "Old", title: "New" }
    await f.host.renameOrdinaryThreadFromTool(source, input)
    await f.host.renameOrdinaryThreadFromTool({ ...source, callId: "retry-call" }, input)
    expect(writes).toBe(1)
    expect(f.store.listWorks(f.bot.id).items).toEqual([])
    await expect(f.host.renameOrdinaryThreadFromTool(source, { ...input, title: "Different" })).rejects.toThrow("不同内容")
    port.rename = (input, commit) => new Promise((resolve, reject) => {
      applyPending = () => { try { resolve(commit(() => { writes++; return { conversation: ref, title: input.title, workspacePath: null, updatedAt: 2 } })) } catch (error) { reject(error) } }
    })
    const pending = f.host.renameOrdinaryThreadFromTool({ ...source, key: "next", callId: "next" }, input)
    f.host.cancel(f.source.id); applyPending!()
    await expect(pending).rejects.toThrow("当前执行已停止")
    expect(writes).toBe(1)
  })
  it("reads ordinary conversations only from a current desktop main request, without creating work", async () => {
    let reads = 0
    const port: BotRunPort["ordinaryThreads"] = {
      list: async () => { reads++; return { items: [], nextCursor: null, scanned: 0 } },
      read: async () => { throw new Error("unused") }, resolve: async () => { throw new Error("unused") }
    }
    const f = fixture(undefined, port)
    await tick()
    await expect(f.host.ordinaryThreads(f.source.id, {})).resolves.toEqual({ items: [], nextCursor: null, scanned: 0 })
    expect(reads).toBe(1)
    expect(f.store.listWorks(f.bot.id).items).toEqual([])
    const routeTools = buildBotPrompt(f.bot, f.source, "/desktop")
      .match(/\bbot_(?:thread_link|work_send)\b/g) ?? []
    expect(routeTools).toEqual(["bot_thread_link", "bot_work_send"])
    const desktopTools = createBotWorkTools(f.source, () => f.host, new AbortController().signal)
    expect(desktopTools.map(tool => tool.name)).toEqual(expect.arrayContaining(routeTools))
    const { task } = await f.host.createWork({ botId: f.bot.id, operationId: "separate", title: "Separate", goal: "Work only" })
    await tick()
    await expect(f.host.ordinaryThreads(task.id, {})).rejects.toThrow("桌面主对话")
    expect(reads).toBe(1)
    expect(createBotWorkTools(task, () => f.host, new AbortController().signal).some(t => t.name.startsWith("bot_thread_"))).toBe(false)
    expect(buildBotPrompt(f.bot, task, "/work")).not.toContain("bot_thread_link")
    const im = { ...f.source, mockSource: {
      transport: "im", personal: true, bindingId: "im", grantVersion: 1,
      conversationId: "im-dm", audienceKey: "desktop", eventId: "im-event", messageId: "im-message",
      senderId: "owner"
    } } as const
    expect(createBotWorkTools(im, () => f.host, new AbortController().signal).some(t => t.name.startsWith("bot_thread_"))).toBe(false)
    expect(buildBotPrompt(f.bot, im, "/desktop")).not.toContain("bot_thread_link")
  })
  const desktopToolOrigins: Array<{ name: string; origin?: BotTaskOrigin; available: boolean }> = [
    { name: "user", origin: { kind: "user" }, available: true },
    { name: "introduction", origin: { kind: "introduction" }, available: true },
    { name: "routine", origin: { kind: "schedule", scheduleId: "routine" }, available: false },
    {
      name: "peer handoff",
      origin: { kind: "bot", fromBotId: "peer", rootTaskId: "root", depth: 1, expectsReply: true },
      available: false
    },
    {
      name: "command notification",
      origin: { kind: "notification", notificationKind: "command", key: "command" },
      available: false
    },
    { name: "test fixture without origin", available: false }
  ]
  it.each(desktopToolOrigins)("scopes ordinary conversation tools for $name", ({ origin, available }) => {
    const tools = createBotWorkTools(
      { id: "main", ...(origin ? { origin } : {}) },
      () => { throw new Error("Building a tool catalog must not call the host") },
      new AbortController().signal
    )
    const names = tools.map(tool => tool.name)
    const ordinary = names.filter(name =>
      name.startsWith("bot_thread_") || name === "bot_work_unlink" || name === "bot_work_delete"
    )
    expect(ordinary).toEqual(available ? [
      "bot_thread_list", "bot_thread_read", "bot_thread_rename", "bot_thread_link",
      "bot_work_unlink", "bot_thread_delete", "bot_work_delete"
    ] : [])
    const list = tools.find(tool => tool.name === "bot_work_list")!
    if (available) expect(list.schema).toHaveProperty("shape.priorOperation")
    else expect(list.schema).not.toHaveProperty("shape.priorOperation")
    expect(names).toEqual(expect.arrayContaining(["bot_work_list", "bot_work_read", "bot_work_search", "bot_work_send"]))
  })
  it("does not release ordinary history to a source cancelled while the page is loading", async () => {
    let complete!: (value: { items: []; nextCursor: null; scanned: number }) => void
    const f = fixture(undefined, {
      list: () => new Promise(resolve => { complete = resolve }),
      read: async () => { throw new Error("unused") }, resolve: async () => { throw new Error("unused") }
    })
    await tick()
    const request = f.host.ordinaryThreads(f.source.id, {})
    f.host.cancel(f.source.id)
    complete({ items: [], nextCursor: null, scanned: 0 })
    await expect(request).rejects.toThrow("当前执行已停止")
  })
  it("keeps durable work tools on the parent turn and rejects direct temporary-agent calls", async () => {
    const f = fixture()
    await tick()
    const tools = createBotWorkTools(f.source, () => f.host, new AbortController().signal)
    expect(filterTaskSubagentTools(tools)).toEqual([])
    const args: Record<string, object> = {
      bot_thread_list: {},
      bot_thread_read: { conversation: { kind: "local_thread", threadId: "ordinary", incarnation: { token: "original", legacyCreatedAt: 1 } } },
      bot_thread_rename: { requestKey: "rename", conversation: { kind: "local_thread", threadId: "ordinary", incarnation: { token: "original", legacyCreatedAt: 1 } }, expectedTitle: "Old", title: "New" },
      bot_thread_link: { requestKey: "link", conversation: { kind: "local_thread", threadId: "ordinary", incarnation: { token: "original", legacyCreatedAt: 1 } }, title: "Original", goal: "Manage original work" },
      bot_work_unlink: { requestKey: "unlink", workId: "missing", expectedVersion: 1 },
      bot_thread_delete: { requestKey: "delete", conversation: { kind: "local_thread", threadId: "ordinary", incarnation: { token: "original", legacyCreatedAt: 1 } }, expectedTitle: "Old" },
      bot_work_delete: { requestKey: "delete", workId: "missing", expectedVersion: 1 },
      bot_work_projects: { query: "Project" },
      bot_work_list: {},
      bot_work_search: { workId: "missing", query: "history" },
      bot_work_read: { workId: "missing" },
      bot_work_rename: { requestKey: "rename", workId: "missing", expectedVersion: 1, title: "Name" },
      bot_work_stop: { requestKey: "stop", workId: "missing", expectedVersion: 1 },
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
      expect(() => f.store.sendWork(command, work.work.id, "Forward", work.work.version)).toThrow(
        "不能转达"
      )
      expect(() => f.host.sendWork(command, work.work.id, "Forward", work.work.version)).toThrow(
        "当前用户明确指令"
      )
      const result = await send.invoke({
        type: "tool_call",
        id: "blocked",
        name: send.name,
        args: {
          requestKey: "blocked",
          workId: work.work.id,
          message: "Forward",
          expectedVersion: work.work.version
        }
      })
      expect((result as { status: string }).status).toBe("error")
      expect(
        f.store
          .recentTasks()
          .filter((t) => t.origin.kind === "work" && t.origin.sourceTaskId === source.id)
      ).toHaveLength(0)
    }
  )
  it("continues completed work through the real tool/Host with a single receipt and honours cancellation", async () => {
    const f = fixture()
    await tick()
    // Prepare completed history without starting a second active Host execution.
    const created = f.store.createWork({
      botId: f.bot.id,
      operationId: "completed",
      title: "Draft",
      goal: "Prepare"
    })
    f.store.transition(created.task.id, "running")
    f.store.settle(created.task.id, "completed", null, "Draft ready")
    const work = f.store.changeWork(
      f.bot.id,
      created.work.id,
      f.store.getWork(f.bot.id, created.work.id).version,
      "complete",
      "complete"
    )
    const send = createBotWorkTools(f.source, () => f.host, new AbortController().signal).find(
      (t) => t.name === "bot_work_send"
    )!
    const args = {
      requestKey: "revision",
      workId: work.id,
      message: "Correct the draft",
      expectedVersion: work.version
    }
    const invoke = (id: string) => send.invoke({ type: "tool_call", id, name: send.name, args })
    const first = (await invoke("revision")) as { content: string }
    const replay = (await invoke("lost-reply")) as { content: string }
    const task = JSON.parse(first.content).receipt
    expect(JSON.parse(replay.content).receipt.id).toBe(task.id)
    expect(task.threadId).toBe(work.threadId)
    expect(f.store.getWork(f.bot.id, work.id).state).toBe("active")
    expect(f.store.recentTasks().filter((t) => t.workId === work.id)).toHaveLength(2)
    f.host.cancel(f.source.id)
    expect(((await invoke("after-cancel")) as { status: string }).status).toBe("error")
    expect(f.store.recentTasks().filter((t) => t.workId === work.id)).toHaveLength(2)
  })
  it.each(["blocked", "interrupted"] as const)("reports the actual effect of Continue for a %s result", async (kind) => {
    const { host, store, bot, source } = fixture()
    host.cancel(source.id)
    const { work, task } = store.createWork({
      botId: bot.id, operationId: "review", title: "Report", goal: "Verify the report"
    })
    store.transition(task.id, "running")
    store.recordPreparedInput(task.id, task.message)
    expect(store.armWorkResultReview(task.id, "incarnation")).toBe(true)
    store.settle(task.id, "completed", null, "Original report")
    const reviewTasks = () => store.recentTasks().filter((entry) => entry.origin.kind === "work_result" &&
      entry.origin.workId === work.id && entry.origin.review?.phase === "review")
    store.flushReplies()
    const review = reviewTasks()[0]
    store.transition(review.id, "running")
    if (kind === "blocked") {
      expect(store.commitWorkResultReview(review.id, {
        kind, summary: "Evidence unavailable", evidenceIds: []
      }).state).toBe("publish")
      store.settle(review.id, "completed", null)
    } else store.settle(review.id, "interrupted", null)
    store.flushReplies()
    const publication = store.recentTasks().find((entry) => entry.origin.kind === "work_result" &&
      entry.origin.workId === work.id && entry.origin.review?.phase === "publish")!
    store.transition(publication.id, "running")
    expect(store.acknowledgeWorkResultPublication(publication.id)).toBe(true)
    store.settle(publication.id, "completed", null)

    const user = host.send({
      botId: bot.id, requestId: "continue-review", message: "Resume the automatic result review"
    })
    await tick()
    store.recordPreparedInput(user.id, user.message)
    const before = store.getWork(bot.id, work.id)
    expect(before).toMatchObject(kind === "blocked"
      ? { state: "active", resultConclusion: { kind } }
      : { state: "active", resultReviewState: kind })
    const tool = createBotWorkTools(user, () => host, new AbortController().signal).find(
      (tool) => tool.name === "bot_work_continue"
    )!
    const args = { requestKey: "continue-review", workId: work.id, expectedVersion: before.version }
    const invoke = (id: string, input = args) => tool.invoke({ type: "tool_call", id, name: tool.name, args: input })
    const receipt = (value: unknown) => JSON.parse(String((value as { content: unknown }).content)).receipt
    const continued = kind === "interrupted"
    const first = receipt(await invoke("continue-first"))
    expect(first).toMatchObject({ continued, id: work.id, state: "active", version: before.version + Number(continued) })
    const current = store.getWork(bot.id, work.id)
    if (continued) expect(current.resultReviewState).toBe("waiting")
    else expect(current).toMatchObject({ version: before.version, resultConclusion: { kind: "blocked" } })
    expect(reviewTasks()).toHaveLength(1)
    const renamed = store.renameDesktopWork(current, "Renamed report")
    expect(renamed.version).toBeGreaterThan(first.version)
    expect(receipt(await invoke("continue-replay"))).toEqual(first)
    const changed = await invoke("continue-changed-version", { ...args, expectedVersion: renamed.version })
    expect((changed as { status: string }).status).toBe("error")
  })
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
