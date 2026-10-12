import { afterEach, expect, it } from "vitest"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { BotStore } from "./store"
import { readBotRoutineDispatchHistory } from "./routine-dispatch-history"

const cleanup: (() => void)[] = []
afterEach(() =>
  cleanup
    .splice(0)
    .reverse()
    .forEach((fn) => fn())
)
function fixture(path = ":memory:") {
  let now = 1_700_000_000_000
  const store = new BotStore(path, () => now)
  cleanup.push(() => store.close())
  const { bot } = store.createBot({ nonce: "owner", name: "检查" })
  const routine = store.saveRoutine({
    botId: bot.id,
    name: "每分钟检查",
    prompt: "检查构建",
    timezone: "UTC",
    enabled: true,
    schedule: { kind: "interval", anchor: now + 60_000, everyMs: 60_000 }
  })
  const address = { botId: bot.id, routineId: routine.id, expectedDataEpoch: "initial" }
  return {
    store,
    bot,
    routine,
    address,
    advance: (ms: number) => {
      now += ms
    }
  }
}

it("coalesces downtime and ongoing work without duplicating execution, and exposes the exact scheduled instant", () => {
  const f = fixture()
  f.advance(3_600_000)
  const [id] = f.store.dispatchDueRoutines()
  expect(f.store.dispatchDueRoutines()).toEqual([])
  expect(readBotRoutineDispatchHistory(f.store, f.address).items).toMatchObject([
    { dueAt: f.routine.nextAt, disposition: "triggered", runId: id, status: "queued" }
  ])
  f.advance(60_000)
  expect(f.store.dispatchDueRoutines()).toEqual([])
  expect(readBotRoutineDispatchHistory(f.store, f.address).items).toMatchObject([
    { disposition: "coalesced", runId: id, status: "queued" },
    { disposition: "triggered", runId: id }
  ])
  const claim = f.store.claim("host")!
  f.store.finish(claim.lease, "failed", "真实失败结果")
  expect(
    readBotRoutineDispatchHistory(f.store, f.address).items.map((item) => item.status)
  ).toEqual(["failed", "failed"])
})

it("rolls back queue creation and schedule advance if the occurrence receipt cannot commit", () => {
  const f = fixture()
  f.advance(60_000)
  f.store.db.run(
    "CREATE TRIGGER reject_receipt BEFORE INSERT ON bot_events WHEN NEW.kind='routine.triggered' BEGIN SELECT RAISE(ABORT,'receipt-write-failed'); END"
  )
  expect(() => f.store.dispatchDueRoutines()).toThrow("receipt-write-failed")
  expect(f.store.routines(f.bot.id)[0].nextAt).toBe(f.routine.nextAt)
  expect(f.store.claim("host")).toBeNull()
  expect(readBotRoutineDispatchHistory(f.store, f.address).items).toEqual([])
  f.store.db.run("DROP TRIGGER reject_receipt")
  expect(f.store.dispatchDueRoutines()).toHaveLength(1)
  expect(readBotRoutineDispatchHistory(f.store, f.address).items).toHaveLength(1)
})

it("keeps an interrupted external action inspectable across restart and never replays it as a new scheduled run", () => {
  const root = mkdtempSync(join(tmpdir(), "bot-routine-dispatch-"))
  cleanup.push(() => rmSync(root, { recursive: true, force: true }))
  const path = join(root, "bots.sqlite"),
    f = fixture(path)
  f.advance(60_000)
  const [id] = f.store.dispatchDueRoutines()
  const claim = f.store.claim("old-host")!
  const action = { operation: "external-write" }
  const approval = f.store.requestInteraction(claim.lease, {
    kind: "approval",
    prompt: "执行这次操作",
    action
  })
  f.store.answerInteraction({ id: approval.id, revision: approval.revision, answer: "approve" })
  f.store.beginEffect(claim.lease, { id: "write", action, approvalId: approval.id })
  f.store.close()
  const reopened = new BotStore(path, () => f.store.now() + 60_000)
  cleanup.push(() => reopened.close())
  reopened.recoverAbandonedAtStartup()
  expect(readBotRoutineDispatchHistory(reopened, f.address).items[0]).toMatchObject({
    runId: id,
    status: "needs_review"
  })
  expect(reopened.dispatchDueRoutines()).toEqual([])
  expect(reopened.claim("new-host")).toBeNull()
  expect(readBotRoutineDispatchHistory(reopened, f.address).items[0]).toMatchObject({
    disposition: "coalesced",
    runId: id,
    status: "needs_review"
  })
})

it("paginates stable receipts and rejects foreign Bot, cursor and restored-workspace reads", () => {
  const f = fixture()
  for (let i = 0; i < 7; i++) {
    f.advance(60_000)
    f.store.dispatchDueRoutines()
    const claim = f.store.claim("host")!
    f.store.finish(claim.lease, "succeeded", "已检查")
  }
  const page = readBotRoutineDispatchHistory(f.store, { ...f.address, limit: 3 })
  const second = readBotRoutineDispatchHistory(f.store, {
    ...f.address,
    limit: 3,
    before: page.next
  })
  expect(new Set([...page.items, ...second.items].map((row) => row.cursor)).size).toBe(6)
  const other = f.store.createBot({ nonce: "other", name: "Other" })
  expect(() =>
    readBotRoutineDispatchHistory(f.store, { ...f.address, botId: other.bot.id })
  ).toThrow("不属于")
  expect(() => readBotRoutineDispatchHistory(f.store, { ...f.address, before: 1 })).toThrow("游标")
  expect(() =>
    readBotRoutineDispatchHistory(f.store, { ...f.address, expectedDataEpoch: "old-workspace" })
  ).toThrow("恢复")
  expect(() => readBotRoutineDispatchHistory(f.store, { ...f.address, limit: 51 })).toThrow()
})
