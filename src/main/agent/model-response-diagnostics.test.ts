import { describe, expect, it, vi } from "vitest"
import { withModelResponseDiagnostics } from "./model-response-diagnostics"

it.each([
  ["", "empty_string"],
  ["PRIVATE_PROVIDER_VALUE", "unknown_string"],
  [0, "number"],
  [false, "boolean"],
  [["PRIVATE_ITEM"], "array"],
  [{ PRIVATE_KEY: "PRIVATE_VALUE" }, "object"]
])(
  "classifies an invalid finish marker by bounded shape without allowing settlement: %j",
  async (reason, kind) => {
    const frame = sseFrame({ choices: [{ index: 0, delta: {}, finish_reason: reason }] })
    const { response, report } = observe(frame + frame + terminalFrame() + usageFrame())
    await (await response).text()
    const receipt = report.mock.calls[0][0]
    expect(receipt.invalidFinishReasonKinds).toEqual([kind])
    expect(receipt.eofRejectionReasons).toEqual(["invalid_finish_reason"])
    expect(receipt.doneEvents).toBe(0)
    expect(receipt.outputTokens).toBe(12)
    expect(JSON.stringify(receipt)).not.toContain("PRIVATE_")
  }
)

it.each([null, undefined])(
  "keeps the existing legal partial marker without inventing a terminal: %j",
  async (reason) => {
    const frame = sseFrame({
      choices: [{ index: 0, delta: { content: "PRIVATE_TEXT" }, finish_reason: reason }]
    })
    const partial = observe(frame + usageFrame())
    await (await partial.response).text()
    expect(partial.report.mock.calls[0][0].doneEvents).toBe(0)
    expect(partial.report.mock.calls[0][0].invalidFinishReasonKinds).toBeUndefined()
    const complete = observe(frame + terminalFrame() + usageFrame())
    await (await complete.response).text()
    expect(complete.report.mock.calls[0][0].doneEvents).toBe(1)
    expect(complete.report.mock.calls[0][0].invalidFinishReasonKinds).toBeUndefined()
  }
)

function observe(body: string, contentType = "text/event-stream", n = 1, model = "test-model") {
  const report = vi.fn()
  const wrapped = withModelResponseDiagnostics(
    async () =>
      new Response(body, {
        headers: { "content-type": contentType, "x-request-id": "test-request" }
      }),
    { model, purpose: "agent" },
    report
  )
  return {
    report,
    response: wrapped("https://example.test", {
      body: JSON.stringify({
        stream: true,
        n,
        messages: [{ role: "tool", content: "private tool result" }]
      })
    })
  }
}

