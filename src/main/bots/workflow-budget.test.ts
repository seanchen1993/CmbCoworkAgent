import { afterEach, expect, it, vi } from "vitest"
import { createConfiguredCmbModel } from "../models/model-factory"
import { BotStore } from "./store"
import { BotWorkflowStore } from "./workflow-store"
import { botWorkflowModelFetch } from "./workflow-budget"
import { botModelUsage } from "./model-usage"
import type { BotRuntimeRequest } from "./host"
import { BotDomainError } from "../../shared/bot-types"

const stores: BotStore[] = []
afterEach(() => {
  vi.restoreAllMocks()
  for (const store of stores.splice(0)) store.close()
})
const config = {
  id: "test",
  model: "gpt-test",
  apiKey: "test",
  baseUrl: "https://unused.invalid",
  maxOutputTokens: 100
}
function fixture(limit = 100) {
  const store = new BotStore(":memory:")
  stores.push(store)
  const { bot, conversationId } = store.createBot({ nonce: "bot", name: "Owner" })
  store.send({ nonce: "task", conversationId, text: "Review" })
  const parent = store.claim("host")!
  const definition = {
    script: 'export const meta={name:"Review",description:"Review"}; return "ok";',
    maxConcurrency: 2,
    defaultModelId: "test",
    agentProfiles: [],
    authority: {},
    tokenBudget: limit
  }
  let seq = 0
  const child = (invocation = "wf") => {
    const workflow = BotWorkflowStore.open(store, parent.lease, invocation, definition)
    const claim = store.workflowChildren.claim(workflow, parent.lease, {
      prompt: "Review",
      agentIndex: ++seq,
      label: "Review",
      phase: null,
      toolStreamKey: `${"a".repeat(64)}_c${seq}`,
      durableCallKey: `${"a".repeat(64)}_n${seq}`
    })
    return {
      store,
      bot,
      run: claim.run,
      lease: claim.lease!,
      messages: [],
      signal: new AbortController().signal
    } satisfies BotRuntimeRequest
  }
  const parentRequest: BotRuntimeRequest = {
    store,
    bot,
    ...parent,
    messages: [],
    signal: new AbortController().signal
  }
  return { store, child, parent, parentRequest }
}
const usageResponse = (tokens: number, done = true) =>
  new Response(
    `data: ${JSON.stringify({ choices: [], usage: { completion_tokens: tokens } })}\r\n\r\n${done ? "data: [DONE]\r\n\r\n" : ""}`,
    { headers: { "content-type": "text/event-stream" } }
  )
const request = {
  method: "POST",
  body: JSON.stringify({ model: "gpt-test", stream: true, max_tokens: 100 })
}

it("awaits authority before every HTTP attempt and still settles an already-started model after revocation", async () => {
  vi.spyOn(console, "info").mockImplementation(() => {})
  const f = fixture()
  let release!: () => void
  const gate = new Promise<void>((done) => {
    release = done
  })
  let revoked = false
  const current = vi.fn(async () => {
    await gate
    if (revoked) throw new BotDomainError("harness_context_changed", "Project authority revoked")
  })
  const send = vi.fn<typeof fetch>(async () => usageResponse(10))
  const metered = botWorkflowModelFetch(f.parentRequest, config, send, current)
  const pending = metered("https://unused.invalid", request)
  await Promise.resolve()
  expect(send).not.toHaveBeenCalled()
  expect(f.store.db.exec("SELECT COUNT(*) FROM bot_workflow_model_calls")[0].values[0][0]).toBe(0)
  release()
  const response = await pending
  revoked = true
  await expect(metered("https://unused.invalid", request)).rejects.toMatchObject({
    code: "harness_context_changed"
  })
  expect(current).toHaveBeenCalledTimes(2)
  expect(send).toHaveBeenCalledTimes(1)
  await response.text()
  expect(f.store.db.exec("SELECT consumed FROM bot_workflow_model_calls")[0].values).toEqual([[10]])
  expect(botModelUsage(f.store, { rootRunId: f.parent.run.id })).toMatchObject({
    outputTokens: 10
  })
})

