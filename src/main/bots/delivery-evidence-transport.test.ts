import { afterEach, expect, it, vi } from "vitest"
import { createServer, type ServerResponse } from "node:http"
import { mkdtemp, rm } from "node:fs/promises"
import { join } from "node:path"
import { HumanMessage } from "@langchain/core/messages"
import { createConfiguredCmbModel } from "../models/model-factory"
import { BotStore } from "./store"
import { BotArtifacts } from "./artifacts"
import { botDeliverFileTool } from "./deliver-file-tool"
import { botDeliveryEvidenceReviewer } from "./delivery-evidence-review"
import { readBotModelSnapshot, writeBotModelSnapshot } from "./model-config"
import type { BotRuntimeRequest } from "./host"

const cleanup: (() => unknown | Promise<unknown>)[] = []
afterEach(async () => {
  for (const done of cleanup.splice(0).reverse()) await done()
  vi.restoreAllMocks()
})
const accepted = JSON.stringify({
  decision: "pass",
  finding: "原件与候选一致。"
})
const acceptedVerdict = { decision: "pass", findings: ["原件与候选一致。"] }
async function transport() {
  const requests: Record<string, unknown>[] = []
  const settings = {
    content: "",
    contentAfterTool: "",
    refusal: undefined as string | undefined,
    toolCall: true,
    toolName: "delivery_evidence_verdict",
    toolArguments: accepted,
    toolId: "call-verdict",
    toolIndex: 0,
    rawToolCall: undefined as unknown,
    leadingToolCalls: [] as unknown[],
    toolArgumentChunks: [] as string[],
    additionalToolCalls: [] as { index: number; id: string; name: string; arguments: string }[],
    finish: "stop" as string | null,
    trailing: [] as {
      content: string
      finish?: string | null
      toolCalls?: readonly unknown[]
      reasoningDetails?: unknown
    }[],
    done: true,
    output: 32,
    reasoning: 0,
    reasoningDetails: undefined as unknown,
    streamError: false,
    status: 200,
    onRequest: undefined as undefined | (() => Promise<void> | void)
  }
  const server = createServer(async (req, res: ServerResponse) => {
    const parts: Buffer[] = []
    for await (const part of req) parts.push(part)
    requests.push(JSON.parse(Buffer.concat(parts).toString()))
    await settings.onRequest?.()
    if (res.destroyed) return
    if (settings.status !== 200) {
      res.writeHead(settings.status, { "Content-Type": "application/json" })
      res.end(JSON.stringify({ error: { message: "PRIVATE_REVIEW_ERROR" } }))
      return
    }
    res.setHeader("Content-Type", "text/event-stream")
    const delta = (
      content: string,
      finish: string | null = null,
      toolCalls?: readonly unknown[],
      reasoningDetails = settings.reasoningDetails
    ) =>
      res.write(
        `data: ${JSON.stringify({ id: "fixture", object: "chat.completion.chunk", created: 1, model: "MiniMax-M3", choices: [{ index: 0, delta: { role: "assistant", content, ...(settings.refusal === undefined ? {} : { refusal: settings.refusal }), ...(reasoningDetails === undefined ? {} : { reasoning_details: reasoningDetails }), ...(toolCalls ? { tool_calls: toolCalls } : {}) }, finish_reason: finish }] })}\n\n`
      )
    // Actual SDK SSE parser and answer projection see many reasoning chunks.
    for (let offset = 0; offset < settings.content.length; offset += 127)
      delta(settings.content.slice(offset, offset + 127))
    for (const call of settings.leadingToolCalls) delta("", null, [call])
    if (settings.toolCall) {
      const chunks = settings.toolArgumentChunks.length
        ? settings.toolArgumentChunks
        : [settings.toolArguments]
      for (const [index, arguments_] of chunks.entries())
        delta("", null, [
          index === 0 && settings.rawToolCall !== undefined
            ? settings.rawToolCall
            : {
                index: settings.toolIndex,
                ...(index === 0 ? { id: settings.toolId, type: "function" } : {}),
                function: {
                  ...(index === 0 ? { name: settings.toolName } : {}),
                  arguments: arguments_
                }
              }
        ])
      for (const extra of settings.additionalToolCalls)
        delta("", null, [
          {
            index: extra.index,
            id: extra.id,
            type: "function",
            function: { name: extra.name, arguments: extra.arguments }
          }
        ])
    }
    if (settings.contentAfterTool) delta(settings.contentAfterTool)
    if (settings.streamError) {
      res.end(`data: ${JSON.stringify({ error: { message: "PRIVATE_REVIEW_ERROR" } })}\n\n`)
      return
    }
    delta("", settings.finish)
    for (const trailing of settings.trailing)
      delta(
        trailing.content,
        trailing.finish ?? null,
        trailing.toolCalls,
        trailing.reasoningDetails
      )
    res.write(
      `data: ${JSON.stringify({ choices: [], usage: { prompt_tokens: 100, completion_tokens: settings.output, completion_tokens_details: { reasoning_tokens: settings.reasoning } } })}\n\n`
    )
    res.end(settings.done ? "data: [DONE]\n\n" : "")
  })
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done))
  cleanup.push(
    () =>
      new Promise<void>((done) => {
        server.closeAllConnections()
        server.close(() => done())
      })
  )
  const address = server.address() as { port: number }
  const config = {
    id: "fixture",
    ref: "fixture",
    name: "Fixture",
    model: "MiniMax-M3",
    apiKey: "fixture-only",
    baseUrl: `http://127.0.0.1:${address.port}/v1`,
    maxOutputTokens: 16000
  }
  vi.spyOn(console, "info").mockImplementation(() => {})
  const logs = vi.spyOn(console, "log").mockImplementation(() => {})
  return { requests, settings, config, logs }
}
async function fixture(model = "MiniMax-M3", maxOutputTokens = 16000) {
  const http = await transport()
  Object.assign(http.config, { model, maxOutputTokens })
  const directory = await mkdtemp(join(process.cwd(), ".bot-review-"))
  cleanup.push(() => rm(directory, { recursive: true, force: true }))
  const store = new BotStore(join(directory, "bots.sqlite"))
  cleanup.push(() => store.close())
  const files = new BotArtifacts(join(directory, "objects"), store)
  cleanup.push(() => files.close())
  await files.recover()
  const { bot, conversationId } = store.createBot({
    nonce: "bot",
    name: "Review"
  })
  const source = await files.publish(
    {
      id: "source",
      conversationId,
      runId: null,
      name: "data.csv",
      mime: "text/csv"
    },
    Buffer.from("id,version,amount\nX,1,9\nX,2,3\n")
  )
  store.send({
    nonce: "send",
    conversationId,
    text: "按版本字段最大值核算，交付 result.csv（id、amount）。",
    attachments: [source.id]
  })
  const claim = store.claim("fixture", 300000)!
  const request: BotRuntimeRequest = {
    ...claim,
    store,
    bot,
    messages: store.messagesForRun(claim.run.id),
    signal: new AbortController().signal
  }
  const modelFile = join(directory, "models.private")
  await writeBotModelSnapshot(modelFile, {
    version: 1,
    defaultRef: "fixture",
    models: [http.config]
  })
  const snapshot = await readBotModelSnapshot(modelFile)
  const check = () => store.assertDispatch(claim.lease)
  const reviewer = botDeliveryEvidenceReviewer({
    request,
    files,
    modelFile,
    snapshot,
    config: snapshot.models[0],
    check
  })
  const tool = botDeliverFileTool(request, files, check, reviewer)
  const invoke = async (id = "delivery") =>
    JSON.parse(
      String(
        (
          await tool.invoke({
            type: "tool_call",
            name: "deliver_file",
            id,
            args: {
              name: "result.csv",
              content: "id,amount\nX,3\n"
            }
          })
        ).content
      )
    )
  return { ...http, store, files, claim, conversationId, modelFile, invoke }
}