describe("model response protocol diagnostics", () => {
  it("retains only provider-reported cumulative input, cache and reasoning counters", async () => {
    const body =
      [
        {
          prompt_tokens: 80,
          completion_tokens: 10,
          prompt_tokens_details: { cached_tokens: 30 },
          completion_tokens_details: { reasoning_tokens: 4 }
        },
        {
          prompt_tokens: 80,
          completion_tokens: 12,
          prompt_tokens_details: { cached_tokens: 30 },
          completion_tokens_details: { reasoning_tokens: 5 }
        },
        {
          prompt_tokens: -1,
          completion_tokens: 0.2,
          prompt_tokens_details: { cached_tokens: "40" }
        }
      ]
        .map((usage) => `data: ${JSON.stringify({ usage, choices: [] })}\n\n`)
        .join("") + "data: [DONE]\n\n"
    const { response, report } = observe(body)
    await (await response).text()
    expect(report).toHaveBeenCalledWith(
      expect.objectContaining({
        inputTokens: 80,
        outputTokens: 12,
        cacheReadTokens: 30,
        reasoningTokens: 5
      })
    )
    const missing = observe("data: [DONE]\n\n")
    await (await missing.response).text()
    expect(missing.report.mock.calls[0][0].inputTokens).toBeUndefined()
  })
  it("meters complete JSON across byte chunks without retaining response contents in diagnostics", async () => {
    const body = JSON.stringify({
      choices: [{ message: { content: "私有答复" }, finish_reason: "stop" }],
      usage: { completion_tokens: 17 }
    })
    const report = vi.fn()
    const wrapped = withModelResponseDiagnostics(
      async () =>
        new Response(
          new ReadableStream({
            start(controller) {
              for (const byte of new TextEncoder().encode(body))
                controller.enqueue(new Uint8Array([byte]))
              controller.close()
            }
          })
        ),
      { model: "test", purpose: "budget" },
      report
    )
    expect(await (await wrapped("https://example.test", { body: '{"stream":false}' })).text()).toBe(
      body
    )
    expect(report).toHaveBeenCalledWith(
      expect.objectContaining({ format: "json", doneEvents: 1, messageEvents: 1, outputTokens: 17 })
    )
    expect(JSON.stringify(report.mock.calls)).not.toMatch(/私有|"content"|choices/)
  })

  it.each(["oversized", "truncated", "unfinished", "error"])(
    "does not settle uncertain JSON usage: %s",
    async (kind) => {
      const parsed = {
        choices: [
          {
            message: { content: kind === "oversized" ? "x".repeat(1024 * 1024) : "private" },
            finish_reason: kind === "unfinished" ? null : "stop"
          }
        ],
        usage: { completion_tokens: 1 },
        ...(kind === "error" ? { error: { message: "private" } } : {})
      }
      const complete = JSON.stringify(parsed),
        body = kind === "truncated" ? complete.slice(0, -1) : complete
      const { response, report } = observe(body, "application/json")
      expect(await (await response).text()).toBe(body)
      const receipt = report.mock.calls[0][0]
      expect(
        receipt.doneEvents < 1 || receipt.errorEvents > 0 || receipt.uninspectedEvents > 0
      ).toBe(true)
    }
  )

  it("distinguishes JSON answers from empty SSE without logging their contents", async () => {
    const body = JSON.stringify({ choices: [{ message: { content: "private answer" } }] })
    const { response, report } = observe(body, "application/json")
    expect(await (await response).text()).toBe(body)
    expect(report).toHaveBeenCalledWith(
      expect.objectContaining({
        format: "json",
        afterTool: true,
        bytes: body.length,
        deltaEvents: 0,
        requestId: "test-request",
        messageCount: 1
      })
    )
    expect(JSON.stringify(report.mock.calls)).not.toMatch(/private|choices/)
  })

  it("distinguishes contentless DONE streams from zero-byte responses", async () => {
    for (const body of ["", "data: [DONE]\n\n"]) {
      const { response, report } = observe(body)
      expect(await (await response).text()).toBe(body)
      expect(report).toHaveBeenCalledWith(
        expect.objectContaining({
          bytes: body.length,
          format: body ? "sse" : "empty",
          doneEvents: body ? 1 : 0,
          deltaEvents: 0
        })
      )
    }
  })

  it("counts tool deltas, incompatible messages and stream errors by structure", async () => {
    const body =
      [
        { choices: [{ delta: { tool_calls: [{ function: { arguments: "private args" } }] } }] },
        { choices: [{ message: { content: "private answer" } }] },
        { error: { message: "private error" } }
      ]
        .map((value) => `data: ${JSON.stringify(value)}\r\n\r\n`)
        .join("") + "data: [DONE]\n\n"
    const { response, report } = observe(body)
    expect(await (await response).text()).toBe(body)
    expect(report).toHaveBeenCalledWith(
      expect.objectContaining({
        dataEvents: 4,
        deltaEvents: 1,
        messageEvents: 1,
        errorEvents: 1,
        doneEvents: 1
      })
    )
    expect(JSON.stringify(report.mock.calls)).not.toContain("private")
  })

  it("bounds retained event data and still forwards oversized tool arguments", async () => {
    const body = `data: ${JSON.stringify({ choices: [{ delta: { content: "a".repeat(100_000) } }] })}\n\ndata: [DONE]\n\n`
    const { response, report } = observe(body)
    expect(await (await response).text()).toBe(body)
    expect(report).toHaveBeenCalledWith(
      expect.objectContaining({ uninspectedEvents: 1, doneEvents: 1 })
    )
  })

  it.each(["\r", "\r\n", "\n"])(
    "counts SSE events with %j line endings across chunks",
    async (newline) => {
      const body = `data: {"choices":[{"delta":{"content":"private"}}]}${newline}${newline}data: [DONE]${newline}${newline}`
      const report = vi.fn()
      const wrapped = withModelResponseDiagnostics(
        async () =>
          new Response(
            new ReadableStream({
              start(controller) {
                for (const byte of new TextEncoder().encode(body))
                  controller.enqueue(new Uint8Array([byte]))
                controller.close()
              }
            })
          ),
        { model: "test", purpose: "agent" },
        report
      )
      expect(
        await (await wrapped("https://example.test", { body: '{"stream":true}' })).text()
      ).toBe(body)
      expect(report).toHaveBeenCalledWith(
        expect.objectContaining({ dataEvents: 2, deltaEvents: 1, doneEvents: 1 })
      )
      expect(JSON.stringify(report.mock.calls)).not.toContain("private")
    }
  )

  it("handles UTF-8 split across byte chunks and does not break on a logging failure", async () => {
    const bytes = new TextEncoder().encode('data: {"choices":[{"delta":{"content":"中文"}}]}\n\n')
    const report = vi.fn(() => {
      throw new Error("log unavailable")
    })
    const wrapped = withModelResponseDiagnostics(
      async () =>
        new Response(
          new ReadableStream({
            start(controller) {
              for (const byte of bytes) controller.enqueue(new Uint8Array([byte]))
              controller.close()
            }
          })
        ),
      { model: "test", purpose: "agent" },
      report
    )
    const response = await wrapped("https://example.test", { body: '{"stream":true}' })
    expect(new Uint8Array(await response.arrayBuffer())).toEqual(bytes)
    expect(report).toHaveBeenCalledWith(
      expect.objectContaining({ deltaEvents: 1, bytes: bytes.length })
    )
  })

  it("preserves stream failure and downstream cancellation", async () => {
    const failure = new Error("transport failure")
    const report = vi.fn()
    const cancel = vi.fn()
    const wrapped = withModelResponseDiagnostics(
      async () => new Response(new ReadableStream({ cancel })),
      { model: "test", purpose: "agent" },
      report
    )
    const response = await wrapped("https://example.test", { body: '{"stream":true}' })
    await response.body!.cancel("user stopped")
    await vi.waitFor(() => expect(cancel).toHaveBeenCalledWith("user stopped"))
    const failing = withModelResponseDiagnostics(
      async () =>
        new Response(
          new ReadableStream({
            start(controller) {
              controller.error(failure)
            }
          })
        ),
      { model: "test", purpose: "agent" },
      report
    )
    await expect(
      (await failing("https://example.test", { body: '{"stream":true}' })).text()
    ).rejects.toBe(failure)
    expect(report).not.toHaveBeenCalled()
  })
})

