import { afterEach, expect, it } from "vitest"
import { BotStore } from "./store"
import { botRoutineTools } from "./routine-tools"
import type { BotRoutineHistoryRequest } from "../../shared/bot-routines"

const stores: BotStore[] = []
afterEach(() => stores.splice(0).forEach((store) => store.close()))
function fixture() {
  let now = Date.now()
  const store = new BotStore(":memory:", () => now)
  stores.push(store)
  const { bot, conversationId } = store.createBot({ nonce: "bot", name: "检查" })
  const routine = store.saveRoutine({
    botId: bot.id,
    name: "检查例程",
    prompt: "检查项目",
    timezone: "Asia/Shanghai",
    enabled: true,
    schedule: { kind: "event", topic: "changed" }
  })
  const query = { botId: bot.id, routineId: routine.id }
  return {
    store,
    bot,
    conversationId,
    routine,
    query,
    advance: () => {
      now += 60_000
    }
  }
}

it("reads actual routine results through the model tool without creating work or requiring mutation authority", async () => {
  const f = fixture()
  const completed = f.store.runRoutine({ id: f.routine.id, nonce: "complete" })
  const first = f.store.claim("host")!
  f.store.finish(first.lease, "failed", "真实失败证据")
  f.store.send({ nonce: "ask", conversationId: f.conversationId, text: "上次日检结果如何" })
  const { run, lease } = f.store.claim("host")!
  const tools = botRoutineTools(
    {
      store: f.store,
      bot: f.bot,
      run,
      lease,
      signal: new AbortController().signal,
      messages: f.store.messagesForRun(run.id)
    },
    () => f.store.assertLease(lease),
    async () => {
      throw new Error("Unexpected approval")
    }
  )
  const tool = tools.find((item) => item.name === "list_routine_runs")!
  const result = await tool.invoke({ id: f.routine.id, limit: 20 })
  expect(JSON.parse(String(result)).items).toMatchObject([
    { id: completed.id, status: "failed", summary: "真实失败证据" }
  ])
  expect(String(await tool.invoke({ id: f.routine.id, before_id: completed.id }))).toContain(
    "history_cursor"
  )
  expect(f.store.routineHistory(f.query).items).toHaveLength(1)
  f.store.finish(lease, "succeeded", "已答复")
  const root = f.store.messages(f.conversationId)[0]
  f.store.send({
    nonce: "branch",
    conversationId: f.conversationId,
    threadRootId: root.id,
    text: "查询其他历史"
  })
  const branch = f.store.claim("host")!
  const branchTools = botRoutineTools(
    {
      store: f.store,
      bot: f.bot,
      ...branch,
      signal: new AbortController().signal,
      messages: f.store.messagesForRun(branch.run.id)
    },
    () => f.store.assertLease(branch.lease),
    async () => {
      throw new Error("Unexpected approval")
    }
  )
  const hidden = await branchTools
    .find((item) => item.name === "list_routine_runs")!
    .invoke({ id: f.routine.id })
  expect(String(hidden)).toContain("history_scope")
  expect(String(hidden)).not.toContain("真实失败证据")
})