function reviewVerdicts(f: Awaited<ReturnType<typeof fixture>>) {
  return f.store.db
    .exec("SELECT response FROM bot_receipts WHERE nonce LIKE ?", [
      `tool:${f.claim.run.id}:delivery-evidence:verdict:%`
    ])[0]
    .values.map(([value]) => JSON.parse(String(value)))
}

it.each([
  "unknown_finish",
  "pause_turn",
  "error",
  "cancelled",
  "safety",
  "FINISH_REASON_UNSPECIFIED"
])(
  "requires a recognized completion before publishing a valid pass verdict: %s",
  async (finish) => {
    const f = await fixture()
    f.settings.finish = finish
    const result = await f.invoke()
    expect({
      status: result.status,
      published: Boolean(result.id),
      artifacts: f.store.artifacts(f.conversationId).length,
      decision: reviewVerdicts(f)[0].decision
    }).toEqual({ status: "not_generated", published: false, artifacts: 1, decision: "uncertain" })
    expect(reviewVerdicts(f)[0]).toMatchObject({
      decision: "uncertain",
      diagnostic: { stage: "terminal", reason: "unsupported_finish", finish: "other" }
    })
    expect(f.store.artifacts(f.conversationId)).toHaveLength(1)
    f.settings.finish = "stop"
    expect((await f.invoke("retry-same-bytes")).status).toBe("not_generated")
    expect(f.requests).toHaveLength(1)
    expect(() => f.store.deliveryEvidence.assertCanContinue(f.claim.lease)).toThrow()
  }
)

it.each(["stop", "STOP", "end_turn", "stop_sequence", "tool_calls"])(
  "preserves recognized complete pass verdicts through the configured SDK: %s",
  async (finish) => {
    const f = await fixture()
    f.settings.finish = finish
    const result = await f.invoke()
    expect(result.id).toBeTruthy()
    expect(reviewVerdicts(f)).toEqual([acceptedVerdict])
    expect(f.store.artifacts(f.conversationId)).toHaveLength(2)
    expect(f.requests).toHaveLength(1)
    expect(f.requests[0]).toMatchObject({
      tools: [
        {
          type: "function",
          function: {
            name: "delivery_evidence_verdict",
            parameters: {
              type: "object",
              additionalProperties: false,
              required: ["decision", "finding"]
            }
          }
        }
      ],
      tool_choice: { type: "function", function: { name: "delivery_evidence_verdict" } },
      parallel_tool_calls: false,
      reasoning_split: true
    })
    expect(f.requests[0]).not.toHaveProperty("thinking")
    expect(f.requests[0]).not.toHaveProperty("response_format")
  }
)