it("enforces the rolling user allowance before concurrent parent and child HTTP requests", async () => {
  const diagnostics = vi.spyOn(console, "info").mockImplementation(() => {})
  const f = fixture(1000),
    child = f.child()
  const policy = f.store.usageBudgets.view({ botId: null })
  f.store.usageBudgets.change({
    botId: null,
    dataEpoch: policy.dataEpoch,
    nonce: "limit",
    revision: 0,
    outputLimit: 150
  })
  const limits: number[] = []
  const send: typeof fetch = async (_url, init) => {
    limits.push(JSON.parse(String(init?.body)).max_tokens)
    return usageResponse(10)
  }
  const parent = botWorkflowModelFetch(f.parentRequest, config, send)
  const delegate = botWorkflowModelFetch(child, config, send)
  const responses = await Promise.all([
    parent("https://unused.invalid", request),
    delegate("https://unused.invalid", request)
  ])
  expect(limits).toEqual([100, 50])
  await expect(parent("https://unused.invalid", request)).rejects.toMatchObject({
    code: "model_usage_budget"
  })
  expect(limits).toHaveLength(2)
  expect(f.store.usageBudgets.view({ botId: null }).usage).toMatchObject({
    requests: 2,
    reservedOutputTokens: 150
  })
  await Promise.all(responses.map((response) => response.text()))
  expect(f.store.usageBudgets.view({ botId: null }).available).toBe(130)
  expect(f.store.db.exec("SELECT COUNT(*) FROM bot_workflow_model_calls")[0].values[0][0]).toBe(2)
  const traces = diagnostics.mock.calls
    .filter(([tag]) => tag === "[BotModelCall]")
    .map(([, value]) => value)
  const rows = f.store.db.exec("SELECT id,run_id FROM bot_model_usage ORDER BY rowid")[0].values
  expect(traces.filter((value) => value.phase === "started")).toHaveLength(2)
  for (const [callId, runId] of rows)
    expect(traces).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          callId,
          runId,
          botId: f.parentRequest.bot.id,
          rootRunId: f.parent.run.id,
          phase: "stream_ended",
          outputTokensReported: 10
        })
      ])
    )
})

it("reserves before HTTP and holds concurrent attempts within one shared workflow limit", async () => {
  const f = fixture(),
    child = f.child()
  let sent = 0,
    finish: (() => void) | undefined
  const send: typeof fetch = async (_url, init) => {
    sent++
    expect(JSON.parse(String(init?.body)).max_tokens).toBe(100)
    await new Promise<void>((done) => {
      finish = done
    })
    return usageResponse(12)
  }
  const metered = botWorkflowModelFetch(child, config, send)
  const pending = metered("https://unused.invalid", request)
  await expect(metered("https://unused.invalid", request)).rejects.toThrow("共享输出预算已用尽")
  expect(sent).toBe(1)
  finish!()
  await (await pending).text()
  const ceilings: number[] = []
  const next = botWorkflowModelFetch(child, config, async (_url, init) => {
    ceilings.push(JSON.parse(String(init?.body)).max_tokens)
    return usageResponse(8)
  })
  await (await next("https://unused.invalid", request)).text()
  expect(ceilings).toEqual([88])
  expect(
    f.store.db.exec("SELECT consumed FROM bot_workflow_model_calls ORDER BY rowid")[0].values
  ).toEqual([[12], [8]])
  expect(botModelUsage(f.store, { rootRunId: f.parent.run.id })).toMatchObject({
    requests: 2,
    outputTokens: 20,
    unknownRequests: 0,
    inputReportedRequests: 0,
    models: [{ model: config.model, modelRef: config.id }]
  })
})

it.each(["disconnect", "missing-usage", "missing-done", "json"])(
  "retains reservation when the provider receipt is uncertain: %s",
  async (kind) => {
    const f = fixture(),
      child = f.child()
    const metered = botWorkflowModelFetch(child, config, async () => {
      if (kind === "disconnect") throw new Error("connection lost")
      if (kind === "missing-done") return usageResponse(12, false)
      if (kind === "json")
        return new Response(JSON.stringify({ choices: [], usage: { completion_tokens: 12 } }), {
          headers: { "content-type": "application/json" }
        })
      return new Response("data: [DONE]\n\n", { headers: { "content-type": "text/event-stream" } })
    })
    if (kind === "disconnect")
      await expect(metered("https://unused.invalid", request)).rejects.toThrow("connection lost")
    else await (await metered("https://unused.invalid", request)).text()
    expect(
      f.store.db.exec("SELECT consumed,reserved FROM bot_workflow_model_calls")[0].values
    ).toEqual([[null, 100]])
    expect(botModelUsage(f.store, { rootRunId: f.parent.run.id })).toMatchObject({
      requests: 1,
      unknownRequests: 1,
      reservedOutputTokens: 100
    })
    await expect(metered("https://unused.invalid", request)).rejects.toThrow("共享输出预算已用尽")
  }
)

it("new workflows and child sessions cannot escape the root pool", async () => {
  const f = fixture(200_000)
  const bigConfig = { ...config, maxOutputTokens: 100_000 }
  const largeRequest = {
    ...request,
    body: JSON.stringify({ model: "gpt-test", stream: true, max_tokens: 100_000 })
  }
  for (const name of ["first", "second"]) {
    const child = f.child(name)
    await (
      await botWorkflowModelFetch(child, bigConfig, async () => usageResponse(100_000))(
        "https://unused.invalid",
        largeRequest
      )
    ).text()
  }
  let sent = false
  await expect(
    botWorkflowModelFetch(f.child("third"), config, async () => {
      sent = true
      return usageResponse(1)
    })("https://unused.invalid", request)
  ).rejects.toThrow("共享输出预算已用尽")
  expect(sent).toBe(false)
})

