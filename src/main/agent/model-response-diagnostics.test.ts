import { describe, expect, it, vi } from "vitest"
import { withModelResponseDiagnostics } from "./model-response-diagnostics"

function observe(body: string, contentType = "text/event-stream") {
  const report = vi.fn()
  const wrapped = withModelResponseDiagnostics(
    async () =>
      new Response(body, {
        headers: { "content-type": contentType, "x-request-id": "test-request" }
      }),
    { model: "test-model", purpose: "agent" },
    report
  )
  return {
    report,
    response: wrapped("https://example.test", {
      body: JSON.stringify({
        stream: true,
        messages: [{ role: "tool", content: "private tool result" }]
      })
    })
  }
}

describe("model response protocol diagnostics", () => {
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
