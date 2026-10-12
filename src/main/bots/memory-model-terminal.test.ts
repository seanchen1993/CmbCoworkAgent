import { afterEach, expect, it, vi } from "vitest"
import { createServer } from "node:http"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { BotStore } from "./store"
import { botMemoryModels } from "./memory-model"
import { BotMemorySynthesis } from "./memory-synthesis"
import { writeBotModelSnapshot } from "./model-config"

const cleanups: (() => unknown | Promise<unknown>)[] = []
afterEach(async () => {
  for (const close of cleanups.splice(0).reverse()) await close()
  vi.restoreAllMocks()
})
type Phase = "synthesis" | "verification"
type Case = {
  phase?: Phase
  finish?: string | null
  tools?: boolean
  refusal?: boolean
  reasoningOnly?: boolean
  leadingReasoning?: boolean
  incorrectProposal?: boolean
}
const explicit = "发布前必须在灰度环境验证。"
const supportedFact = "项目采用 TypeScript，部署到内部 Kubernetes 集群。"
const unsupportedFact = "项目采用 Python，部署到公开云。"

async function fixture(input: Case = {}) {
  const diagnostics = vi.spyOn(console, "info").mockImplementation(() => {})
  const root = await mkdtemp(join(tmpdir(), "bot-memory-terminal-"))
  cleanups.push(() => rm(root, { recursive: true, force: true }))
  let now = 1_800_000_000_000
  const database = join(root, "bots.sqlite")
  const store = new BotStore(database, () => now)
  cleanups.push(() => store.close())
  const { bot, conversationId } = store.createBot({
    nonce: "bot",
    name: "记忆协议核验",
    modelRef: "fixture"
  })
  store.saveMemory({ botId: bot.id, text: explicit })
  const sent = store.send({ nonce: "task", conversationId, text: supportedFact })
  const claim = store.claim("fixture-host")!
  store.finish(claim.lease, "succeeded", "已按项目约定完成验证。")
  const assistantMessage = store
    .messages(conversationId)
    .find((message) => message.sender === "bot" && message.runId === sent.runIds[0])!
  now += 16_000
  const requests: Phase[] = []
  const server = createServer(async (request, response) => {
    const bodyParts: Buffer[] = []
    for await (const part of request) bodyParts.push(part)
    const body = JSON.parse(Buffer.concat(bodyParts).toString()) as {
      messages: { content: string }[]
    }
    const phase: Phase = body.messages[0].content.includes("SYNTHESIS_VERIFICATION")
      ? "verification"
      : "synthesis"
    requests.push(phase)
    const active = input.phase === phase
    const json = JSON.stringify(
      phase === "synthesis"
        ? {
            changes: [
              {
                action: "create",
                content: input.incorrectProposal ? unsupportedFact : supportedFact,
                kind: "profile",
                sourceEvidenceIds: [sent.runIds[0]]
              }
            ]
          }
        : { approved: true }
    )
    const content =
      active && input.reasoningOnly
        ? `<think>${json}</think>`
        : input.leadingReasoning
          ? `<think>FIXTURE_SEPARATE_ANALYSIS</think>${json}`
          : json
    const delta: Record<string, unknown> = { role: "assistant", content }
    if (active && input.refusal) delta.refusal = "Fixture provider declined this request"
    if (active && input.tools)
      delta.tool_calls = [
        {
          index: 0,
          id: "unexpected-call",
          type: "function",
          function: { name: "unexpected_write", arguments: "{}" }
        }
      ]
    response.setHeader("Content-Type", "text/event-stream")
    response.write(
      `data: ${JSON.stringify({ id: "fixture-memory", object: "chat.completion.chunk", created: 1, model: "fixture", choices: [{ index: 0, delta, finish_reason: null }] })}\n\n`
    )
    const finish = active && Object.hasOwn(input, "finish") ? input.finish : "stop"
    response.end(
      `data: ${JSON.stringify({ id: "fixture-memory", object: "chat.completion.chunk", created: 1, model: "fixture", choices: [{ index: 0, delta: {}, finish_reason: finish }], usage: { prompt_tokens: 123, completion_tokens: 17 } })}\n\ndata: [DONE]\n\n`
    )
  })
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
  cleanups.push(
    () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections()
        server.close(() => resolve())
      })
  )
  const port = (server.address() as { port: number }).port
  const modelFile = join(root, "models.private")
  await writeBotModelSnapshot(modelFile, {
    version: 1,
    defaultRef: "fixture",
    models: [
      {
        id: "fixture",
        ref: "fixture",
        name: "Fixture",
        model: "fixture",
        apiKey: "fixture-only",
        baseUrl: `http://127.0.0.1:${port}/v1`
      }
    ]
  })
  const service = new BotMemorySynthesis(store, botMemoryModels(modelFile, store))
  cleanups.push(() => service.close())
  const run = async () => {
    await service.runNow()
    return store.memories(bot.id)
  }
  const reopenMemories = () => {
    store.close()
    const reopened = new BotStore(database, () => now)
    cleanups.push(() => reopened.close())
    return reopened.memories(bot.id)
  }
  return {
    store,
    bot,
    conversationId,
    sent,
    assistantMessage,
    service,
    requests,
    diagnostics,
    run,
    reopenMemories
  }
}

