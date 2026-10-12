import { afterEach, expect, it } from "vitest"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { BotStore } from "./store"
import { botRoutineTools } from "./routine-tools"

const cleanup: (() => void)[] = []
afterEach(() =>
  cleanup
    .splice(0)
    .reverse()
    .forEach((close) => close())
)
function fixture(path = ":memory:") {
  const store = new BotStore(path)
  cleanup.push(() => store.close())
  const { bot, conversationId } = store.createBot({ nonce: "bot", name: "工作" })
  const routine = store.saveRoutine({
    botId: bot.id,
    name: "日检",
    prompt: "检查项目",
    timezone: "Asia/Shanghai",
    enabled: true,
    schedule: { kind: "event", topic: "project.changed" }
  })
  return { store, bot, conversationId, routine }
}

it("binds a manual run to the reviewed routine version and replays its original receipt after edits", () => {
  const { store, routine } = fixture()
  const input = { id: routine.id, nonce: "reviewed-test", revision: routine.revision }
  const accepted = store.runRoutine(input)
  store.saveRoutine({ ...routine, prompt: "A different task" })
  expect(store.runRoutine(input).id).toBe(accepted.id)
  expect(() => store.runRoutine({ ...input, nonce: "stale-test" })).toThrow("例程已修改")
  expect(store.snapshot().runs).toHaveLength(1)
  expect(
    store.messages(accepted.conversationId).find((message) => message.id === accepted.messageId)
      ?.text
  ).toBe(routine.prompt)
})

it("replays creation and edits after restart without moving schedules or restoring later deleted routines", () => {
  const root = mkdtempSync(join(tmpdir(), "cmb-routine-save-"))
  cleanup.push(() => rmSync(root, { recursive: true, force: true }))
  const path = join(root, "bots.sqlite")
  const { store, bot } = fixture(path)
  const input = {
    nonce: "create-once",
    botId: bot.id,
    name: "间隔任务",
    prompt: "检查项目",
    timezone: "UTC",
    enabled: true,
    schedule: { kind: "interval" as const, everyMs: 90_000, anchor: Date.now() + 90_000 }
  }
  const created = store.saveRoutine(input)
  expect(store.saveRoutine(input)).toEqual(created)
  const update = { ...created, nonce: "edit-once", prompt: "修改后的要求" }
  const saved = store.saveRoutine(update)
  expect(saved.nextAt).toBe(created.nextAt)
  store.close()
  const reopened = new BotStore(path)
  cleanup.push(() => reopened.close())
  expect(reopened.saveRoutine(input)).toEqual(created)
  expect(reopened.saveRoutine(update)).toEqual(saved)
  expect(() => reopened.saveRoutine({ ...update, prompt: "不同请求" })).toThrow("同一请求标识")
  expect(() => reopened.saveRoutine({ ...update, nonce: "stale" })).toThrow("已修改")
  reopened.deleteRoutine({
    nonce: "remove-saved",
    botId: bot.id,
    id: saved.id,
    revision: saved.revision
  })
  expect(reopened.saveRoutine(input)).toEqual(created)
  expect(reopened.saveRoutine(update)).toEqual(saved)
  expect(reopened.routines(bot.id).some((item) => item.id === saved.id)).toBe(false)
})

