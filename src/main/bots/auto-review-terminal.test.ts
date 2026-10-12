import { afterEach, expect, it, vi } from "vitest"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { BotStore } from "./store"
import { botAutoReviewer } from "./auto-review"
import { writeBotModelSnapshot, type BotModelSnapshot } from "./model-config"

const model = vi.hoisted(() => ({
  chunks: [] as Record<string, unknown>[],
  calls: 0,
  afterChunk: undefined as (() => void) | undefined
}))
vi.mock("../models/model-factory", () => ({
  createConfiguredCmbModel: () => ({
    async *stream() {
      model.calls++
      for (const chunk of model.chunks) {
        yield chunk
        model.afterChunk?.()
      }
    }
  })
}))

const cleanups: (() => unknown | Promise<unknown>)[] = []
afterEach(async () => {
  for (const close of cleanups.splice(0).reverse()) await close()
  model.chunks = []
  model.calls = 0
  model.afterChunk = undefined
})

const action = { connector: { provider: "Fixture", tool: "save", arguments: { text: "once" } } }
const allow = JSON.stringify({ decision: "allow", reason: "符合当前任务要求。" })

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "bot-auto-review-terminal-"))
  cleanups.push(() => rm(root, { recursive: true, force: true }))
  const modelFile = join(root, "models.private")
  const snapshot: BotModelSnapshot = {
    version: 1,
    defaultRef: "fixture",
    models: [
      {
        id: "fixture",
        ref: "fixture",
        name: "Fixture",
        model: "fixture-model",
        apiKey: "fixture-only",
        baseUrl: "http://127.0.0.1:1/v1"
      }
    ]
  }
  await writeBotModelSnapshot(modelFile, snapshot)
  const store = new BotStore(":memory:")
  cleanups.push(() => store.close())
  const { bot, conversationId } = store.createBot({ nonce: "create", name: "审核助手" })
  store.send({ nonce: "send", conversationId, text: "保存 once 到 Fixture" })
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
    const record = await reviewer.review(action)
    const card = store.requestInteraction(lease, {
      kind: "approval",
      action,
      prompt: JSON.stringify(action),
      autoReview: record
    })
    return { record, card }
  }
  return { store, bot, run, lease, signal, review, reviewer, modelFile, snapshot }
}

it.each([
  "length",
  "unknown_finish",
  "tool_calls",
  "content_filter",
  "error",
  "pause_turn",
  "cancelled"
])(
  "keeps a complete-looking allow JSON under %s terminal behind human approval",
  async (finish) => {
    const f = await fixture()
    model.chunks = [{ content: allow, response_metadata: { finish_reason: finish } }]
    const { record, card } = await f.review()
    expect(record?.decision).toBe("ask")
    expect(card.status).toBe("pending")
    expect(card.answer).toBeNull()
    expect(f.store.effects(f.run.id)).toEqual([])
    expect(model.calls).toBe(1)
  }
)

it("keeps clean EOF without a terminal marker behind human approval", async () => {
  const f = await fixture()
  model.chunks = [{ content: allow }]
  expect((await f.review()).card.status).toBe("pending")
})

it("admits a complete group-publication payload to review and keeps malformed destinations manual", async () => {
  const f = await fixture()
  model.chunks = [{ content: allow, response_metadata: { finish_reason: "stop" } }]
  const groupPost = {
    destination: {
      id: "room",
      name: "评审群",
      revision: 1,
      members: [{ id: f.bot.id, name: f.bot.name, revision: f.bot.revision }]
    },
    message: "公开核验结果",
    files: [
      {
        sourceId: "result",
        sourceConversationId: "private",
        name: "result.csv",
        mime: "text/csv",
        size: 12,
        sha256: "a".repeat(64)
      }
    ]
  }
  // This controlled reviewer only verifies the typed routing gate; it does not
  // establish that a real model would authorize an unrelated publication.
  expect((await f.reviewer.review({ groupPost }))?.decision).toBe("allow")
  expect(model.calls).toBe(1)
  for (const invalid of [
    { ...groupPost, destination: { ...groupPost.destination, members: [] } },
    { ...groupPost, destination: { ...groupPost.destination, revision: 0 } },
    { ...groupPost, files: [{ ...groupPost.files[0], path: "/private/secret" }] },
    { ...groupPost, hiddenAction: "send private history" }
  ])
    expect((await f.reviewer.review({ groupPost: invalid }))?.decision).toBe("ask")
  expect(model.calls).toBe(1)
})