it.each(["synthesis", "verification"] as const)(
  "does not persist an unverified %s under an unknown finish marker",
  async (phase) => {
    const f = await fixture({ phase, finish: "unknown_finish", incorrectProposal: true })
    await f.run()
    const outcome = f.store.memory.policy(f.bot.id).lastOutcome
    expect(f.reopenMemories().map((memory) => memory.text)).toEqual([explicit])
    expect(outcome).toBe("failed")
  },
  15_000
)

it.each([
  ["synthesis", "length"],
  ["verification", "length"],
  ["synthesis", null],
  ["verification", null],
  ["verification", "content_filter"]
] as const)(
  "preserves explicit memory on %s finish %s",
  async (phase, finish) => {
    const f = await fixture({ phase, finish })
    expect((await f.run()).map((memory) => memory.text)).toEqual([explicit])
    expect(f.store.memory.policy(f.bot.id).lastOutcome).toBe("failed")
    expect(f.requests).toEqual(
      phase === "synthesis" ? ["synthesis"] : ["synthesis", "verification"]
    )
  },
  15_000
)

it.each([
  { phase: "verification", refusal: true },
  { phase: "verification", tools: true },
  { phase: "synthesis", tools: true },
  { phase: "verification", reasoningOnly: true },
  { phase: "synthesis", reasoningOnly: true }
] as const)(
  "does not persist provider refusal, tools or reasoning-only JSON: %j",
  async (input) => {
    const f = await fixture(input)
    expect((await f.run()).map((memory) => memory.text)).toEqual([explicit])
    expect(f.store.memory.policy(f.bot.id).lastOutcome).not.toBe("committed")
  },
  15_000
)

it.each(["stop", "end_turn", "stop_sequence"])(
  "commits supported facts only after complete %s synthesis and verification",
  async (finish) => {
    const f = await fixture({ phase: "verification", finish })
    const memories = await f.run()
    expect(memories.map((memory) => memory.text).sort()).toEqual([explicit, supportedFact].sort())
    expect(f.store.memory.policy(f.bot.id).lastOutcome).toBe("committed")
    expect(f.requests).toEqual(["synthesis", "verification"])
    const synthesized = memories.find((memory) => memory.origin === "synthesized")!
    expect(synthesized.evidence).toEqual([
      {
        runId: f.sent.runIds[0],
        messageId: f.sent.messageId,
        conversationId: f.conversationId,
        assistantMessageId: f.assistantMessage.id,
        occurredAt: f.assistantMessage.createdAt
      }
    ])
    expect(
      f
        .reopenMemories()
        .map((memory) => memory.text)
        .sort()
    ).toEqual([explicit, supportedFact].sort())
  },
  15_000
)

it("uses the visible completed body without storing a leading analysis wrapper", async () => {
  const f = await fixture({ leadingReasoning: true })
  const memories = await f.run()
  expect(memories.map((memory) => memory.text).sort()).toEqual([explicit, supportedFact].sort())
  expect(JSON.stringify(memories)).not.toContain("FIXTURE_SEPARATE_ANALYSIS")
}, 15_000)