it("accepts one verdict whose JSON arguments arrive in multiple tool-call chunks", async () => {
  const f = await fixture()
  f.settings.toolArgumentChunks = [accepted.slice(0, 18), accepted.slice(18)]
  expect((await f.invoke()).id).toBeTruthy()
  expect(reviewVerdicts(f)).toEqual([acceptedVerdict])
  expect(f.requests[0].tools).toHaveLength(1)
})

it("accepts a standard identity-only delta before the optional function through the real SDK", async () => {
  const f = await fixture()
  f.settings.leadingToolCalls = [{ index: 0, id: "call-verdict", type: "function" }]
  f.settings.toolArgumentChunks = [accepted.slice(0, 18), accepted.slice(18)]
  expect((await f.invoke()).id).toBeTruthy()
  expect(reviewVerdicts(f)).toEqual([acceptedVerdict])
  expect(f.requests).toHaveLength(1)
  expect(f.store.artifacts(f.conversationId)).toHaveLength(2)
})

it("withholds an identity-only stream that never supplies its function and verdict", async () => {
  const f = await fixture()
  f.settings.leadingToolCalls = [{ index: 0, id: "call-verdict", type: "function" }]
  f.settings.toolCall = false
  f.settings.finish = "tool_calls"
  expect((await f.invoke()).status).toBe("not_generated")
  expect(reviewVerdicts(f)[0].diagnostic).toEqual({
    stage: "projection",
    reason: "unexpected_tool_call",
    finish: "tool_call"
  })
  expect(f.requests).toHaveLength(1)
  expect(f.store.artifacts(f.conversationId)).toHaveLength(1)
})

it("bounds streamed verdict arguments before they can accumulate in the Host", async () => {
  const f = await fixture()
  const privateBody = "PRIVATE_TOOL_ARGUMENT_BODY"
  f.settings.toolArgumentChunks = Array.from(
    { length: 17 },
    () => privateBody + "x".repeat(1024 - privateBody.length)
  )
  expect((await f.invoke()).status).toBe("not_generated")
  expect(reviewVerdicts(f)[0].diagnostic).toEqual({
    stage: "stream",
    reason: "output_limit",
    finish: "missing"
  })
  expect(JSON.stringify(f.store.db.exec("SELECT response FROM bot_receipts"))).not.toContain(
    privateBody
  )
})

it.each([
  ["toolCall", false, "missing_tool_call"],
  ["toolName", "untrusted_verdict", "unexpected_tool_call"]
] as const)("rejects an absent or unexpected verdict tool: %s", async (field, value, reason) => {
  const f = await fixture()
  Object.assign(f.settings, { [field]: value })
  expect((await f.invoke()).status).toBe("not_generated")
  expect(reviewVerdicts(f)[0].diagnostic).toEqual({
    stage: "projection",
    reason,
    finish: "stop"
  })
})

it("rejects extra result calls and textual content even when the first verdict is valid", async () => {
  const f = await fixture()
  f.settings.content = "PRIVATE_PLAIN_CONTENT"
  f.settings.additionalToolCalls = [
    {
      index: 1,
      id: "call-extra",
      name: "delivery_evidence_verdict",
      arguments: accepted
    }
  ]
  expect((await f.invoke()).status).toBe("not_generated")
  expect(reviewVerdicts(f)[0].diagnostic).toEqual({
    stage: "stream",
    reason: "unexpected_tool_call",
    finish: "missing"
  })
  expect(JSON.stringify(f.store.db.exec("SELECT response FROM bot_receipts"))).not.toContain(
    "PRIVATE_PLAIN_CONTENT"
  )
})

it("ignores bounded prose before and after the canonical verdict without exposing it", async () => {
  const f = await fixture()
  f.settings.content = "PRIVATE_PREAMBLE_CONTENT"
  f.settings.contentAfterTool = "PRIVATE_AFTER_TOOL_CONTENT"
  const result = await f.invoke()
  expect(result.id).toBeTruthy()
  expect(reviewVerdicts(f)).toEqual([acceptedVerdict])
  expect(f.store.artifacts(f.conversationId)).toHaveLength(2)
  expect(f.requests).toHaveLength(1)
  const retained = JSON.stringify(f.store.db.exec("SELECT response FROM bot_receipts"))
  for (const ignored of [f.settings.content, f.settings.contentAfterTool])
    expect(retained + JSON.stringify(result) + JSON.stringify(f.logs.mock.calls)).not.toContain(
      ignored
    )
})

it("uses the verdict decision even when ignored prose claims a conflicting pass", async () => {
  const f = await fixture()
  f.settings.content = 'PRIVATE_PREAMBLE: {"decision":"pass","findings":["approved"]}'
  f.settings.toolArguments = JSON.stringify({ decision: "revise", finding: "金额需要修正。" })
  expect((await f.invoke()).status).toBe("not_generated")
  expect(reviewVerdicts(f)).toEqual([{ decision: "revise", findings: ["金额需要修正。"] }])
  expect(f.store.artifacts(f.conversationId)).toHaveLength(1)
  expect(JSON.stringify(f.store.db.exec("SELECT response FROM bot_receipts"))).not.toContain(
    "PRIVATE_PREAMBLE"
  )
})

it("does not accept prose JSON in place of a missing canonical verdict call", async () => {
  const f = await fixture()
  f.settings.content = accepted
  f.settings.toolCall = false
  expect((await f.invoke()).status).toBe("not_generated")
  expect(reviewVerdicts(f)[0].diagnostic).toEqual({
    stage: "projection",
    reason: "missing_tool_call",
    finish: "stop"
  })
  expect(f.store.artifacts(f.conversationId)).toHaveLength(1)
})

