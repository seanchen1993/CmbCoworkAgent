import { afterEach, expect, it } from "vitest"
import { mkdtempSync, readdirSync, rmSync } from "node:fs"
import { DatabaseSync } from "node:sqlite"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { BotStore } from "./store"
import { startBotModelUsage, settleBotModelUsage, botModelUsage } from "./model-usage"
import type { ModelResponseDiagnostic } from "../agent/model-response-diagnostics"

const stores: BotStore[] = [],
  directories: string[] = []
afterEach(() => {
  for (const store of stores.splice(0)) store.close()
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true })
})
const model = {
  id: "configured",
  ref: "configured-ref",
  model: "model-a",
  baseUrl: "https://unused.invalid",
  apiKey: "NEVER_PERSIST_CREDENTIAL"
}
const usage = (outputTokens?: number, inputTokens?: number) =>
  ({
    doneEvents: 1,
    errorEvents: 0,
    uninspectedEvents: 0,
    outputTokens,
    inputTokens
  }) as ModelResponseDiagnostic
function fixture(path = ":memory:", clock?: () => number) {
  const store = new BotStore(path, clock)
  stores.push(store)
  const a = store.createBot({ nonce: "a", name: "A" }),
    b = store.createBot({ nonce: "b", name: "B" })
  const task = store.send({ nonce: "task", conversationId: a.conversationId, text: "Work" })
  return { store, a, b, runId: task.runIds[0] }
}

it("upgrades v42 with a pre-upgrade backup and never invents usage for previous calls", () => {
  const directory = mkdtempSync(join(tmpdir(), "cmb-usage-upgrade-"))
  directories.push(directory)
  const path = join(directory, "bots.sqlite"),
    f = fixture(path)
  f.store.db.run("INSERT INTO bot_workflow_model_calls VALUES(?,?,NULL,?,?,?,?)", [
    "old-call",
    f.runId,
    f.runId,
    100,
    20,
    f.store.now()
  ])
  f.store.close()
  stores.splice(stores.indexOf(f.store), 1)
  const old = new DatabaseSync(path)
  old.exec("DROP TABLE bot_model_usage; UPDATE bot_schema SET version=42")
  old.close()
  const next = new BotStore(path)
  stores.push(next)
  const history = next.runHistory({ conversationId: f.a.conversationId, runId: f.runId })
  expect(history.modelBudget).toMatchObject({ requests: 1, consumed: 20 })
  expect(history.modelUsage?.requests).toBe(0)
  const backup = readdirSync(join(directory, "backups")).find((file) =>
    file.startsWith("bots-v42-")
  )!
  const saved = new DatabaseSync(join(directory, "backups", backup), { readOnly: true })
  try {
    expect(saved.prepare("SELECT version FROM bot_schema").get()?.version).toBe(42)
  } finally {
    saved.close()
  }
})

it("keeps task and background usage scoped, with immutable model identity and idempotent receipts", () => {
  const f = fixture()
  const task = startBotModelUsage(f.store, {
    botId: f.a.bot.id,
    runId: f.runId,
    model,
    purpose: "task",
    reserved: 100
  })
  settleBotModelUsage(f.store, task, usage(12, 55))
  settleBotModelUsage(f.store, task, usage(99, 999))
  const memory = startBotModelUsage(f.store, {
    botId: f.a.bot.id,
    model: { ...model, model: "model-b" },
    purpose: "memory-synthesis",
    reserved: 100
  })
  settleBotModelUsage(f.store, memory, usage(0, 0))
  startBotModelUsage(f.store, {
    botId: f.b.bot.id,
    model,
    purpose: "memory-verification",
    reserved: 50
  })
  expect(botModelUsage(f.store, { rootRunId: f.runId })).toMatchObject({
    requests: 1,
    inputTokens: 55,
    outputTokens: 12,
    unknownRequests: 0,
    models: [{ model: "model-a", modelRef: "configured-ref" }]
  })
  expect(botModelUsage(f.store, { memoryBotId: f.a.bot.id })).toMatchObject({
    requests: 1,
    inputTokens: 0,
    outputTokens: 0,
    inputReportedRequests: 1,
    unknownRequests: 0,
    models: [{ model: "model-b" }]
  })
  expect(botModelUsage(f.store, { memoryBotId: f.b.bot.id })).toMatchObject({
    requests: 1,
    unknownRequests: 1,
    reservedOutputTokens: 50
  })
  expect(JSON.stringify(f.store.db.exec("SELECT * FROM bot_model_usage"))).not.toContain(
    model.apiKey
  )
  expect(() =>
    startBotModelUsage(f.store, {
      botId: f.b.bot.id,
      runId: f.runId,
      model,
      purpose: "task",
      reserved: 1
    })
  ).toThrow("不属于")
})

it.each(["unfinished", "malformed", "missing", "negative", "fraction", "infinite"])(
  "does not settle uncertain counters: %s",
  (kind) => {
    const f = fixture(),
      id = startBotModelUsage(f.store, {
        botId: f.a.bot.id,
        model,
        purpose: "memory-synthesis",
        reserved: 100
      })
    const report =
      kind === "unfinished"
        ? { ...usage(1), doneEvents: 0 }
        : kind === "malformed"
          ? { ...usage(1), uninspectedEvents: 1 }
          : usage({ missing: undefined, negative: -1, fraction: 0.5, infinite: Infinity }[kind])
    settleBotModelUsage(f.store, id, report)
    expect(botModelUsage(f.store, { memoryBotId: f.a.bot.id })).toMatchObject({
      requests: 1,
      unknownRequests: 1,
      reservedOutputTokens: 100,
      inputReportedRequests: 0
    })
  }
)

it("preserves unknown requests across restart and bounds the recent background summary", () => {
  const directory = mkdtempSync(join(tmpdir(), "cmb-model-usage-"))
  directories.push(directory)
  let now = 1_800_000_000_000
  const path = join(directory, "bots.sqlite"),
    f = fixture(path, () => now)
  startBotModelUsage(f.store, {
    botId: f.a.bot.id,
    model,
    purpose: "memory-synthesis",
    reserved: 8192
  })
  f.store.close()
  stores.splice(stores.indexOf(f.store), 1)
  const next = new BotStore(path, () => now)
  stores.push(next)
  expect(botModelUsage(next, { memoryBotId: f.a.bot.id })).toMatchObject({
    requests: 1,
    unknownRequests: 1,
    reservedOutputTokens: 8192
  })
  now += 31 * 86_400_000
  expect(botModelUsage(next, { memoryBotId: f.a.bot.id }).requests).toBe(0)
  for (let i = 0; i < 105; i++) {
    const id = startBotModelUsage(next, {
      botId: f.a.bot.id,
      model: { ...model, ref: `model-${i}` },
      purpose: "memory-synthesis",
      reserved: 100
    })
    settleBotModelUsage(next, id, usage(2, 3))
  }
  const summary = botModelUsage(next, { memoryBotId: f.a.bot.id })
  expect(summary).toMatchObject({
    requests: 105,
    inputTokens: 315,
    outputTokens: 210,
    otherModelRequests: 5
  })
  expect(summary.models).toHaveLength(100)
})