const sseFrame = (value: unknown) => `data: ${JSON.stringify(value)}\n\n`
const terminalFrame = (reason = "stop", index = 0) =>
  sseFrame({ choices: [{ index, delta: {}, finish_reason: reason }] })
const usageFrame = () => sseFrame({ choices: [], usage: { completion_tokens: 12 } })

it.each(["MiniMax-M3", "minimax/MiniMax-M3"])(
  "settles %s partial empty markers only after a clean terminal and usage EOF",
  async (model) => {
    const partial = sseFrame({
      choices: [{ index: 0, delta: { content: "PRIVATE_TEXT" }, finish_reason: "" }]
    })
    const body = partial + partial + terminalFrame() + usageFrame()
    const { response, report } = observe(body, "text/event-stream", 1, model)
    expect(await (await response).text()).toBe(body)
    expect(report.mock.calls[0][0]).toMatchObject({
      doneEvents: 1,
      eofCompleted: true,
      eofRejectionReasons: [],
      nonterminalFinishPlaceholders: 2,
      terminalFinishEvents: 1,
      terminalFinishReasons: ["stop"],
      outputTokens: 12
    })
    expect(report.mock.calls[0][0].invalidFinishReasonKinds).toBeUndefined()
    expect(JSON.stringify(report.mock.calls)).not.toContain("PRIVATE_")
  }
)