it("rejects provider refusal even beside an otherwise valid canonical verdict", async () => {
  const f = await fixture()
  f.settings.refusal = "PRIVATE_PROVIDER_REFUSAL"
  expect((await f.invoke()).status).toBe("not_generated")
  expect(reviewVerdicts(f)[0].diagnostic).toEqual({
    stage: "stream",
    reason: "refusal",
    finish: "missing"
  })
  expect(f.store.artifacts(f.conversationId)).toHaveLength(1)
  expect(JSON.stringify(f.store.db.exec("SELECT response FROM bot_receipts"))).not.toContain(
    f.settings.refusal
  )
})

it("accepts split MiniMax reasoning beside the forced verdict without accepting content", async () => {
  const f = await fixture()
  f.settings.reasoningDetails = [{ type: "reasoning", text: "PRIVATE_REVIEW_REASONING" }]
  const result = await f.invoke()
  expect(result.id).toBeTruthy()
  expect(reviewVerdicts(f)).toEqual([acceptedVerdict])
  expect(f.requests[0]).toMatchObject({
    reasoning_split: true,
    parallel_tool_calls: false
  })
  expect(f.requests[0]).not.toHaveProperty("thinking")
  expect(JSON.stringify(f.store.db.exec("SELECT response FROM bot_receipts"))).not.toContain(
    "PRIVATE_REVIEW_REASONING"
  )
})

it.each([
  ["text", { content: "PRIVATE_AFTER_TERMINAL" }],
  [
    "second tool",
    {
      content: "",
      toolCalls: [
        {
          index: 1,
          id: "call-after-terminal",
          type: "function",
          function: { name: "delivery_evidence_verdict", arguments: accepted }
        }
      ]
    }
  ],
  [
    "split reasoning",
    {
      content: "",
      reasoningDetails: [{ type: "reasoning", text: "PRIVATE_AFTER_TERMINAL_REASONING" }]
    }
  ],
  ["second terminal", { content: "", finish: "stop" }]
] as const)("rejects %s payload after the terminal frame", async (_label, trailing) => {
  const f = await fixture()
  f.settings.trailing = [trailing]
  expect((await f.invoke()).status).toBe("not_generated")
  expect(reviewVerdicts(f)[0].diagnostic).toEqual({
    stage: "stream",
    reason: "invalid_stream_order",
    finish: "stop"
  })
  expect(JSON.stringify(f.store.db.exec("SELECT response FROM bot_receipts"))).not.toContain(
    "PRIVATE_AFTER_TERMINAL"
  )
})

it.each([
  [
    "name",
    { index: 0, id: "call-verdict", type: "function", function: { name: 7, arguments: accepted } }
  ],
  [
    "id",
    {
      index: 0,
      id: 7,
      type: "function",
      function: { name: "delivery_evidence_verdict", arguments: accepted }
    }
  ],
  [
    "index",
    {
      index: "0",
      id: "call-verdict",
      type: "function",
      function: { name: "delivery_evidence_verdict", arguments: accepted }
    }
  ],
  [
    "arguments",
    {
      index: 0,
      id: "call-verdict",
      type: "function",
      function: { name: "delivery_evidence_verdict", arguments: 7 }
    }
  ],
  [
    "raw type",
    {
      index: 0,
      id: "call-verdict",
      type: "custom",
      function: { name: "delivery_evidence_verdict", arguments: accepted }
    }
  ],
  [
    "negative raw index",
    {
      index: -1,
      id: "call-verdict",
      type: "function",
      function: { name: "delivery_evidence_verdict", arguments: accepted }
    }
  ],
  [
    "fractional raw index",
    {
      index: 0.5,
      id: "call-verdict",
      type: "function",
      function: { name: "delivery_evidence_verdict", arguments: accepted }
    }
  ]
] as const)("rejects malformed raw verdict tool fragment: %s", async (_field, rawToolCall) => {
  const f = await fixture()
  f.settings.rawToolCall = rawToolCall
  expect((await f.invoke()).status).toBe("not_generated")
  expect(reviewVerdicts(f)[0].diagnostic).toEqual({
    stage: "stream",
    reason: "invalid_tool_call",
    finish: "missing",
    toolCall: {
      source: "raw",
      field: _field.endsWith("index") ? "index" : _field === "raw type" ? "type" : _field,
      ...(_field === "raw type" ? { typeClass: "non_function" } : {}),
      valueType: _field === "raw type" || _field === "index" ? "string" : "number"
    }
  })
})

it.each([
  ["tool_call", "normalized_tool_call"],
  ["PRIVATE_PROVIDER_TYPE", "non_function"]
] as const)(
  "classifies a rejected provider type without retaining it or weakening validation: %s",
  async (type, typeClass) => {
    const f = await fixture()
    f.settings.rawToolCall = {
      index: 0,
      id: "call-verdict",
      type,
      function: { name: "delivery_evidence_verdict", arguments: accepted }
    }
    expect((await f.invoke()).status).toBe("not_generated")
    expect(reviewVerdicts(f)[0].diagnostic).toMatchObject({
      reason: "invalid_tool_call",
      toolCall: { source: "raw", field: "type", valueType: "string", typeClass }
    })
    expect(f.requests).toHaveLength(1)
    expect(JSON.stringify(f.store.db.exec("SELECT response FROM bot_receipts"))).not.toContain(
      "PRIVATE_PROVIDER_TYPE"
    )
  }
)

