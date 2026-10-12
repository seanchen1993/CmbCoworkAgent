import { afterEach, expect, it, vi } from "vitest"
import { mkdtempSync, copyFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { BotStore } from "./store"
import { botRoutineTools } from "./routine-tools"
import { BotDeletionLedger } from "./deletion-ledger"
import { fenceBotCheckpointDatabase } from "./checkpoint-data"
import { BOT_ROUTINE_OUTCOME_EVENT, routineOutcomesForMessages } from "./routine-outcomes"

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
  const owner = store.createBot({ nonce: "bot", name: "Owner" })
  const sent = store.send({
    nonce: "request",
    conversationId: owner.conversationId,
    text: "创建日报"
  })
  const claim = store.claim("host")!
  const definition = {
    botId: owner.bot.id,
    name: "日报",
    prompt: "PRIVATE_ROUTINE_PROMPT_NOT_DISPLAY_METADATA",
    enabled: true,
    timezone: "UTC",
    schedule: { kind: "event" as const, topic: "report.ready" }
  }
  return { store, ...owner, sent, ...claim, definition }
}
const createInput = { tool: "create_routine", name: "日报", topic: "report.ready" }
const outcomes = (f: ReturnType<typeof fixture>) =>
  f.store.messages(f.conversationId).filter((message) => message.routineOutcome)

it("the real tool commits a durable outcome, continues the same run, and leaves final delivery intact", async () => {
  const f = fixture()
  const tools = botRoutineTools(
    {
      store: f.store,
      bot: f.bot,
      run: f.run,
      lease: f.lease,
      signal: new AbortController().signal,
      messages: f.store.messagesForRun(f.run.id)
    },
    () => f.store.assertLease(f.lease),
    async () => {
      throw new Error("not approved")
    }
  )
  const create = tools.find((tool) => tool.name === "create_routine")!
  const call = {
    type: "tool_call" as const,
    id: "save",
    name: create.name,
    args: {
      name: f.definition.name,
      prompt: f.definition.prompt,
      topic: "report.ready",
      timezone: "UTC"
    }
  }
  await create.invoke(call)
  const saved = f.store.routines(f.bot.id)[0]
  const [message] = outcomes(f)
  expect(message).toMatchObject({
    sender: "system",
    runId: f.run.id,
    replyTo: f.sent.messageId,
    routineOutcome: {
      version: 1,
      operation: "create",
      id: saved.id,
      botId: f.bot.id,
      name: saved.name,
      revision: saved.revision,
      dataEpoch: "initial"
    }
  })
  expect(JSON.stringify(message.routineOutcome)).not.toContain(f.definition.prompt)
  expect(JSON.stringify(message.routineOutcome)).not.toContain("receiptNonce")
  f.store.streamOutput(f.lease, "继续核对")
  await create.invoke(call)
  expect(outcomes(f)).toHaveLength(1)
  expect(f.store.getRun(f.run.id)).toMatchObject({ status: "running", output: "继续核对" })
  f.store.finish(f.lease, "succeeded", "完整答复仍保留")
  expect(f.store.messages(f.conversationId).at(-1)?.text).toBe("完整答复仍保留")
  expect(f.store.messages(f.conversationId).at(-1)?.routineOutcome).toBeUndefined()
  expect(f.store.db.exec("SELECT count(*) FROM bot_runs")[0].values[0][0]).toBe(1)
})

it("freezes actual update identity and never substitutes a later saved revision for the receipt", () => {
  const f = fixture()
  const saved = f.store.saveRoutineFromTool(f.lease, "create", createInput, f.definition)
  const input = { tool: "update_routine", id: saved.id, revision: saved.revision, name: "精简日报" }
  const updated = f.store.saveRoutineFromTool(f.lease, "update", input, {
    ...saved,
    name: input.name
  })
  expect(outcomes(f).map((message) => message.routineOutcome)).toMatchObject([
    { operation: "create", id: saved.id, revision: 1, name: "日报" },
    { operation: "update", id: saved.id, revision: 2, name: "精简日报" }
  ])
  expect(f.store.saveRoutineFromTool(f.lease, "update", input, null)).toEqual(updated)
  expect(() =>
    f.store.saveRoutineFromTool(f.lease, "update", { ...input, name: "changed" }, null)
  ).toThrow("同一请求标识")
  expect(outcomes(f)).toHaveLength(2)
  f.store.deleteRoutine({
    nonce: "delete",
    botId: f.bot.id,
    id: updated.id,
    revision: updated.revision
  })
  expect(outcomes(f)).toHaveLength(2)
  expect(f.store.saveRoutineFromTool(f.lease, "update", input, null)).toEqual(updated)
  expect(f.store.routines(f.bot.id)).toEqual([])
})