it.each(["MiniMax-M2.7", "MiniMax-M3.1", "another-minimax-m3", "test-model"])(
  "does not expand partial empty-marker compatibility to %s",
  async (model) => {
    const body = terminalFrame("" as string) + terminalFrame() + usageFrame()
    const { response, report } = observe(body, "text/event-stream", 1, model)
    await (await response).text()
    expect(report.mock.calls[0][0]).toMatchObject({
      doneEvents: 0,
      eofRejectionReasons: ["invalid_finish_reason"],
      invalidFinishReasonKinds: ["empty_string"]
    })
  }
)

it.each([
  ["no-terminal", terminalFrame("") + usageFrame()],
  ["no-usage", terminalFrame("") + terminalFrame()],
  ["usage-before-terminal", terminalFrame("") + usageFrame() + terminalFrame()],
  ["late-placeholder", terminalFrame() + terminalFrame("") + usageFrame()],
  ["truncated", terminalFrame("") + terminalFrame("length") + usageFrame()],
  ["invalid-index", terminalFrame("", 1) + terminalFrame() + usageFrame()],
  [
    "invalid-delta",
    sseFrame({ choices: [{ index: 0, delta: [], finish_reason: "" }] }) +
      terminalFrame() +
      usageFrame()
  ],
  ["unknown-reason", terminalFrame("PRIVATE_UNKNOWN") + terminalFrame() + usageFrame()],
  ["unfinished-event", (terminalFrame("") + terminalFrame() + usageFrame()).slice(0, -1)],
  [
    "protocol-error",
    terminalFrame("") + terminalFrame() + usageFrame() + sseFrame({ error: { message: "PRIVATE" } })
  ]
])("retains uncertain MiniMax placeholder streams: %s", async (_label, body) => {
  const { response, report } = observe(body, "text/event-stream", 1, "MiniMax-M3")
  expect(await (await response).text()).toBe(body)
  expect(report.mock.calls[0][0]).toMatchObject({ doneEvents: 0, eofCompleted: false })
  expect(JSON.stringify(report.mock.calls)).not.toContain("PRIVATE")
})

it("requires a terminal for every MiniMax choice after its partial placeholders", async () => {
  const body =
    terminalFrame("", 0) +
    terminalFrame("stop", 0) +
    terminalFrame("", 1) +
    terminalFrame("stop", 1) +
    usageFrame()
  const { response, report } = observe(body, "text/event-stream", 2, "MiniMax-M3")
  await (await response).text()
  expect(report.mock.calls[0][0]).toMatchObject({
    doneEvents: 1,
    nonterminalFinishPlaceholders: 2,
    terminalFinishEvents: 2
  })
  const missing = observe(
    terminalFrame("", 0) + terminalFrame("stop", 0) + terminalFrame("", 1) + usageFrame(),
    "text/event-stream",
    2,
    "MiniMax-M3"
  )
  await (await missing.response).text()
  expect(missing.report.mock.calls[0][0].doneEvents).toBe(0)
})

it.each(["stop", "tool_calls", "function_call", "content_filter"])(
  "accepts clean terminal SSE EOF with explicit provider usage: %s",
  async (reason) => {
    const body = terminalFrame(reason) + usageFrame()
    const { response, report } = observe(body)
    expect(await (await response).text()).toBe(body)
    expect(report).toHaveBeenCalledWith(
      expect.objectContaining({
        doneEvents: 1,
        eofCompleted: true,
        terminalFinishEvents: 1,
        terminalFinishReasons: [reason],
        outputTokens: 12,
        errorEvents: 0,
        uninspectedEvents: 0
      })
    )
  }
)