it("accepts an empty provider type only with the exact single verdict identity", async () => {
  const f = await fixture()
  f.settings.rawToolCall = {
    index: 0,
    id: "call-verdict",
    type: "",
    function: { name: "delivery_evidence_verdict", arguments: accepted }
  }
  expect((await f.invoke()).id).toBeTruthy()
  expect(reviewVerdicts(f)).toEqual([acceptedVerdict])
  expect(f.requests).toHaveLength(1)
})

it("accepts an empty-type continuation after an established verdict, without changing its identity", async () => {
  const f = await fixture()
  f.settings.leadingToolCalls = [
    {
      index: 0,
      id: "call-verdict",
      type: "function",
      function: { name: "delivery_evidence_verdict" }
    }
  ]
  f.settings.rawToolCall = { index: 0, type: "", function: { arguments: accepted } }
  expect((await f.invoke()).id).toBeTruthy()
  expect(reviewVerdicts(f)).toEqual([acceptedVerdict])
})

it("accepts M3 empty identity placeholders after the exact verdict identity through the real SDK", async () => {
  const f = await fixture()
  f.settings.leadingToolCalls = [
    {
      index: 0,
      id: "call-verdict",
      type: "function",
      function: { name: "delivery_evidence_verdict" }
    }
  ]
  f.settings.rawToolCall = {
    index: 0,
    id: "",
    type: "",
    function: { name: "", arguments: accepted }
  }
  expect((await f.invoke()).id).toBeTruthy()
  expect(reviewVerdicts(f)).toEqual([acceptedVerdict])
  expect(f.requests).toHaveLength(1)
})

it("buffers M3 argument fragments until the exact verdict identity arrives, without publishing early", async () => {
  const f = await fixture()
  f.settings.leadingToolCalls = [
    {
      index: 0,
      id: "",
      type: "",
      function: { name: "", arguments: accepted.slice(0, 18) }
    }
  ]
  f.settings.rawToolCall = {
    index: 0,
    id: "call-verdict",
    type: "function",
    function: { name: "delivery_evidence_verdict", arguments: accepted.slice(18) }
  }
  expect((await f.invoke()).id).toBeTruthy()
  expect(reviewVerdicts(f)).toEqual([acceptedVerdict])
  expect(f.requests).toHaveLength(1)
  expect(f.store.artifacts(f.conversationId)).toHaveLength(2)
})

it.each([
  { index: 0, type: "", function: { arguments: accepted } },
  {
    index: 0,
    id: "",
    type: "",
    function: { name: "delivery_evidence_verdict", arguments: accepted }
  }
])(
  "withholds incomplete M3 identities at the terminal even with valid verdict arguments (%#)",
  async (call) => {
    const f = await fixture()
    f.settings.rawToolCall = call
    expect((await f.invoke()).status).toBe("not_generated")
    expect(reviewVerdicts(f)[0].diagnostic).toMatchObject({
      reason: "missing_tool_call"
    })
    expect(f.requests).toHaveLength(1)
    expect(f.store.artifacts(f.conversationId)).toHaveLength(1)
  }
)

it.each([
  {
    index: 1,
    id: "call-verdict",
    type: "",
    function: { name: "delivery_evidence_verdict", arguments: accepted }
  },
  {
    index: 0,
    id: "call-verdict",
    type: "",
    function: { name: "unrelated_tool", arguments: accepted }
  }
])("rejects a changed empty-type verdict (%#)", async (call) => {
  const f = await fixture()
  f.settings.rawToolCall = call
  expect((await f.invoke()).status).toBe("not_generated")
  expect(reviewVerdicts(f)[0].diagnostic).toMatchObject({
    reason: "invalid_tool_call",
    toolCall: { source: "raw", field: "type", typeClass: "empty" }
  })
  expect(f.store.artifacts(f.conversationId)).toHaveLength(1)
})

it.each(["MiniMax-M2", "MiniMax-M3.1", "other-provider"])(
  "does not infer an identity from empty optional markers for %s",
  async (model) => {
    const f = await fixture(model)
    f.settings.leadingToolCalls = [
      { index: 0, id: "", type: "", function: { name: "", arguments: "" } }
    ]
    expect((await f.invoke()).status).toBe("not_generated")
    expect(reviewVerdicts(f)[0].diagnostic).toMatchObject({
      reason: "invalid_tool_call",
      toolCall: { source: "raw", field: "type", typeClass: "empty" }
    })
    expect(f.requests).toHaveLength(1)
    expect(f.store.artifacts(f.conversationId)).toHaveLength(1)
  }
)

it("rejects a changed id in an empty-type continuation", async () => {
  const f = await fixture()
  f.settings.leadingToolCalls = [
    {
      index: 0,
      id: "original-id",
      type: "function",
      function: { name: "delivery_evidence_verdict" }
    }
  ]
  f.settings.rawToolCall = {
    index: 0,
    id: "replacement-id",
    type: "",
    function: { arguments: accepted }
  }
  expect((await f.invoke()).status).toBe("not_generated")
  expect(f.store.artifacts(f.conversationId)).toHaveLength(1)
})

