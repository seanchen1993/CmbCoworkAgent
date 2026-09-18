const MAX_EVENT_CHARS = 64 * 1024

export interface ModelResponseDiagnostic {
  model: string
  purpose: string
  status: number
  contentType: string | null
  requestId: string | null
  afterTool: boolean
  messageCount: number
  bytes: number
  format: "empty" | "sse" | "json" | "other"
  dataEvents: number
  deltaEvents: number
  messageEvents: number
  errorEvents: number
  doneEvents: number
  uninspectedEvents: number
}

/** Report protocol structure only, without prompts, tool arguments or response text. */
export function withModelResponseDiagnostics(
  fetchImpl: typeof fetch,
  context: { model: string; purpose: string },
  report: (diagnostic: ModelResponseDiagnostic) => void
): typeof fetch {
  return async (input, init) => {
    let request: { stream?: boolean; messages?: Array<{ role?: string }> }
    try {
      request = JSON.parse(typeof init?.body === "string" ? init.body : "null")
    } catch {
      return fetchImpl(input, init)
    }
    if (!request?.stream) return fetchImpl(input, init)
    const response = await fetchImpl(input, init)
    if (!response.ok) return response
    const diagnostic: ModelResponseDiagnostic = {
      ...context,
      status: response.status,
      contentType: response.headers.get("content-type"),
      requestId: response.headers.get("x-request-id"),
      afterTool: request.messages?.at(-1)?.role === "tool",
      messageCount: request.messages?.length ?? 0,
      bytes: 0,
      format: "empty",
      dataEvents: 0,
      deltaEvents: 0,
      messageEvents: 0,
      errorEvents: 0,
      doneEvents: 0,
      uninspectedEvents: 0
    }
    const safeReport = (): void => {
      try {
        report(diagnostic)
      } catch {
        // Diagnostics must never turn a successful response into a failed request.
      }
    }
    if (!response.body) {
      safeReport()
      return response
    }

    const decoder = new TextDecoder()
    let line = ""
    let event = ""
    let oversized = false
    let prefix = ""
    let previousWasCR = false
    const finishEvent = (): void => {
      if (oversized) diagnostic.uninspectedEvents += 1
      else if (event) {
        diagnostic.dataEvents += 1
        if (event.trim() === "[DONE]") diagnostic.doneEvents += 1
        else {
          try {
            const parsed = JSON.parse(event)
            const choice = parsed?.choices?.[0]
            if (choice?.delta) diagnostic.deltaEvents += 1
            if (choice?.message) diagnostic.messageEvents += 1
            if (parsed?.error) diagnostic.errorEvents += 1
          } catch {
            diagnostic.uninspectedEvents += 1
          }
        }
      }
      event = ""
      oversized = false
    }
    const consumeLine = (): void => {
      const value = line
      if (!value) finishEvent()
      else if (value.startsWith("data:") && !oversized) {
        const data = value.slice(5).replace(/^ /, "")
        if (event.length + data.length > MAX_EVENT_CHARS) oversized = true
        else event += `${event ? "\n" : ""}${data}`
      }
      line = ""
    }
    const consume = (text: string): void => {
      if (prefix.length < 32) {
        prefix = (prefix + text).slice(0, 32)
        const start = prefix.trimStart()
        diagnostic.format = !start
          ? "empty"
          : /^[{[]/.test(start)
            ? "json"
            : /^(data:|event:|:)/.test(start)
              ? "sse"
              : "other"
      }
      // A non-SSE response is still forwarded byte-for-byte; only its format is recorded.
      if (diagnostic.format === "json") return
      for (const char of text) {
        // Treat CRLF as one separator even when its bytes arrive in separate chunks.
        // The SDK also accepts bare CR, so diagnostics must count the same events.
        const followsCR = previousWasCR
        previousWasCR = char === "\r"
        if (char === "\n" && followsCR) continue
        if (char === "\n" || char === "\r") consumeLine()
        else if (line.length < MAX_EVENT_CHARS) line += char
        else oversized = true
      }
    }
    const body = response.body.pipeThrough(
      new TransformStream<Uint8Array, Uint8Array>({
        transform(chunk, controller) {
          diagnostic.bytes += chunk.byteLength
          consume(decoder.decode(chunk, { stream: true }))
          controller.enqueue(chunk)
        },
        flush() {
          consume(decoder.decode())
          if (line) consumeLine()
          if (event || oversized) finishEvent()
          safeReport()
        }
      })
    )
    return new Response(body, {
      status: response.status,
      statusText: response.statusText,
      headers: response.headers
    })
  }
}