it("confirmation SQL failure rolls back the mutation, message, event and original tool receipt", () => {
  const f = fixture()
  const beforeMessages = f.store.messages(f.conversationId)
  f.store.db.run(`CREATE TEMP TRIGGER reject_confirmation BEFORE INSERT ON bot_events
    WHEN NEW.kind='${BOT_ROUTINE_OUTCOME_EVENT}' BEGIN SELECT RAISE(ABORT,'confirmation rejected'); END`)
  expect(() => f.store.saveRoutineFromTool(f.lease, "rollback", createInput, f.definition)).toThrow(
    "confirmation rejected"
  )
  expect(f.store.routines(f.bot.id)).toEqual([])
  expect(f.store.messages(f.conversationId)).toEqual(beforeMessages)
  expect(f.store.hasToolResult(f.lease, "rollback")).toBe(false)
  expect(f.store.db.exec("SELECT count(*) FROM bot_routine_authority")[0].values[0][0]).toBe(0)
  f.store.db.run("DROP TRIGGER reject_confirmation")
  f.store.saveRoutineFromTool(f.lease, "rollback", createInput, f.definition)
  expect(outcomes(f)).toHaveLength(1)
})

it("keeps approval denial and stale version failures from publishing success", async () => {
  const f = fixture()
  const saved = f.store.saveRoutine(f.definition)
  expect(() =>
    f.store.saveRoutineFromTool(
      f.lease,
      "stale",
      { tool: "update_routine", id: saved.id },
      { ...saved, revision: saved.revision + 1 }
    )
  ).toThrow("已修改")
  f.store.autoReview.change({
    ...f.store.autoReview.read(f.bot.id),
    isEnabled: true,
    nonce: "review-on"
  })
  const tools = botRoutineTools(
    {
      store: f.store,
      bot: f.bot,
      run: f.run,
      lease: f.lease,
      signal: new AbortController().signal,
      messages: f.store.messagesForRun(f.run.id)
    },
    () => f.store.assertLease(f.lease),
    async () => "rejected",
    async () => "rejected"
  )
  await tools
    .find((tool) => tool.name === "update_routine")!
    .invoke({
      type: "tool_call",
      id: "denied",
      name: "update_routine",
      args: { id: saved.id, revision: saved.revision, name: "未批准" }
    })
  expect(outcomes(f)).toEqual([])
  expect(f.store.routine(f.bot.id, saved.id).name).toBe(saved.name)
  expect(f.store.hasToolResult(f.lease, "denied")).toBe(false)
})

it("replays legacy receipts without inventing new confirmations and fences a cancelled lease", () => {
  const f = fixture()
  const old = f.store.toolOnce(f.lease, "legacy", createInput, () =>
    f.store.saveRoutine(f.definition, { kind: "task", lease: f.lease })
  )
  expect(f.store.saveRoutineFromTool(f.lease, "legacy", createInput, null)).toEqual(old)
  expect(outcomes(f)).toEqual([])
  f.store.cancel(f.run.id)
  expect(() => f.store.saveRoutineFromTool(f.lease, "late", createInput, f.definition)).toThrow()
  expect(outcomes(f)).toEqual([])
})