it("requires the single verdict tool call to use index zero", async () => {
  const f = await fixture()
  f.settings.toolIndex = 1
  expect((await f.invoke()).status).toBe("not_generated")
  expect(reviewVerdicts(f)[0].diagnostic).toEqual({
    stage: "projection",
    reason: "invalid_tool_call",
    finish: "stop",
    toolCall: { source: "terminal", field: "index", valueType: "number" }
  })
})

it.each([
  ["empty call", {}, "call", "object"],
  ["null function", { index: 0, function: null }, "function", "null"],
  ["array function", { index: 0, function: [] }, "function", "array"],
  ["string function", { index: 0, function: "PRIVATE_SHAPE_VALUE" }, "function", "string"],
  ["null name", { index: 0, function: { name: null, arguments: accepted } }, "name", "null"],
  ["null id", { index: 0, id: null, function: { arguments: accepted } }, "id", "null"],
  ["null type", { index: 0, type: null, function: { arguments: accepted } }, "type", "null"],
  ["null index", { index: null, function: { arguments: accepted } }, "index", "null"],
  ["null arguments", { index: 0, function: { arguments: null } }, "arguments", "null"]
] as const)(
  "records only closed shape labels for invalid raw %s",
  async (_name, rawToolCall, field, valueType) => {
    const f = await fixture()
    f.settings.rawToolCall = rawToolCall
    expect((await f.invoke()).status).toBe("not_generated")
    expect(reviewVerdicts(f)[0].diagnostic).toEqual({
      stage: "stream",
      reason: "invalid_tool_call",
      finish: "missing",
      toolCall: { source: "raw", field, valueType }
    })
    expect(f.requests).toHaveLength(1)
    expect(f.store.artifacts(f.conversationId)).toHaveLength(1)
    expect(JSON.stringify(f.store.db.exec("SELECT response FROM bot_receipts"))).not.toContain(
      "PRIVATE_SHAPE_VALUE"
    )
  }
)

it.each([
  ["toolArguments", "{PRIVATE_REVIEW_BODY", "stop", "json", "invalid_json", "stop"],
  ["toolArguments", "```json\n" + accepted + "\n```", "stop", "json", "invalid_json", "stop"],
  [
    "toolArguments",
    JSON.stringify({ decision: "pass", finding: "ok", extra: "PRIVATE_REVIEW_BODY" }),
    "stop",
    "schema",
    "invalid_schema",
    "stop"
  ],
  ["toolArguments", accepted, null, "terminal", "missing_finish", "missing"],
  ["toolArguments", accepted, "length", "terminal", "truncated_finish", "truncated"],
  ["toolArguments", accepted, "content_filter", "stream", "refusal", "missing"],
  ["content", "<think>PRIVATE_REVIEW_BODY", "stop", "projection", "reasoning_incomplete", "stop"],
  [
    "content",
    "<think><think>PRIVATE_REVIEW_BODY",
    "stop",
    "projection",
    "reasoning_invalid",
    "missing"
  ],
  ["content", " ".repeat(4100), "stop", "projection", "output_limit", "missing"],
  [
    "toolArguments",
    "{PRIVATE_REVIEW_BODY",
    "PRIVATE_FINISH_REASON",
    "terminal",
    "unsupported_finish",
    "other"
  ]
] as const)(
  "records closed diagnostics for rejected response %# without changing publication or retry policy",
  async (field, value, finish, stage, reason, terminal) => {
    const f = await fixture()
    Object.assign(f.settings, { [field]: value, finish })
    const first = await f.invoke()
    expect(first.status).toBe("not_generated")
    expect(reviewVerdicts(f)).toEqual([
      {
        decision: "uncertain",
        findings: ["独立原件核验未返回有效结论，未发布该候选文件。"],
        diagnostic: {
          stage,
          reason,
          finish: terminal,
          ...(stage === "schema"
            ? {
                schemaIssues: ["object"],
                schemaShape: {
                  findingType: "string"
                }
              }
            : {})
        }
      }
    ])
    // Same exact candidate replays its original failure, even if the next
    // provider response would pass. Diagnostics are not a second review loop.
    f.settings.content = ""
    f.settings.toolArguments = accepted
    f.settings.finish = "stop"
    expect((await f.invoke("retry-same-bytes")).status).toBe("not_generated")
    expect(f.requests).toHaveLength(1)
    expect(f.store.artifacts(f.conversationId)).toHaveLength(1)
    const durable = JSON.stringify(f.store.db.exec("SELECT response FROM bot_receipts"))
    for (const secret of ["PRIVATE_REVIEW_BODY", "PRIVATE_FINISH_REASON"])
      expect(durable + JSON.stringify(f.logs.mock.calls)).not.toContain(secret)
  }
)