it.each(["stop", " STOP ", "end_turn", "stop_sequence"])(
  "preserves exact one-action approval for a complete %s response",
  async (finish) => {
    const f = await fixture()
    model.chunks = [{ content: allow, response_metadata: { finish_reason: finish } }]
    const { record, card } = await f.review()
    expect(record?.decision).toBe("allow")
    expect(card).toMatchObject({ status: "answered", answer: "approve" })
    f.store.beginEffect(f.lease, { id: "once", action, approvalId: card.id })
    expect(() =>
      f.store.beginEffect(f.lease, { id: "twice", action, approvalId: card.id })
    ).toThrow()
    expect(model.calls).toBe(1)
  }
)

it.each([
  { additional_kwargs: { refusal: "Fixture provider refusal" } },
  {
    content: [
      { type: "refusal", refusal: "Fixture provider refusal" },
      { type: "text", text: allow }
    ]
  },
  { tool_calls: [{ id: "unexpected", name: "save", args: {} }] },
  { invalid_tool_calls: [{ id: "invalid", name: "save", args: "{" }] },
  { tool_call_chunks: [{ id: "partial", name: "save", args: "{" }] }
])("rejects explicit refusal or tool-call structure without executing it: %j", async (extra) => {
  const f = await fixture()
  model.chunks = [{ content: allow, response_metadata: { finish_reason: "stop" }, ...extra }]
  const { record, card } = await f.review()
  expect(record?.decision).toBe("ask")
  expect(card.status).toBe("pending")
  expect(f.store.effects(f.run.id)).toEqual([])
})

it("projects a completed leading reasoning block without exposing it in the approval reason", async () => {
  const f = await fixture()
  model.chunks = [
    { content: "<thi" },
    { content: "nk>PRIVATE_REVIEW_ANALYSIS</th" },
    { content: `ink>${allow}`, response_metadata: { finish_reason: "stop" } }
  ]
  const { record, card } = await f.review()
  expect(record?.decision).toBe("allow")
  expect(card.answer).toBe("approve")
  expect(JSON.stringify(record)).not.toContain("PRIVATE_REVIEW_ANALYSIS")
})

it("keeps incomplete reasoning behind human approval", async () => {
  const f = await fixture()
  model.chunks = [{ content: `<think>${allow}`, response_metadata: { finish_reason: "stop" } }]
  expect((await f.review()).card.status).toBe("pending")
})

it.each(["limit", "invalid-reasoning", "stream-error", "nonterminal-before-stop"])(
  "preserves bounded fail-closed review for %s",
  async (kind) => {
    const f = await fixture()
    model.chunks = [
      {
        content:
          kind === "limit"
            ? " ".repeat(8001) + allow
            : kind === "invalid-reasoning"
              ? `<think><think>${allow}`
              : allow,
        response_metadata: { finish_reason: kind === "nonterminal-before-stop" ? "length" : "stop" }
      }
    ]
    if (kind === "stream-error")
      model.afterChunk = () => {
        throw new Error("Fixture stream interrupted after apparent verdict")
      }
    if (kind === "nonterminal-before-stop")
      model.chunks.push({ content: "", response_metadata: { finish_reason: "stop" } })
    const { record, card } = await f.review()
    expect(record?.decision).toBe("ask")
    expect(card.status).toBe("pending")
    expect(f.store.effects(f.run.id)).toEqual([])
    expect(model.calls).toBe(1)
  }
)

it("preserves an explicit ask decision", async () => {
  const f = await fixture()
  model.chunks = [
    {
      content: JSON.stringify({ decision: "ask", reason: "需要核对目标。" }),
      response_metadata: { finish_reason: "stop" }
    }
  ]
  expect((await f.review()).record?.decision).toBe("ask")
  expect(model.calls).toBe(1)
})

it.each([
  '{"decision":"allow"|"ask","reason":"protocol alternatives are not JSON"}',
  `\`\`\`json\n${allow}\n\`\`\``,
  `Permission granted: ${allow}`,
  `${allow}\n${allow}`,
  JSON.stringify({ decision: "allow", reason: "unexpected fields", action: "execute" })
])("keeps malformed or wrapped review output behind human approval: %s", async (content) => {
  const f = await fixture()
  model.chunks = [{ content, response_metadata: { finish_reason: "stop" } }]
  const { record, card } = await f.review()
  expect(record?.decision).toBe("ask")
  expect(card.status).toBe("pending")
  expect(f.store.effects(f.run.id)).toEqual([])
})

it("preserves human cancellation instead of turning it into a pending approval", async () => {
  const f = await fixture()
  model.chunks = [{ content: allow, response_metadata: { finish_reason: "stop" } }]
  model.afterChunk = () => f.signal.abort(new Error("Fixture human cancellation"))
  await expect(f.reviewer.review(action)).rejects.toThrow()
  expect(f.store.effects(f.run.id)).toEqual([])
})
