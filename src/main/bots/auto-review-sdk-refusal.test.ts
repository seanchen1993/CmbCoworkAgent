import { afterEach, expect, it } from "vitest"
import { createServer } from "node:http"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { BotStore } from "./store"
import type { CoworkBot } from "../../shared/bot-types"
import { botAutoReviewer } from "./auto-review"
import { writeBotModelSnapshot, type BotModelSnapshot } from "./model-config"
import { testModelRequest, type TestModelRequest } from "./test-model-protocol"

const cleanups: (() => unknown | Promise<unknown>)[] = []
afterEach(async () => {
  for (const close of cleanups.splice(0).reverse()) await close()
})

const action = { connector: { provider: "Fixture", tool: "save", arguments: { text: "once" } } }

async function fixture(
  refusal: boolean,
  history?: {
    mode: "continuation" | "latest-refusal" | "unrelated"
    inspect(body: TestModelRequest): void
  },
  current?: {
    taskText: string
    action: unknown | ((bot: CoworkBot) => unknown)
    inspect?(body: TestModelRequest): void
  }
) {
  const root = await mkdtemp(join(tmpdir(), "bot-auto-review-sdk-refusal-"))
  cleanups.push(() => rm(root, { recursive: true, force: true }))
  let requests = 0
  const server = createServer(async (request, response) => {
    const chunks: Buffer[] = []
    for await (const chunk of request) chunks.push(chunk)
    const body = testModelRequest.parse(JSON.parse(Buffer.concat(chunks).toString()))
    history?.inspect(body)
    current?.inspect?.(body)
    requests++
    const delta: Record<string, unknown> = {
      role: "assistant",
      content: JSON.stringify({
        decision: history && history.mode !== "continuation" ? "ask" : "allow",
        reason: "受控审核结果；不代表真实模型任务质量。"
      })
    }
    if (refusal) delta.refusal = "Fixture provider refused this request"
    response.setHeader("Content-Type", "text/event-stream")
    response.write(
      `data: ${JSON.stringify({ id: "fixture-review", object: "chat.completion.chunk", created: 1, model: "fixture", choices: [{ index: 0, delta, finish_reason: null }] })}\n\n`
    )
    response.end(
      `data: ${JSON.stringify({ id: "fixture-review", object: "chat.completion.chunk", created: 1, model: "fixture", choices: [{ index: 0, delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 123, completion_tokens: 17 } })}\n\ndata: [DONE]\n\n`
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
  const snapshot: BotModelSnapshot = {
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
  }
  await writeBotModelSnapshot(modelFile, snapshot)
  const store = new BotStore(join(root, "bots.sqlite"))
  cleanups.push(() => store.close())
  const { bot, conversationId } = store.createBot({ nonce: "create", name: "审核助手" })
  if (history) {
    store.send({ nonce: "prior", conversationId, text: "保存 once 到 Fixture；不要发布到外部。" })
    const previous = store.claim("fixture-host", 300_000)!
    if (history.mode === "latest-refusal") {
      const card = store.requestInteraction(previous.lease, {
        kind: "approval",
        action,
        prompt: JSON.stringify(action)
      })
      store.answerInteraction({ id: card.id, revision: card.revision, answer: "reject" })
    }
    store.finish(previous.lease, "cancelled", "MODEL_TEXT_NOT_AUTHORITY")
  }
  store.send({
    nonce: "send",
    conversationId,
    text: history
      ? history.mode === "unrelated"
        ? "只解释今天的天气，不操作系统。"
        : "继续刚才的任务，保留原有限制。"
      : (current?.taskText ?? "保存 once 到 Fixture")
  })
  const { run, lease } = store.claim("fixture-host", 300_000)!
  store.autoReview.change({ ...store.autoReview.read(bot.id), isEnabled: true, nonce: "enable" })
  const signal = new AbortController()
  const reviewer = botAutoReviewer({
    request: {
      store,
      bot,
      run,
      lease,
      messages: store.messagesForRun(run.id),
      signal: signal.signal
    },
    modelFile,
    snapshot,
    config: snapshot.models[0],
    check: () => {
      signal.signal.throwIfAborted()
      store.assertDispatch(lease)
    },
    scope: () => "fixture"
  })
  const review = async () => {
    const proposedAction =
      typeof current?.action === "function" ? current.action(bot) : (current?.action ?? action)
    const record = await reviewer.review(proposedAction)
    const card = store.requestInteraction(lease, {
      kind: "approval",
      action: proposedAction,
      prompt: JSON.stringify(proposedAction),
      autoReview: record
    })
    return { record, card }
  }
  return { store, bot, run, lease, review, requestCount: () => requests }
}

it("reviews an explicitly assigned self rename through the SDK while binding its exact profile revision", async () => {
  let request: TestModelRequest | undefined
  const f = await fixture(false, undefined, {
    taskText: "以后你的名字叫核验助手，只改名称，不改职责。",
    action: (bot: CoworkBot) => ({
      botProfile: {
        operation: "update",
        agent_id: bot.id,
        revision: bot.revision,
        name: "核验助手"
      }
    }),
    inspect: (body) => {
      request = body
    }
  })
  const { record, card } = await f.review()
  expect(record?.decision).toBe("allow")
  expect(card).toMatchObject({ status: "answered", answer: "approve" })
  const context = JSON.parse(String(request!.messages[1].content))
  expect(context.proposedAction.botProfile).toEqual({
    operation: "update",
    agent_id: f.bot.id,
    revision: f.bot.revision,
    name: "核验助手"
  })
  expect(context.task.messages[0].text).toContain("只改名称，不改职责")
  const reviewPrompt = String(request!.messages[0].content)
  expect(reviewPrompt).toContain('{"decision":"ask","reason":"需要确认操作范围。"}')
  expect(reviewPrompt).toContain("A malformed result never grants permission.")
  expect(reviewPrompt).not.toContain('"allow"|"ask"')
  expect(f.requestCount()).toBe(1)
  expect(f.store.effects(f.run.id)).toEqual([])
  // A review permits a single bound effect, never mutation by the reviewer.
  f.store.beginEffect(f.lease, {
    id: "rename-once",
    action: context.proposedAction,
    approvalId: card.id
  })
  expect(() =>
    f.store.beginEffect(f.lease, {
      id: "rename-twice",
      action: context.proposedAction,
      approvalId: card.id
    })
  ).toThrow()
}, 15_000)

it.each(["responsibilities", "other-bot", "stale", "create", "extra-capability", "blank"] as const)(
  "keeps %s profile edits behind manual review before the SDK",
  async (kind) => {
    const f = await fixture(false, undefined, {
      taskText: "以后你的名字叫核验助手。",
      action: (bot: CoworkBot) => ({
        botProfile: {
          operation: kind === "create" ? "create" : "update",
          agent_id: kind === "other-bot" ? "another-bot" : bot.id,
          revision: kind === "stale" ? bot.revision + 1 : bot.revision,
          name: kind === "blank" ? " " : "核验助手",
          ...(kind === "responsibilities" ? { description: "expand duties" } : {}),
          ...(kind === "extra-capability" ? { connectorIds: ["other"] } : {})
        }
      })
    })
    const { record, card } = await f.review()
    expect(record?.decision).toBe("ask")
    expect(card).toMatchObject({ status: "pending", answer: null })
    expect(f.requestCount()).toBe(0)
    expect(f.store.effects(f.run.id)).toEqual([])
  },
  15_000
)

it("preserves provider refusal for a self rename rather than treating eligibility as permission", async () => {
  const f = await fixture(true, undefined, {
    taskText: "以后你的名字叫核验助手。",
    action: (bot: CoworkBot) => ({
      botProfile: {
        operation: "update",
        agent_id: bot.id,
        revision: bot.revision,
        name: "核验助手"
      }
    })
  })
  const { record, card } = await f.review()
  expect(record?.decision).toBe("ask")
  expect(card.status).toBe("pending")
  expect(f.requestCount()).toBe(1)
  expect(f.store.effects(f.run.id)).toEqual([])
}, 15_000)

it("preserves one-action approval through the actual configured SDK for a valid stop response", async () => {
  const f = await fixture(false)
  const { record, card } = await f.review()
  expect(record?.decision).toBe("allow")
  expect(card).toMatchObject({ status: "answered", answer: "approve" })
  f.store.beginEffect(f.lease, { id: "once", action, approvalId: card.id })
  expect(() => f.store.beginEffect(f.lease, { id: "twice", action, approvalId: card.id })).toThrow()
  expect(f.requestCount()).toBe(1)
}, 15_000)

it("keeps stop plus explicit SSE refusal behind human approval through the actual configured SDK", async () => {
  const f = await fixture(true)
  const { record, card } = await f.review()
  expect(record?.decision).toBe("ask")
  expect(card).toMatchObject({ status: "pending", answer: null })
  expect(f.store.effects(f.run.id)).toEqual([])
  expect(f.requestCount()).toBe(1)
}, 15_000)

it.each(["continuation", "latest-refusal", "unrelated"] as const)(
  "sends distinct historical context and preserves the SDK review outcome for %s",
  async (mode) => {
    let request: TestModelRequest | undefined
    const f = await fixture(false, {
      mode,
      inspect: (body) => {
        request = body
      }
    })
    const { record, card } = await f.review()
    expect(request).toBeDefined()
    const context = JSON.parse(String(request!.messages[1].content))
    expect(context.task.messages.map((message: { text: string }) => message.text)).toEqual([
      mode === "unrelated" ? "只解释今天的天气，不操作系统。" : "继续刚才的任务，保留原有限制。"
    ])
    expect(context.task.priorContext.messages).toHaveLength(1)
    expect(context.task.priorContext.messages[0]).toMatchObject({
      text: "保存 once 到 Fixture；不要发布到外部。",
      eventCursor: expect.any(Number)
    })
    expect(context.task.priorContext.rejectedActions).toHaveLength(
      mode === "latest-refusal" ? 1 : 0
    )
    if (mode === "latest-refusal") {
      expect(context.task.priorContext.rejectedActions[0].prompt).toBe(JSON.stringify(action))
      expect(context.task.priorContext.rejectedActions[0].eventCursor).toBeGreaterThan(
        context.task.priorContext.messages[0].eventCursor
      )
    }
    expect(JSON.stringify(context.task)).not.toContain("MODEL_TEXT_NOT_AUTHORITY")
    const system = String(request!.messages[0].content)
    expect(system).toContain("not current authorization")
    expect(system).toContain("Historical approval does not authorize an unrelated new task")
    expect(system).toContain("do not resurrect an earlier permission")
    expect(system).toContain("Preserve relevant historical refusals")
    expect(record?.decision).toBe(mode === "continuation" ? "allow" : "ask")
    expect(card.status).toBe(mode === "continuation" ? "answered" : "pending")
    expect(f.store.effects(f.run.id)).toEqual([])
    expect(f.requestCount()).toBe(1)
  },
  15_000
)

const browserAction = {
  browser: { op: "fill", ref: "e7", value: "12" },
  botId: "fixture-bot",
  target: {
    botId: "fixture-bot",
    generation: "fixture-browser-generation",
    controlEpoch: 1,
    control: "bot",
    viewId: "fixture-view"
  },
  browserReview: {
    targetPageUrl: "http://127.0.0.1:12345/",
    displayStateIdentity: "1".repeat(64),
    elements: [{ tag: "input", id: "amount", label: "金额", type: "number", sensitive: false }],
    manualReason: null
  }
}

it("sends partial-step and opaque-target review contracts through the actual configured SDK without broadening one-action approval", async () => {
  let request: TestModelRequest | undefined
  const f = await fixture(false, undefined, {
    taskText:
      "在本机测试页面验证连续输入、新增删除和非法值修正，并检查窄屏显示。不要发布或操作其他系统。",
    action: browserAction,
    inspect: (body) => {
      request = body
    }
  })
  const { record, card } = await f.review()
  const system = String(request!.messages[0].content)
  expect(system).toContain("Review authorization for this action, not whether the whole task")
  expect(system).toContain("without the user naming each individual step")
  expect(system).toContain("does not itself prove the final result")
  expect(system).toContain(
    "does not authorize unrelated, destructive, external or sensitive operations"
  )
  expect(system).toContain("opaque tokens with different meanings")
  expect(system).toContain("Do not invent a changed-target finding from different token values")
  expect(system).toContain("it does not establish authorization or harmlessness")
  expect(system).toContain("Never allow a rejected action through another tool")
  expect(system).toContain("blockInstructions mean always ask for matching operations")
  const context = JSON.parse(String(request!.messages[1].content))
  expect(context.proposedAction).toEqual(browserAction)
  expect(context.task.messages[0].text).toContain("不要发布或操作其他系统")
  expect(record?.decision).toBe("allow")
  expect(card).toMatchObject({ status: "answered", answer: "approve" })
  f.store.beginEffect(f.lease, { id: "once", action: browserAction, approvalId: card.id })
  expect(() =>
    f.store.beginEffect(f.lease, { id: "twice", action: browserAction, approvalId: card.id })
  ).toThrow()
  expect(f.requestCount()).toBe(1)
}, 15_000)

it.each([
  { manualReason: "敏感输入目标需人工确认，请优先使用安全凭据工具。" },
  { manualReason: "坐标、拖动或高级浏览器操作需人工确认。" },
  { displayStateIdentity: null }
])(
  "keeps browser manual gates ahead of the SDK even for an assigned validation step: %j",
  async (override) => {
    const f = await fixture(false, undefined, {
      taskText: "在本机测试页面验证输入和窄屏显示。",
      action: {
        ...browserAction,
        browserReview: { ...browserAction.browserReview, ...override }
      }
    })
    const { record, card } = await f.review()
    expect(record?.decision).toBe("ask")
    expect(card).toMatchObject({ status: "pending", answer: null })
    expect(f.store.effects(f.run.id)).toEqual([])
    expect(f.requestCount()).toBe(0)
  },
  15_000
)