it.each([
  [
    { decision: "revise", finding: ["PRIVATE_FINDING_BODY"] },
    ["finding_format"],
    { findingType: "array" }
  ],
  [
    { decision: "revise", finding: { PRIVATE_FINDING_KEY: "PRIVATE_FINDING_BODY" } },
    ["finding_format"],
    { findingType: "object" }
  ],
  [{ decision: "pass", finding: " " }, ["finding_size"], { findingType: "empty_string" }],
  [
    { decision: "revise", finding: "PRIVATE_FINDING_BODY".repeat(40) },
    ["finding_size"],
    { findingType: "string" }
  ],
  [
    { decision: "pass", findings: ["PRIVATE_FINDING_BODY"] },
    ["finding_format", "object"],
    { findingType: "missing" }
  ]
] as const)(
  "keeps invalid verdict diagnostics closed and unpublished (%#)",
  async (body, issues, shape) => {
    const f = await fixture()
    f.settings.toolArguments = JSON.stringify(body)
    expect((await f.invoke()).status).toBe("not_generated")
    expect(reviewVerdicts(f)[0].diagnostic).toEqual({
      stage: "schema",
      reason: "invalid_schema",
      finish: "stop",
      schemaIssues: issues,
      schemaShape: shape
    })
    expect(f.requests).toHaveLength(1)
    expect(f.store.artifacts(f.conversationId)).toHaveLength(1)
    const durable = JSON.stringify(f.store.db.exec("SELECT response FROM bot_receipts"))
    expect(durable + JSON.stringify(f.logs.mock.calls)).not.toContain("PRIVATE_FINDING")
  }
)

it.each([
  [503, false, "dispatch", "dispatch_failed"],
  [200, true, "stream", "stream_failed"]
] as const)(
  "distinguishes HTTP admission and iterator failures (%s, %s)",
  async (status, streamError, stage, reason) => {
    const f = await fixture()
    Object.assign(f.settings, { status, streamError })
    expect((await f.invoke()).status).toBe("not_generated")
    expect(reviewVerdicts(f)[0].diagnostic).toEqual({ stage, reason, finish: "missing" })
    expect(f.requests).toHaveLength(1)
    expect(f.store.artifacts(f.conversationId)).toHaveLength(1)
    expect(JSON.stringify(f.store.db.exec("SELECT response FROM bot_receipts"))).not.toContain(
      "PRIVATE_REVIEW_ERROR"
    )
  }
)

it("does not add host failure diagnostics to a valid model uncertainty or accepted verdict", async () => {
  const f = await fixture()
  f.settings.toolArguments = JSON.stringify({ decision: "uncertain", finding: "证据不足。" })
  expect((await f.invoke()).status).toBe("not_generated")
  expect(reviewVerdicts(f)).toEqual([{ decision: "uncertain", findings: ["证据不足。"] }])
  expect(f.requests).toHaveLength(1)
})

it.each([
  ["MiniMax-M3", "function-completion", false, "disabled"],
  ["minimax-m3", "function-completion", true, "disabled"],
  ["MiniMaxAI/MiniMax-M3", "function-completion", false, "disabled"],
  ["MiniMax-M3", "agent", true, "enabled"],
  ["MiniMax-M3", "agent", false, undefined],
  ["MiniMax-M3", "evidence-review", false, undefined],
  ["MiniMax-M3", "evidence-review", true, "enabled"],
  ["MiniMax-M3", "operation-review", false, undefined],
  ["MiniMax-M3", "operation-review", true, "enabled"],
  ["MiniMax-M2.7", "operation-review", true, "enabled"],
  ["MiniMax-M2.7", "evidence-review", true, "enabled"],
  ["MiniMax-M3", "context-compaction", false, "disabled"],
  ["MiniMaxAI/MiniMax-M3", "context-compaction", true, "disabled"],
  ["MiniMax-M2.7", "context-compaction", false, undefined],
  ["MiniMax-M3.1-Flash-Preview", "context-compaction", false, undefined],
  ["MiniMax-M2.7", "function-completion", false, undefined],
  ["MiniMax-M3.1-Flash-Preview", "function-completion", false, undefined],
  ["MiniMax-M3-unverified-alias", "function-completion", false, undefined],
  ["not-minimax-m3", "function-completion", false, undefined]
] as const)(
  "sends documented thinking control only for %s / %s / thinking=%s",
  async (name, purpose, enabled, expected) => {
    const f = await transport()
    const model = createConfiguredCmbModel(
      { ...f.config, model: name, enableThinking: enabled },
      { fetch, purpose }
    )
    for await (const chunk of await model.stream([new HumanMessage("Return one JSON verdict")])) {
      expect(chunk).toBeDefined()
    }
    expect(f.requests).toHaveLength(1)
    expect(f.requests[0].thinking).toEqual(expected ? { type: expected } : undefined)
  }
)

it.each([
  ["MiniMax-M3", true],
  ["MiniMaxAI/MiniMax-M3", true],
  ["MiniMax-M3.1-Flash-Preview", false],
  ["MiniMax-M2.7", false],
  ["not-minimax-m3", false]
] as const)("sends split reasoning only for exact M3: %s", async (name, expected) => {
  const f = await transport()
  const model = createConfiguredCmbModel(
    { ...f.config, model: name },
    { fetch, purpose: "function-completion", splitMiniMaxM3Reasoning: true }
  )
  for await (const chunk of await model.stream([new HumanMessage("Return one JSON verdict")]))
    expect(chunk).toBeDefined()
  expect(f.requests).toHaveLength(1)
  expect(f.requests[0].reasoning_split).toBe(expected ? true : undefined)
})