it("paginates equal-time occurrences without gaps, excludes other tasks and rejects foreign or forged cursors", () => {
  const f = fixture()
  const ids = new Set<string>()
  for (let index = 0; index < 26; index++) {
    const run = f.store.runRoutine({ id: f.routine.id, nonce: `manual-${index}` })
    ids.add(run.id)
    const claimed = f.store.claim("host")!
    f.store.finish(
      claimed.lease,
      index % 3 ? "succeeded" : "failed",
      index === 0 ? "a".repeat(5000) : `结果 ${index}`
    )
  }
  const first = f.store.routineHistory({ ...f.query, limit: 7 })
  expect(first.items).toHaveLength(7)
  expect(first.next).not.toBeNull()
  f.advance()
  const later = f.store.runRoutine({ id: f.routine.id, nonce: "newer" })
  const collected = [...first.items]
  let before = first.next
  while (before) {
    const page = f.store.routineHistory({ ...f.query, before, limit: 7 })
    collected.push(...page.items)
    before = page.next
  }
  expect(new Set(collected.map((run) => run.id))).toEqual(ids)
  expect(collected.some((run) => run.id === later.id)).toBe(false)
  expect(collected.some((run) => run.status === "failed")).toBe(true)
  expect(collected.every((run) => run.trigger === "manual" && run.resultMessageId)).toBe(true)
  expect(Math.max(...collected.map((run) => run.summary?.length ?? 0))).toBe(1200)
  const long = collected.find((run) => run.summary?.length === 1200)!
  expect(
    f.store.message({ conversationId: f.conversationId, id: long.resultMessageId! }).text
  ).toHaveLength(5000)
  const ordinary = f.store.send({
    nonce: "ordinary",
    conversationId: f.conversationId,
    text: "独立任务"
  })
  expect(() =>
    f.store.routineHistory({
      ...f.query,
      before: { id: ordinary.runIds[0], createdAt: f.store.now() }
    })
  ).toThrow("不属于")
  expect(() =>
    f.store.routineHistory({
      ...f.query,
      before: { ...first.next!, createdAt: first.next!.createdAt + 1 }
    })
  ).toThrow("历史位置")
  const other = f.store.createBot({ nonce: "other", name: "其他" }).bot
  expect(() => f.store.routineHistory({ ...f.query, botId: other.id })).toThrow("不属于")
  expect(() =>
    f.store.routineHistory({
      ...f.query,
      before: "invalid" as unknown as BotRoutineHistoryRequest["before"]
    })
  ).toThrow("对象")
  expect(() => f.store.routineHistory({ ...f.query, limit: 51 })).toThrow("历史条数")
})

it("retains exact states and event/manual/scheduled reasons, updates active history and keeps it after routine deletion", () => {
  const f = fixture()
  expect(f.store.routineHistory(f.query)).toEqual({ items: [], next: null })
  const event = f.store.emitEvent({ nonce: "event", topic: "changed", payload: "change" }).runIds[0]
  const executing = f.store.claim("host")!
  const approval = f.store.requestInteraction(executing.lease, {
    kind: "question",
    prompt: "继续？"
  })
  expect(f.store.routineHistory(f.query).items[0]).toMatchObject({
    id: event,
    trigger: "event",
    status: "waiting_input",
    resultMessageId: null
  })
  f.store.answerInteraction({ id: approval.id, revision: 1, answer: "继续" })
  f.store.finish(executing.lease, "succeeded", "事件完成")
  const changed = f.store.saveRoutine({
    ...f.routine,
    schedule: { kind: "once", at: f.store.now() + 60_000 }
  })
  f.advance()
  f.store.dispatchDueRoutines()
  const scheduled = f.store
    .routineHistory(f.query)
    .items.find((run) => run.trigger === "scheduled")!
  expect(scheduled.status).toBe("queued")
  const running = f.store.claim("host")!
  expect(
    f.store.routineHistory(f.query).items.find((run) => run.id === running.run.id)?.status
  ).toBe("running")
  f.store.finish(running.lease, "failed", "构建失败")
  const manual = f.store.runRoutine({ id: f.routine.id, nonce: "cancelled" })
  f.store.cancel(manual.id)
  const history = f.store.routineHistory(f.query)
  expect(history.items.find((run) => run.id === manual.id)?.status).toBe("cancelled")
  expect(history.items.find((run) => run.id === scheduled.id)).toMatchObject({
    status: "failed",
    summary: "构建失败"
  })
  const current = f.store.routine(f.bot.id, changed.id)
  f.store.deleteRoutine({
    nonce: "delete",
    botId: f.bot.id,
    id: current.id,
    revision: current.revision
  })
  expect(f.store.routineHistory(f.query)).toEqual(history)
})