it("requires terminal events for every requested choice and supports final-frame usage", async () => {
  const body =
    terminalFrame("stop", 0) +
    sseFrame({
      choices: [{ index: 1, delta: {}, finish_reason: "stop" }],
      usage: { completion_tokens: 12 }
    })
  const { response, report } = observe(body, "text/event-stream", 2)
  await (await response).text()
  expect(report).toHaveBeenCalledWith(
    expect.objectContaining({
      doneEvents: 1,
      eofCompleted: true,
      terminalFinishEvents: 2
    })
  )
})

it.each([
  ["missing-finish", usageFrame(), 1],
  ["missing-choice", terminalFrame() + usageFrame(), 2],
  ["missing-usage", terminalFrame(), 1],
  ["usage-before-terminal", usageFrame() + terminalFrame(), 1],
  ["unfinished-final-frame", (terminalFrame() + usageFrame()).slice(0, -1), 1],
  ["length", terminalFrame("length") + usageFrame(), 1],
  ["unknown-finish", terminalFrame("unknown-sensitive-reason") + usageFrame(), 1],
  ["error", terminalFrame() + usageFrame() + sseFrame({ error: { message: "PRIVATE" } }), 1],
  ["unknown-json-event", terminalFrame() + usageFrame() + sseFrame({ surprise: "PRIVATE" }), 1],
  ["unknown-sse-event", `event: surprise\n${terminalFrame()}` + usageFrame(), 1],
  ["unknown-empty-sse-event", terminalFrame() + usageFrame() + "event: surprise\n\n", 1],
  ["unfinished-sse-header", terminalFrame() + usageFrame() + "event: surprise\n", 1],
  [
    "invalid-final-usage",
    terminalFrame() + usageFrame() + sseFrame({ choices: [], usage: { completion_tokens: "12" } }),
    1
  ],
  ["sse-error-event", terminalFrame() + `event: error\n${usageFrame()}`, 1],
  ["invalid-json", terminalFrame() + usageFrame() + "data: {broken\n\n", 1],
  [
    "late-delta",
    terminalFrame() +
      sseFrame({
        choices: [{ index: 0, delta: { content: "PRIVATE" }, finish_reason: null }]
      }) +
      usageFrame(),
    1
  ],
  ["invalid-choice-index", terminalFrame("stop", 1) + usageFrame(), 1],
  [
    "missing-choice-index",
    sseFrame({ choices: [{ delta: {}, finish_reason: "stop" }] }) + usageFrame(),
    1
  ],
  ["invalid-requested-choices", terminalFrame() + usageFrame(), 129]
])("retains incomplete or uncertain SSE EOF: %s", async (_label, body, n) => {
  const { response, report } = observe(String(body), "text/event-stream", Number(n))
  await (await response).text()
  expect(report).toHaveBeenCalledWith(
    expect.objectContaining({ doneEvents: 0, eofCompleted: false })
  )
  expect(JSON.stringify(report.mock.calls)).not.toMatch(/PRIVATE|sensitive-reason/)
})

it("does not settle a terminal-plus-usage stream that fails before EOF", async () => {
  const report = vi.fn(),
    failure = new Error("transport interrupted")
  let pulls = 0
  const wrapped = withModelResponseDiagnostics(
    async () =>
      new Response(
        new ReadableStream({
          pull(controller) {
            if (pulls++ === 0)
              controller.enqueue(new TextEncoder().encode(terminalFrame() + usageFrame()))
            else controller.error(failure)
          }
        })
      ),
    { model: "fixture", purpose: "budget" },
    report
  )
  await expect(
    (await wrapped("https://unused.invalid", { body: '{"stream":true}' })).text()
  ).rejects.toBe(failure)
  expect(report).not.toHaveBeenCalled()
})

