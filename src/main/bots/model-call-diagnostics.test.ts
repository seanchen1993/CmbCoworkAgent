import { afterEach, expect, it, vi } from "vitest"
import { botModelCallDiagnostics } from "./model-call-diagnostics"
import { withModelResponseDiagnostics } from "../agent/model-response-diagnostics"

afterEach(() => vi.restoreAllMocks())

it("correlates interleaved model streams without copying request or response contents", async () => {
  const log = vi.spyOn(console, "info").mockImplementation(() => {})
  const responses: ((response: Response) => void)[] = []
  const send: typeof fetch = async () => new Promise<Response>((resolve) => responses.push(resolve))
  const identity = {
    callId: "call-a",
    botId: "bot-a",
    runId: "run-a",
    rootRunId: "root",
    purpose: "task" as const
  }
  const a = botModelCallDiagnostics(identity),
    b = botModelCallDiagnostics({ ...identity, callId: "call-b", botId: "bot-b", runId: "run-b" })
  identity.botId = "mutated-owner"
  const call = (diagnostics: typeof a) =>
    withModelResponseDiagnostics(
      (url, init) => diagnostics.send(send, url, init),
      { model: "fixture", purpose: "test" },
      diagnostics.complete
    )("https://example.invalid/?token=PRIVATE_URL", {
      method: "POST",
      headers: { authorization: "Bearer PRIVATE_KEY" },
      body: JSON.stringify({
        stream: true,
        messages: [{ role: "user", content: "PRIVATE_PROMPT" }]
      })
    })
  const first = call(a),
    second = call(b)
  const response = (id: string) =>
    new Response(
      `data: ${JSON.stringify({ choices: [{ delta: { content: "PRIVATE_REPLY" } }], usage: { completion_tokens: 12 } })}\n\ndata: [DONE]\n\n`,
      { headers: { "content-type": "text/event-stream", "x-request-id": id } }
    )
  responses[1](response("remote-b"))
  await (await second).text()
  responses[0](response("remote-a"))
  await (await first).text()
  const records = log.mock.calls
    .filter(([tag]) => tag === "[BotModelCall]")
    .map(([, value]) => value)
  expect(records.filter((value) => value.phase === "stream_ended")).toEqual([
    expect.objectContaining({
      callId: "call-b",
      botId: "bot-b",
      runId: "run-b",
      requestId: "remote-b",
      protocolComplete: true,
      doneEvents: 1,
      errorEvents: 0,
      uninspectedEvents: 0,
      eofCompleted: false,
      outputTokensReported: 12
    }),
    expect.objectContaining({
      callId: "call-a",
      botId: "bot-a",
      runId: "run-a",
      requestId: "remote-a",
      protocolComplete: true,
      doneEvents: 1,
      errorEvents: 0,
      uninspectedEvents: 0,
      eofCompleted: false,
      outputTokensReported: 12
    })
  ])
  expect(JSON.stringify(records)).not.toMatch(/PRIVATE_|mutated-owner/)
  expect(records.every((value) => Number.isInteger(value.elapsedMs) && value.elapsedMs >= 0)).toBe(
    true
  )
})

it("distinguishes rejected HTTP and aborted transport without logging provider errors or unsafe headers", async () => {
  const log = vi.spyOn(console, "info").mockImplementation(() => {})
  const rejected = botModelCallDiagnostics({
    callId: "rejected",
    botId: "bot",
    purpose: "memory-synthesis"
  })
  const response = new Response("PRIVATE_ERROR_BODY", {
    status: 429,
    headers: { "x-request-id": "Bearer PRIVATE_HEADER" }
  })
  expect(await rejected.send(async () => response, "https://unused.invalid")).toBe(response)
  const abort = new AbortController()
  abort.abort()
  const failure = new Error("PRIVATE_PROVIDER_ERROR")
  await expect(
    botModelCallDiagnostics({
      callId: "aborted",
      botId: "bot",
      purpose: "memory-verification"
    }).send(
      async () => {
        throw failure
      },
      "https://unused.invalid",
      { signal: abort.signal }
    )
  ).rejects.toBe(failure)
  expect(log.mock.calls.map(([, value]) => value)).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        callId: "rejected",
        phase: "http_rejected",
        status: 429,
        requestId: null
      }),
      expect.objectContaining({ callId: "aborted", phase: "transport_failed", aborted: true })
    ])
  )
  expect(JSON.stringify(log.mock.calls)).not.toContain("PRIVATE_")
})

it("does not change response delivery when logging fails or falsely complete a broken stream", async () => {
  const log = vi.spyOn(console, "info").mockImplementation(() => {
    throw new Error("Sink closed")
  })
  const response = new Response("ok")
  const diagnostics = botModelCallDiagnostics({ callId: "call", botId: "bot", purpose: "task" })
  expect(await diagnostics.send(async () => response, "https://unused.invalid")).toBe(response)
  log.mockImplementation(() => {})
  const failure = new Error("Broken stream")
  const observed = withModelResponseDiagnostics(
    (url, init) =>
      diagnostics.send(
        async () =>
          new Response(
            new ReadableStream({
              start(controller) {
                controller.error(failure)
              }
            }),
            { headers: { "content-type": "text/event-stream" } }
          ),
        url,
        init
      ),
    { model: "fixture", purpose: "test" },
    diagnostics.complete
  )
  await expect(
    (await observed("https://unused.invalid", { body: JSON.stringify({ stream: true }) })).text()
  ).rejects.toBe(failure)
  expect(log.mock.calls.some(([, value]) => value?.phase === "stream_ended")).toBe(false)
})

it("retains only allowlisted EOF rejection labels in the task-correlated log", async () => {
  const log = vi.spyOn(console, "info").mockImplementation(() => {})
  const diagnostics = botModelCallDiagnostics({
    callId: "call",
    botId: "bot",
    purpose: "task"
  })
  const report = withModelResponseDiagnostics(
    async () =>
      new Response(
        'data: {"choices":[{"index":0,"delta":{},"finish_reason":"tool_calls"}]}\n\ndata: {"usage":{"completion_tokens":12}}\n\n'
      ),
    { model: "fixture", purpose: "test" },
    (usage) =>
      diagnostics.complete({
        ...usage,
        invalidFinishReasonKinds: ["empty_string", "PRIVATE_RAW" as never],
        eofRejectionReasons: [...usage.eofRejectionReasons!, "PRIVATE_PAYLOAD" as never]
      })
  )
  await (await report("https://unused.invalid", { body: '{"stream":true}' })).text()
  expect(log).toHaveBeenCalledWith(
    "[BotModelCall]",
    expect.objectContaining({
      phase: "stream_ended",
      protocolComplete: false,
      outputTokensReported: 12,
      invalidFinishReasonKinds: ["empty_string"],
      eofRejectionReasons: ["invalid_choices"]
    })
  )
  expect(JSON.stringify(log.mock.calls)).not.toContain("PRIVATE_")
})
