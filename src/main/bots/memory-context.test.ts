import { afterEach, expect, it } from "vitest"
import { createServer } from "node:http"
import { randomUUID } from "node:crypto"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { BotStore } from "./store"
import { writeBotModelSnapshot, readBotModelSnapshot } from "./model-config"
import { botMemoryModels } from "./memory-model"
import { BotMemorySynthesis } from "./memory-synthesis"
import { testModelRequest, type TestModelRequest } from "./test-model-protocol"
import { memoryInputByteLimit, memoryOutputLimit, memoryRequestFits } from "./memory-context"

const cleanup: (() => Promise<unknown> | unknown)[] = []
afterEach(async () => {
  for (const fn of cleanup.splice(0).reverse()) await fn()
})

type Evidence = { id: string; user: string }
async function fixture(proposal?: (evidence: Evidence[]) => unknown) {
  const root = await mkdtemp(join(tmpdir(), "cmb-memory-context-"))
  cleanup.push(() => rm(root, { recursive: true, force: true }))
  let now = 1_800_000_000_000
  let store = new BotStore(join(root, "bots.sqlite"), () => now)
  cleanup.push(() => store.close())
  const { bot, conversationId } = store.createBot({ nonce: "bot", name: "项目助手" })
  store.saveMemory({ botId: bot.id, text: "评审前必须保留原始证据。" })
  const requests: TestModelRequest[] = []
  const server = createServer(async (req, res) => {
    const bytes: Buffer[] = []
    for await (const part of req) bytes.push(part)
    const body = testModelRequest.parse(JSON.parse(Buffer.concat(bytes).toString()))
    requests.push(body)
    const system = String(body.messages[0].content)
    const data = JSON.parse(String(body.messages[1].content))
    const text = JSON.stringify(
      system.includes("VERIFICATION")
        ? { approved: true }
        : (proposal?.(data.newEvidence) ?? {
            changes: data.newEvidence.map((item: Evidence) => ({
              action: "create",
              content: `本次任务的可核对来源 ${item.id}`,
              kind: "log",
              sourceEvidenceIds: [item.id]
            }))
          })
    )
    res.setHeader("Content-Type", "text/event-stream")
    res.write(
      `data: ${JSON.stringify({ id: randomUUID(), object: "chat.completion.chunk", created: 1, model: "fixture", choices: [{ index: 0, delta: { role: "assistant", content: text }, finish_reason: null }] })}\n\n`
    )
    res.end(
      `data: ${JSON.stringify({ id: randomUUID(), object: "chat.completion.chunk", created: 1, model: "fixture", choices: [{ index: 0, delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 123, completion_tokens: 17 } })}\n\ndata: [DONE]\n\n`
    )
  })
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
  cleanup.push(
    () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections()
        server.close(() => resolve())
      })
  )
  const path = join(root, "models.private")
  await writeBotModelSnapshot(path, {
    version: 1,
    defaultRef: "chosen",
    models: [
      {
        id: "chosen",
        ref: "chosen",
        name: "小上下文模型",
        model: "fixture",
        apiKey: "local-fixture-only",
        baseUrl: `http://127.0.0.1:${(server.address() as { port: number }).port}/v1`,
        maxTokens: 32_000,
        maxOutputTokens: 8192
      }
    ]
  })
  let service = new BotMemorySynthesis(store, botMemoryModels(path, store))
  cleanup.push(() => service.close())
  return {
    bot,
    requests,
    get store() {
      return store
    },
    run: () => service.runNow(),
    async configureContext(maxTokens: number) {
      const snapshot = await readBotModelSnapshot(path)
      snapshot.models[0].maxTokens = maxTokens
      await writeBotModelSnapshot(path, snapshot)
    },
    finish(user: string, assistant = "已完成本次检查。") {
      const sent = store.send({ nonce: randomUUID(), conversationId, text: user })
      const claim = store.claim("fixture")!
      store.finish(claim.lease, "succeeded", assistant)
      now += 16_000
      return sent.runIds[0]
    },
    async reopen() {
      await service.close()
      store.close()
      store = new BotStore(join(root, "bots.sqlite"), () => now)
      store.memory.recover()
      service = new BotMemorySynthesis(store, botMemoryModels(path, store))
    }
  }
}