it("a late usage receipt cannot release quota after Host ownership is fenced", async () => {
  const f = fixture(),
    child = f.child()
  const response = await botWorkflowModelFetch(child, config, async () => usageResponse(1))(
    "https://unused.invalid",
    request
  )
  f.store.recoverAbandonedAtStartup()
  await response.text()
  expect(
    f.store.db.exec("SELECT consumed,reserved FROM bot_workflow_model_calls")[0].values
  ).toEqual([[null, 100]])
})

it("parent and peer calls use the same root allowance as workflow children", async () => {
  const f = fixture(200_000)
  const child = f.child()
  const peer = f.store.createBot({ nonce: "peer-bot", name: "Peer" })
  f.store.sendPeer(f.parent.lease, { nonce: "peer-task", recipient: peer.bot.id, text: "Review" })
  const claimed = f.store.claim("peer-host")!
  const peerRequest: BotRuntimeRequest = { ...f.parentRequest, bot: peer.bot, ...claimed }
  expect(peerRequest.run.rootRunId).toBe(f.parent.run.id)
  const large = { ...config, maxOutputTokens: 100_000 }
  const input = { ...request, body: JSON.stringify({ stream: true, max_tokens: 100_000 }) }
  for (const task of [f.parentRequest, peerRequest]) {
    await (
      await botWorkflowModelFetch(task, large, async () => usageResponse(100_000))(
        "https://unused.invalid",
        input
      )
    ).text()
  }
  let sent = false
  await expect(
    botWorkflowModelFetch(child, config, async () => {
      sent = true
      return usageResponse(1)
    })("https://unused.invalid", request)
  ).rejects.toThrow("共享输出预算已用尽")
  expect(sent).toBe(false)
  expect(
    f.store.db.exec("SELECT workflow_id,consumed FROM bot_workflow_model_calls")[0].values
  ).toEqual([
    [null, 100_000],
    [null, 100_000]
  ])
  for (const task of [f.parentRequest, peerRequest, child]) {
    expect(
      f.store.runHistory({ conversationId: task.run.conversationId, runId: task.run.id })
        .modelBudget
    ).toEqual({ limit: 200_000, consumed: 200_000, reserved: 0, requests: 2 })
  }
  const other = f.store.createBot({ nonce: "independent", name: "Independent" })
  f.store.send({
    nonce: "independent-task",
    conversationId: other.conversationId,
    text: "Separate task"
  })
  const independent = f.store.claim("another-host")!
  const separate = { ...f.parentRequest, ...independent, bot: other.bot }
  await (
    await botWorkflowModelFetch(separate, config, async () => usageResponse(8))(
      "https://unused.invalid",
      request
    )
  ).text()
  expect(
    f.store.runHistory({ conversationId: other.conversationId, runId: independent.run.id })
      .modelBudget
  ).toEqual({ limit: 200_000, consumed: 8, reserved: 0, requests: 1 })
})

it("settles a complete non-streaming provider usage receipt and clamps the next real request", async () => {
  const f = fixture(100),
    child = f.child()
  const ceilings: number[] = []
  const metered = botWorkflowModelFetch(child, config, async (_url, init) => {
    ceilings.push(JSON.parse(String(init?.body)).max_tokens)
    return new Response(
      JSON.stringify({
        choices: [{ message: { role: "assistant", content: "ok" }, finish_reason: "stop" }],
        usage: { completion_tokens: 12 }
      }),
      { headers: { "content-type": "application/json" } }
    )
  })
  for (let i = 0; i < 2; i++)
    await (
      await metered("https://unused.invalid", {
        ...request,
        body: JSON.stringify({ stream: false, max_tokens: 100 })
      })
    ).json()
  expect(ceilings).toEqual([100, 88])
  expect(
    f.store.db.exec("SELECT consumed FROM bot_workflow_model_calls ORDER BY rowid")[0].values
  ).toEqual([[12], [12]])
})