it("deletes atomically, cancels queued occurrences, preserves active work and deduplicates after restart", () => {
  const root = mkdtempSync(join(tmpdir(), "cmb-routine-delete-"))
  cleanup.push(() => rmSync(root, { recursive: true, force: true }))
  const path = join(root, "bots.sqlite")
  const { store, bot, conversationId, routine } = fixture(path)
  const first = store.emitEvent({ nonce: "first", topic: "project.changed", payload: "one" })
    .runIds[0]
  const claimed = store.claim("host")!
  const queued = store.emitEvent({ nonce: "next", topic: "project.changed", payload: "two" })
    .runIds[0]
  const manual = store.runRoutine({ id: routine.id, nonce: "manual" })
  const input = { nonce: "remove", botId: bot.id, id: routine.id, revision: routine.revision }
  const receipt = store.deleteRoutine(input)
  expect(new Set(receipt.cancelledRunIds)).toEqual(new Set([queued, manual.id]))
  expect(receipt.activeRunIds).toEqual([first])
  expect(store.getRun(first).status).toBe("running")
  expect(store.getRun(queued).status).toBe("cancelled")
  expect(store.getRun(manual.id).status).toBe("cancelled")
  expect(
    store.emitEvent({ nonce: "later", topic: "project.changed", payload: "three" }).runIds
  ).toEqual([])
  expect(store.routines(bot.id)).toEqual([])
  expect(store.deleteRoutine(input)).toEqual(receipt)
  store.finish(claimed.lease, "succeeded", "运行中的成果")
  expect(store.messages(conversationId).at(-1)?.text).toBe("运行中的成果")
  expect(() => store.runRoutine({ id: routine.id, nonce: "manual-new" })).toThrow("不存在")
  expect(store.runRoutine({ id: routine.id, nonce: "manual" }).id).toBe(manual.id)
  store.close()
  const reopened = new BotStore(path)
  cleanup.push(() => reopened.close())
  expect(reopened.deleteRoutine(input)).toEqual(receipt)
  expect(reopened.getRun(first).status).toBe("succeeded")
})

it("rejects stale and foreign removal without cancelling tasks or consuming the request nonce", () => {
  const { store, bot, routine } = fixture()
  const other = store.createBot({ nonce: "other", name: "其他" }).bot
  const pending = store.runRoutine({ id: routine.id, nonce: "manual" })
  const changed = store.saveRoutine({ ...routine, prompt: "新的检查内容" })
  const input = { nonce: "remove", botId: bot.id, id: routine.id, revision: routine.revision }
  expect(() => store.deleteRoutine(input)).toThrow("已修改")
  expect(() => store.deleteRoutine({ ...input, botId: other.id })).toThrow("不属于")
  expect(() => store.deleteRoutine({ ...input, revision: -1 })).toThrow("例程版本")
  expect(store.getRun(pending.id).status).toBe("queued")
  expect(store.routine(bot.id, routine.id).prompt).toBe(changed.prompt)
  expect(store.deleteRoutine({ ...input, revision: changed.revision }).cancelledRunIds).toEqual([
    pending.id
  ])
})

it("edits through the real tool adapter without replacing identity, losing omitted fields or moving unchanged intervals", async () => {
  const { store, bot, conversationId, routine } = fixture()
  store.send({ nonce: "request", conversationId, text: "修改日检" })
  const { run, lease } = store.claim("host")!
  const tools = botRoutineTools(
    {
      bot,
      store,
      run,
      lease,
      signal: new AbortController().signal,
      messages: store.messagesForRun(run.id)
    },
    () => store.assertLease(lease),
    async () => {
      throw new Error("not approved")
    }
  )
  const update = tools.find((tool) => tool.name === "update_routine")!
  const input = {
    id: "update-one",
    type: "tool_call" as const,
    name: update.name,
    args: { id: routine.id, revision: routine.revision, prompt: "精简检查内容", enabled: false }
  }
  await update.invoke(input)
  const saved = store.routine(bot.id, routine.id)
  expect(saved).toMatchObject({
    id: routine.id,
    revision: routine.revision + 1,
    name: routine.name,
    timezone: routine.timezone,
    schedule: routine.schedule,
    prompt: "精简检查内容",
    enabled: false
  })
  await update.invoke(input)
  expect(store.routines(bot.id)).toEqual([saved])
  const conflict = await update.invoke({
    ...input,
    id: "second-call",
    args: { ...input.args, prompt: "stale overwrite" }
  })
  expect(String(conflict.content)).toContain("revision_conflict")
  expect(store.routine(bot.id, routine.id).prompt).toBe("精简检查内容")
})