it("accepts a bounded long reasoning stream followed by a small verdict without exposing reasoning", async () => {
  const f = await fixture()
  const timeouts = vi.spyOn(AbortSignal, "timeout")
  const hidden = "PRIVATE_REVIEW_THOUGHT_".repeat(1200)
  f.settings.content = `<think>${hidden}</think>`
  f.settings.output = 5000
  f.settings.reasoning = 4968
  const result = await f.invoke()
  expect(result.id).toBeTruthy()
  expect(reviewVerdicts(f)).toEqual([acceptedVerdict])
  expect(f.requests).toHaveLength(1)
  expect(f.requests[0]).toMatchObject({
    max_tokens: 8192
  })
  expect(f.requests[0]).not.toHaveProperty("thinking")
  expect(timeouts).toHaveBeenCalledWith(90000)
  expect(f.store.usageBudgets.view({ botId: null }).usage).toMatchObject({
    requests: 1,
    unknownRequests: 0,
    outputTokens: 5000
  })
  expect(JSON.stringify(result)).not.toContain("PRIVATE_REVIEW_THOUGHT")
  expect(JSON.stringify(f.logs.mock.calls)).not.toContain("PRIVATE_REVIEW_THOUGHT")
  expect(JSON.stringify(f.store.messages(f.conversationId))).not.toContain("PRIVATE_REVIEW_THOUGHT")
  expect(JSON.stringify(f.store.db.exec("SELECT response FROM bot_receipts"))).not.toContain(
    "PRIVATE_REVIEW_THOUGHT"
  )
})

it("preserves the user's lower token ceiling and rejects truncated reasoning without releasing unknown usage", async () => {
  const f = await fixture("MiniMax-M3", 1024)
  f.settings.content = "<think>unfinished"
  f.settings.finish = "length"
  f.settings.done = false
  f.settings.output = 1024
  f.settings.reasoning = 1024
  expect((await f.invoke()).status).toBe("not_generated")
  expect(f.requests).toHaveLength(1)
  expect(f.requests[0].max_tokens).toBe(1024)
  expect(f.store.usageBudgets.view({ botId: null }).usage).toMatchObject({
    requests: 1,
    unknownRequests: 1,
    reservedOutputTokens: 1024
  })
  expect(f.store.artifacts(f.conversationId)).toHaveLength(1)
  expect(() => f.store.deliveryEvidence.assertCanContinue(f.claim.lease)).toThrow()
})

it("refuses dispatch when the formal user budget is exhausted", async () => {
  const f = await fixture()
  const budget = f.store.usageBudgets.view({ botId: null })
  f.store.usageBudgets.change({
    botId: null,
    nonce: "no-budget",
    dataEpoch: budget.dataEpoch,
    revision: budget.revision,
    outputLimit: 0
  })
  await expect(f.invoke()).rejects.toMatchObject({
    code: "model_usage_budget"
  })
  expect(f.requests).toHaveLength(0)
  expect(f.store.usageBudgets.view({ botId: null }).usage.requests).toBe(0)
  expect(f.store.artifacts(f.conversationId)).toHaveLength(1)
})

it("rejects publication if the selected model changes while HTTP is in flight but settles its completed usage", async () => {
  const f = await fixture()
  f.settings.onRequest = () =>
    writeBotModelSnapshot(f.modelFile, {
      version: 1,
      defaultRef: "fixture",
      models: [{ ...f.config, model: "different-model" }]
    })
  await expect(f.invoke()).rejects.toMatchObject({
    code: "delivery_evidence_review"
  })
  expect(f.requests).toHaveLength(1)
  expect(f.store.artifacts(f.conversationId)).toHaveLength(1)
  expect(f.store.usageBudgets.view({ botId: null }).usage).toMatchObject({
    requests: 1,
    unknownRequests: 0,
    outputTokens: 32
  })
})

it("keeps the 90-second deadline and retains an interrupted reservation without retry", async () => {
  const f = await fixture()
  const deadline = new AbortController()
  const timeouts = vi.spyOn(AbortSignal, "timeout").mockReturnValue(deadline.signal)
  f.settings.onRequest = () => {
    deadline.abort(new DOMException("Fixture deadline", "TimeoutError"))
  }
  const result = await f.invoke()
  expect(timeouts).toHaveBeenCalledWith(90000)
  expect(result.status).toBe("not_generated")
  expect(result.errors).toContain("独立原件核验超时，未发布该候选文件。")
  expect(reviewVerdicts(f)[0].diagnostic).toEqual({
    stage: "dispatch",
    reason: "timeout",
    finish: "missing"
  })
  expect(f.requests).toHaveLength(1)
  expect(f.store.usageBudgets.view({ botId: null }).usage).toMatchObject({
    requests: 1,
    unknownRequests: 1,
    reservedOutputTokens: 8192
  })
})

it.each([
  ["MiniMax-M3", "<think>" + "R".repeat(66000) + "</think>" + accepted],
  ["MiniMax-M3", " ".repeat(4100) + accepted],
  ["other-model", "<think>" + "R".repeat(17000) + "</think>" + accepted]
])("keeps provider and visible answer bounds for %s", async (model, content) => {
  const f = await fixture(model)
  const timeouts = vi.spyOn(AbortSignal, "timeout")
  f.settings.content = content
  expect((await f.invoke()).status).toBe("not_generated")
  expect(f.store.artifacts(f.conversationId)).toHaveLength(1)
  expect(f.requests[0].max_tokens).toBe(model === "other-model" ? 2048 : 8192)
  expect(timeouts).toHaveBeenCalledWith(model === "other-model" ? 20000 : 90000)
})