it("binds the status message to the original discussion branch, not the unbranched transcript", () => {
  const f = fixture()
  f.store.finish(f.lease, "succeeded", "起点")
  const sent = f.store.send({
    nonce: "branch",
    conversationId: f.conversationId,
    threadRootId: f.sent.messageId,
    text: "分支创建"
  })
  const { run, lease } = f.store.claim("host")!
  expect(run.id).toBe(sent.runIds[0])
  f.store.saveRoutineFromTool(lease, "branch-save", createInput, f.definition)
  const messages = f.store.messages(f.conversationId, undefined, 100, undefined, f.sent.messageId)
  const message = messages.find((item) => item.routineOutcome)!
  expect(message).toMatchObject({ threadRootId: f.sent.messageId, runId: run.id })
  expect(outcomes(f)).toEqual([])
  f.store.db.run("UPDATE bot_message_threads SET root_id=? WHERE message_id=?", [
    f.sent.messageId,
    run.messageId
  ])
  const wrongRows = [
    {
      id: message.id,
      sender: "system",
      run_id: run.id,
      bot_id: f.bot.id,
      conversation_id: f.conversationId,
      reply_to: run.messageId,
      thread_root: null
    }
  ]
  expect(routineOutcomesForMessages(f.store, wrongRows).size).toBe(0)
})

it("uses one bounded page query and rejects metadata without its exact successful save receipt", () => {
  const f = fixture()
  f.store.saveRoutineFromTool(f.lease, "proof", createInput, f.definition)
  const [message] = outcomes(f)
  const rows = [
    {
      id: message.id,
      sender: "system",
      run_id: f.run.id,
      bot_id: f.bot.id,
      conversation_id: f.conversationId,
      reply_to: f.run.messageId,
      thread_root: null
    }
  ]
  const prepare = vi.spyOn(f.store.db, "prepare")
  expect(routineOutcomesForMessages(f.store, rows).size).toBe(1)
  expect(prepare).toHaveBeenCalledTimes(1)
  prepare.mockRestore()
  f.store.db.run("DELETE FROM bot_receipts WHERE nonce=?", [`tool:${f.run.id}:proof`])
  expect(outcomes(f)).toEqual([])
  expect(f.store.message({ conversationId: f.conversationId, id: message.id }).text).toContain(
    "已创建"
  )
  expect(() =>
    routineOutcomesForMessages(
      f.store,
      Array.from({ length: 201 }, () => rows[0])
    )
  ).toThrow("分页")
})

it.each([
  "x".repeat(100_000),
  { untrusted: "x".repeat(100_000) },
  "9007199254740992",
  9007199254740992
])("does not return an oversized or noninteger revision from a damaged receipt", (revision) => {
  const f = fixture()
  const saved = f.store.saveRoutineFromTool(f.lease, "bounded", createInput, f.definition)
  f.store.db.run("UPDATE bot_receipts SET response=? WHERE nonce=?", [
    JSON.stringify({ ...saved, revision }),
    `tool:${f.run.id}:bounded`
  ])
  expect(outcomes(f)).toEqual([])
})

it("reopen/restore retain historical outcomes with the original epoch and clone never copies them", () => {
  const directory = mkdtempSync(join(tmpdir(), "cmb-routine-outcome-"))
  cleanup.push(() => rmSync(directory, { recursive: true, force: true }))
  const path = join(directory, "bots.sqlite"),
    restoredPath = join(directory, "restored.sqlite")
  const f = fixture(path)
  f.store.saveRoutineFromTool(f.lease, "persist", createInput, f.definition)
  f.store.finish(f.lease, "succeeded", "完成")
  const before = outcomes(f)
  const clone = f.store.cloneBot({ nonce: "clone", id: f.bot.id, revision: f.bot.revision })
  expect(f.store.messages(clone.conversationId)).toEqual([])
  f.store.close()
  const reopened = new BotStore(path)
  expect(reopened.messages(f.conversationId).filter((m) => m.routineOutcome)).toEqual(before)
  reopened.close()
  copyFileSync(path, restoredPath)
  const ledger = new BotDeletionLedger(restoredPath)
  try {
    fenceBotCheckpointDatabase(restoredPath, "restored", ledger)
  } finally {
    ledger.close()
  }
  const restored = new BotStore(restoredPath)
  cleanup.push(() => restored.close())
  expect(restored.dataEpoch()).toBe("restored")
  expect(
    restored.messages(f.conversationId).find((m) => m.routineOutcome)?.routineOutcome?.dataEpoch
  ).toBe("initial")
})