it.each([null, ""])(
  "settles clean MiniMax EOF usage through the actual configured SDK stream with partial marker %j",
  async (partialFinish) => {
    const logs = vi.spyOn(console, "info").mockImplementation(() => {})
    vi.spyOn(console, "log").mockImplementation(() => {})
    const f = fixture(200_000),
      bodies: Record<string, unknown>[] = []
    const modelConfig = {
      ...config,
      model: "MiniMax-M3",
      maxOutputTokens: 8192,
      enableThinking: true,
      interleavedThinking: true
    }
    const metered = botWorkflowModelFetch(f.parentRequest, modelConfig, async (_url, init) => {
      bodies.push(JSON.parse(String(init?.body)))
      const frames = [
        {
          id: "synthetic",
          object: "chat.completion.chunk",
          created: 1,
          model: "MiniMax-M3",
          choices: [
            {
              index: 0,
              delta: { role: "assistant", content: "ok" },
              finish_reason: partialFinish
            }
          ]
        },
        {
          id: "synthetic",
          object: "chat.completion.chunk",
          created: 1,
          model: "MiniMax-M3",
          choices: [{ index: 0, delta: {}, finish_reason: "stop" }]
        },
        {
          id: "synthetic",
          object: "chat.completion.chunk",
          created: 1,
          model: "MiniMax-M3",
          choices: [],
          usage: { prompt_tokens: 20, completion_tokens: 12, total_tokens: 32 }
        }
      ]
      return new Response(frames.map((value) => `data: ${JSON.stringify(value)}\n\n`).join(""), {
        headers: { "content-type": "text/event-stream" }
      })
    })
    const model = createConfiguredCmbModel(modelConfig, { fetch: metered })
    for (let i = 0; i < 26; i++) {
      let text = ""
      for await (const chunk of await model.stream("Synthetic acceptance"))
        if (typeof chunk.content === "string") text += chunk.content
      expect(text).toBe("ok")
    }
    expect(bodies).toHaveLength(26)
    expect(
      bodies.every(
        (body) =>
          body.stream === true &&
          (body.stream_options as { include_usage?: boolean }).include_usage === true &&
          body.max_tokens === 8192
      )
    ).toBe(true)
    expect(botModelUsage(f.store, { rootRunId: f.parent.run.id })).toMatchObject({
      requests: 26,
      unknownRequests: 0,
      outputTokens: 312,
      reservedOutputTokens: 0
    })
    const traces = logs.mock.calls
      .filter(([tag]) => tag === "[BotModelCall]")
      .map(([, value]) => value)
    expect(traces.filter((value) => value.phase === "stream_ended")).toHaveLength(26)
    expect(
      traces
        .filter((value) => value.phase === "stream_ended")
        .every(
          (value) =>
            value.protocolComplete === true &&
            value.eofCompleted === true &&
            value.nonterminalFinishPlaceholders === (partialFinish === "" ? 1 : 0) &&
            value.terminalFinishReasons[0] === "stop"
        )
    ).toBe(true)
  }
)

it("new MiniMax EOF receipts never settle an earlier incomplete reservation", async () => {
  vi.spyOn(console, "info").mockImplementation(() => {})
  const f = fixture(100),
    child = f.child(),
    modelConfig = { ...config, model: "MiniMax-M3" }
  let attempt = 0
  const metered = botWorkflowModelFetch(child, modelConfig, async () => {
    const partial = `data: ${JSON.stringify({ choices: [{ index: 0, delta: { content: "ok" }, finish_reason: "" }] })}\n\n`
    const terminal = `data: ${JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: "stop" }], usage: { completion_tokens: 12 } })}\n\n`
    return new Response(partial + (attempt++ === 0 ? "" : terminal), {
      headers: { "content-type": "text/event-stream" }
    })
  })
  const small = { ...request, body: JSON.stringify({ stream: true, max_tokens: 40 }) }
  await (await metered("https://unused.invalid", small)).text()
  await (await metered("https://unused.invalid", small)).text()
  expect(
    f.store.db.exec("SELECT reserved,consumed FROM bot_workflow_model_calls ORDER BY rowid")[0]
      .values
  ).toEqual([
    [40, null],
    [40, 12]
  ])
  expect(botModelUsage(f.store, { rootRunId: f.parent.run.id })).toMatchObject({
    requests: 2,
    unknownRequests: 1,
    outputTokens: 12,
    reservedOutputTokens: 40
  })
})

it("retains unknown EOF usage and blocks a child after a length-truncated terminal", async () => {
  const f = fixture(),
    child = f.child()
  const metered = botWorkflowModelFetch(
    child,
    config,
    async () =>
      new Response(
        `data: ${JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: "length" }], usage: { completion_tokens: 12 } })}\n\n`,
        { headers: { "content-type": "text/event-stream" } }
      )
  )
  await (await metered("https://unused.invalid", request)).text()
  expect(botModelUsage(f.store, { rootRunId: f.parent.run.id })).toMatchObject({
    requests: 1,
    unknownRequests: 1,
    reservedOutputTokens: 100
  })
  await expect(metered("https://unused.invalid", request)).rejects.toMatchObject({
    code: "workflow_budget"
  })
})