it("batches whole evidence for the configured context and preserves unattempted work across restart", async () => {
  const f = await fixture()
  const ids = Array.from({ length: 12 }, (_, index) =>
    f.finish(`task-${index} ${"u".repeat(7800)}`, "a".repeat(7800))
  )
  await f.run()
  expect(f.requests).toHaveLength(2)
  expect(f.store.memory.policy(f.bot.id)).toMatchObject({ pending: 11, lastOutcome: "committed" })
  const untouched = f.store.db.exec(
    "SELECT attempts FROM bot_memory_evidence WHERE state='pending'"
  )[0].values
  expect(untouched).toEqual(Array.from({ length: 11 }, () => [0]))
  await f.reopen()
  for (let i = 1; i < 12; i++) await f.run()
  expect(f.requests).toHaveLength(24)
  const memories = f.store.memories(f.bot.id)
  expect(memories).toHaveLength(13)
  expect(
    memories
      .filter((memory) => memory.origin === "synthesized")
      .flatMap((memory) => memory.evidence!.map((source) => source.runId))
      .sort()
  ).toEqual(ids.sort())
  expect(f.store.memory.policy(f.bot.id)).toMatchObject({ pending: 0, lastOutcome: "committed" })
  for (const request of f.requests) {
    expect(request.tools).toEqual([])
    expect(request.max_tokens).toBe(8192)
    expect(
      Buffer.byteLength(String(request.messages[0].content)) +
        Buffer.byteLength(String(request.messages[1].content))
    ).toBeLessThanOrEqual(22_808)
    expect(String(request.messages[1].content)).toContain("评审前必须保留原始证据。")
  }
}, 20_000)

it("does not send oversized Chinese evidence or consume the next smaller task", async () => {
  const f = await fixture()
  const large = f.finish("中".repeat(8000)),
    small = f.finish("后续评审使用中文。")
  await f.run()
  expect(f.requests).toHaveLength(0)
  expect(f.store.memory.policy(f.bot.id)).toMatchObject({
    pending: 1,
    lastOutcome: "context-limit"
  })
  expect(
    f.store.db.exec("SELECT state,attempts FROM bot_memory_evidence WHERE run_id=?", [large])[0]
      .values
  ).toEqual([["failed", 1]])
  expect(
    f.store.db.exec("SELECT state,attempts FROM bot_memory_evidence WHERE run_id=?", [small])[0]
      .values
  ).toEqual([["pending", 0]])
  await f.reopen()
  await f.run()
  expect(f.requests).toHaveLength(2)
  expect(
    f.store
      .memories(f.bot.id)
      .filter((memory) => memory.origin === "synthesized")
      .flatMap((memory) => memory.evidence!.map((source) => source.runId))
  ).toEqual([small])
  await f.configureContext(128_000)
  const policy = f.store.memory.policy(f.bot.id)
  f.store.memory.retry({
    botId: f.bot.id,
    revision: policy.revision,
    dataEpoch: "initial",
    nonce: "larger-model"
  })
  await f.reopen()
  await f.run()
  expect(f.requests).toHaveLength(4)
  expect(f.store.memory.policy(f.bot.id)).toMatchObject({
    pending: 0,
    failed: 0,
    lastOutcome: "committed"
  })
  expect(
    f.store
      .memories(f.bot.id)
      .filter((memory) => memory.origin === "synthesized")
      .flatMap((memory) => memory.evidence!.map((source) => source.runId))
      .sort()
  ).toEqual([small, large].sort())
})

it("checks the independent verification request too and never commits an unverified oversized proposal", async () => {
  const f = await fixture((evidence) => ({
    changes: Array.from({ length: 64 }, (_, i) => ({
      action: "create",
      content: `${i}: ${"中".repeat(490)}`,
      kind: "log",
      sourceEvidenceIds: [evidence[0].id]
    }))
  }))
  f.finish("本次评审按项目规则执行。")
  await f.run()
  expect(f.requests).toHaveLength(1)
  expect(f.store.memories(f.bot.id).map((memory) => memory.text)).toEqual([
    "评审前必须保留原始证据。"
  ])
  expect(f.store.memory.policy(f.bot.id)).toMatchObject({
    pending: 0,
    lastOutcome: "context-limit"
  })
  await f.run()
  expect(f.requests).toHaveLength(1)
})

it("retains Cmb output reservations and rejects invalid budgets without network or tokenizer I/O", () => {
  expect(memoryInputByteLimit({ maxTokens: 32_000, maxOutputTokens: 8192 })).toBe(22_808)
  expect(memoryOutputLimit({ maxOutputTokens: 20000 })).toBe(8192)
  expect(memoryRequestFits("规则", { text: "😀" }, 10)).toBe(false)
  for (const config of [
    { maxTokens: 0 },
    { maxTokens: NaN },
    { maxTokens: 1000 },
    { maxOutputTokens: -1 },
    { maxOutputTokens: 1.5 },
    { maxOutputTokens: Infinity }
  ])
    expect(() => memoryInputByteLimit(config)).toThrow()
})
