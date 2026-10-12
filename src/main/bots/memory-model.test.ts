import { afterEach, expect, it, vi } from "vitest"
import { createServer } from "node:http"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { BotStore } from "./store"
import { writeBotModelSnapshot, type BotModelSnapshot } from "./model-config"
import { botMemoryModels } from "./memory-model"
import { BotMemorySynthesis } from "./memory-synthesis"
import { testModelRequest, type TestModelRequest } from "./test-model-protocol"

const cleanup: (() => Promise<unknown> | unknown)[] = []
afterEach(async () => {
  for (const fn of cleanup.splice(0).reverse()) await fn()
  vi.restoreAllMocks()
})
it.each([
  { changeConfig: false, budget: false },
  { changeConfig: true, budget: false },
  { changeConfig: false, budget: true }
])(
  "uses the actual configured Cmb model protocol: settings changes=$changeConfig, budget=$budget",
  async ({ changeConfig, budget }) => {
    const diagnostics = vi.spyOn(console, "info").mockImplementation(() => {})
    const root = await mkdtemp(join(tmpdir(), "cmb-memory-model-")),
      path = join(root, "models.private")
    cleanup.push(() => rm(root, { recursive: true, force: true }))
    let now = 1_800_000_000_000
    const store = new BotStore(join(root, "bots.sqlite"), () => now)
    cleanup.push(() => store.close())
    const { bot, conversationId } = store.createBot({
      nonce: "bot",
      name: "有证据的记忆",
      modelRef: "chosen"
    })
    const { conversationId: other } = store.createBot({ nonce: "other", name: "另一个助手" })
    store.send({
      nonce: "other-message",
      conversationId: other,
      text: "PRIVATE_OTHER_BOT_NEVER_SENT"
    })
    const sent = store.send({
      nonce: "task",
      conversationId,
      text: "我们的项目名是星舟，计划在 2026 年 12 月发布。"
    })
    let claimed = store.claim("test")!
    if (claimed.run.conversationId === other) {
      store.finish(claimed.lease, "failed", "不处理")
      claimed = store.claim("test")!
    }
    store.finish(claimed.lease, "succeeded", "项目发布时间仍为计划，尚未发布。")
    now += 16_000
    const requests: TestModelRequest[] = []
    const server = createServer(async (req, res) => {
      const bytes: Buffer[] = []
      for await (const part of req) bytes.push(part)
      const body = testModelRequest.parse(JSON.parse(Buffer.concat(bytes).toString()))
      requests.push(body)
      if (changeConfig && requests.length === 2)
        await writeBotModelSnapshot(path, { ...config, defaultRef: "new-default" })
      const text = JSON.stringify(
        requests.length === 1
          ? {
              changes: [
                {
                  action: "create",
                  content: "星舟项目计划于 2026 年 12 月发布；实际发布时间待确认。",
                  kind: "log",
                  sourceEvidenceIds: [sent.runIds[0]]
                }
              ]
            }
          : { approved: true }
      )
      res.setHeader("Content-Type", "text/event-stream")
      res.write(
        `data: ${JSON.stringify({ id: "memory", object: "chat.completion.chunk", created: 1, model: "fixture", choices: [{ index: 0, delta: { role: "assistant", content: text }, finish_reason: null }] })}\n\n`
      )
      res.end(
        `data: ${JSON.stringify({ id: "memory", object: "chat.completion.chunk", created: 1, model: "fixture", choices: [{ index: 0, delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 321, completion_tokens: 19 } })}\n\ndata: [DONE]\n\n`
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
    const port = (server.address() as { port: number }).port
    const config: BotModelSnapshot = {
      version: 1,
      defaultRef: null,
      models: [
        {
          id: "chosen",
          ref: "chosen",
          name: "Configured model",
          model: "fixture",
          apiKey: "local-fixture-only",
          baseUrl: `http://127.0.0.1:${port}/v1`
        }
      ]
    }
    await writeBotModelSnapshot(path, config)
    if (budget)
      store.usageBudgets.change({
        botId: null,
        nonce: "memory-limit",
        revision: 0,
        dataEpoch: store.backupSchedule.epoch(),
        outputLimit: 5000
      })
    const service = new BotMemorySynthesis(store, botMemoryModels(path, store))
    cleanup.push(() => service.close())
    await service.runNow()
    expect(requests).toHaveLength(2)
    const traces = diagnostics.mock.calls
      .filter(([tag]) => tag === "[BotModelCall]")
      .map(([, value]) => value)
    for (const [id, purpose] of store.db.exec(
      "SELECT id,purpose FROM bot_model_usage ORDER BY rowid"
    )[0].values)
      expect(traces).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            callId: id,
            botId: bot.id,
            runId: null,
            purpose,
            phase: "stream_ended",
            outputTokensReported: 19
          })
        ])
      )
    expect(store.memory.policy(bot.id).usage).toMatchObject({
      requests: 2,
      inputTokens: 642,
      outputTokens: 38,
      unknownRequests: 0,
      inputReportedRequests: 2
    })
    expect(
      store.memory
        .policy(bot.id)
        .usage?.models.map((item) => item.purpose)
        .sort()
    ).toEqual(["memory-synthesis", "memory-verification"])
    expect(store.memory.policy(store.getConversation(other).members[0]).usage?.requests).toBe(0)
    expect(
      requests.every((request) => request.tools.length === 0 && request.messages.length === 2)
    ).toBe(true)
    expect(requests[0].messages[0].content).toContain("MEMORY_SYNTHESIS_V1")
    expect(requests[1].messages[0].content).toContain("MEMORY_SYNTHESIS_VERIFICATION_V1")
    expect(JSON.stringify(requests)).not.toContain("PRIVATE_OTHER_BOT_NEVER_SENT")
    expect(store.memories(bot.id)).toHaveLength(changeConfig ? 0 : 1)
    expect(store.memory.policy(bot.id).lastOutcome).toBe(changeConfig ? "failed" : "committed")
    if (budget) {
      expect(
        requests.map((request) => request.max_completion_tokens ?? request.max_tokens)
      ).toEqual([5000, 4981])
      expect(store.usageBudgets.view({ botId: null }).available).toBe(4962)
      store.usageBudgets.change({
        botId: null,
        nonce: "pause-model",
        revision: 1,
        dataEpoch: store.backupSchedule.epoch(),
        outputLimit: 0
      })
      const session = await botMemoryModels(path, store)(bot.id, new AbortController().signal)
      await expect(
        session.complete("Review", {}, new AbortController().signal)
      ).rejects.toMatchObject({ code: "model_usage_budget" })
      expect(requests).toHaveLength(2)
      expect(store.usageBudgets.view({ botId: null }).usage.requests).toBe(2)
    }
  }
)