it("preserves explicit DONE settlement for length and does not mark it EOF-completed", async () => {
  const { response, report } = observe(terminalFrame("length") + usageFrame() + "data: [DONE]\n\n")
  await (await response).text()
  expect(report).toHaveBeenCalledWith(
    expect.objectContaining({
      doneEvents: 1,
      eofCompleted: false,
      outputTokens: 12
    })
  )
})

it.each([
  ["invalid_choices", terminalFrame() + sseFrame({ usage: { completion_tokens: 12 } })],
  [
    "invalid_delta",
    terminalFrame() +
      sseFrame({
        choices: [{ index: 0, delta: null, finish_reason: "stop" }],
        usage: { completion_tokens: 12 }
      })
  ],
  [
    "delta_after_terminal",
    terminalFrame() +
      sseFrame({
        choices: [
          {
            index: 0,
            delta: { role: "assistant", content: "" },
            finish_reason: "stop"
          }
        ],
        usage: { completion_tokens: 12 }
      })
  ],
  [
    "invalid_usage",
    terminalFrame() +
      sseFrame({
        choices: [],
        usage: { completion_tokens: "PRIVATE_BAD_USAGE" }
      })
  ],
  ["unfinished_event", (terminalFrame() + usageFrame()).slice(0, -1)],
  ["missing_terminal_usage", usageFrame() + terminalFrame()],
  ["missing_terminal", usageFrame()],
  ["truncated_finish", terminalFrame("length") + usageFrame()],
  ["changed_finish_reason", terminalFrame() + terminalFrame("tool_calls") + usageFrame()],
  ["invalid_finish_reason", terminalFrame("PRIVATE_FINISH") + usageFrame()],
  ["invalid_choice_index", terminalFrame("stop", 1) + usageFrame()],
  ["unsupported_event_type", "event: PRIVATE_EVENT\n" + terminalFrame() + usageFrame()],
  [
    "protocol_error",
    terminalFrame() + usageFrame() + sseFrame({ error: { message: "PRIVATE_ERROR" } })
  ],
  ["uninspected_event", terminalFrame() + usageFrame() + "data: PRIVATE_BAD_JSON\n\n"]
])(
  "diagnoses rejected EOF without weakening settlement or logging payload: %s",
  async (reason, body) => {
    const { response, report } = observe(body)
    expect(await (await response).text()).toBe(body)
    const receipt = report.mock.calls[0][0]
    expect(receipt.doneEvents).toBe(0)
    expect(receipt.eofCompleted).toBe(false)
    expect(receipt.eofRejectionReasons).toContain(reason)
    expect(receipt.eofRejectionReasons.length).toBeLessThanOrEqual(16)
    expect(JSON.stringify(receipt)).not.toContain("PRIVATE_")
  }
)

it("reports no rejected predicate for a complete terminal and usage EOF", async () => {
  const { response, report } = observe(terminalFrame() + usageFrame())
  await (await response).text()
  expect(report).toHaveBeenCalledWith(
    expect.objectContaining({
      doneEvents: 1,
      eofCompleted: true,
      eofRejectionReasons: []
    })
  )
})

it("does not report or settle a client-cancelled stream after terminal plus usage", async () => {
  const report = vi.fn()
  let cancelled = false
  const wrapped = withModelResponseDiagnostics(
    async () =>
      new Response(
        new ReadableStream({
          start(controller) {
            controller.enqueue(new TextEncoder().encode(terminalFrame() + usageFrame()))
          },
          cancel() {
            cancelled = true
          }
        })
      ),
    { model: "fixture", purpose: "cancel" },
    report
  )
  const response = await wrapped("https://unused.invalid", {
    body: '{"stream":true}'
  })
  const reader = response.body!.getReader()
  await reader.read()
  await reader.cancel()
  await new Promise((resolve) => setTimeout(resolve, 0))
  expect(cancelled).toBe(true)
  expect(report).not.toHaveBeenCalled()
})
