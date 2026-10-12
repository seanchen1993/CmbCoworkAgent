import { modelResponseHeaders, inheritModelResponseHeaders } from "../models/model-response-headers"
import { safeSensitiveErrorText } from "../error-text"
const MAX_EVENT_CHARS = 64 * 1024
const MAX_JSON_CHARS = 1024 * 1024

// Closed labels only: never retain event names, fields, response text or credentials.
export const MODEL_RESPONSE_EOF_REJECTION_REASONS = [
  "not_stream_request",
  "invalid_expected_choices",
  "invalid_choices",
  "invalid_choice_index",
  "invalid_delta",
  "delta_after_terminal",
  "invalid_finish_reason",
  "changed_finish_reason",
  "truncated_finish",
  "unsupported_event_type",
  "invalid_usage",
  "unfinished_event",
  "missing_terminal",
  "missing_terminal_usage",
  "protocol_error",
  "uninspected_event"
] as const
export type ModelResponseEofRejection = (typeof MODEL_RESPONSE_EOF_REJECTION_REASONS)[number]

export const MODEL_RESPONSE_INVALID_FINISH_KINDS = [
  "empty_string",
  "unknown_string",
  "number",
  "boolean",
  "array",
  "object"
] as const
export type ModelResponseInvalidFinishKind = (typeof MODEL_RESPONSE_INVALID_FINISH_KINDS)[number]

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
  /** A clean, terminal SSE EOF can complete compatible providers without [DONE]. */
  eofCompleted?: boolean
  eofRejectionReasons?: ModelResponseEofRejection[]
  terminalFinishEvents?: number
  terminalFinishReasons?: string[]
  /** Shape only; never retain arbitrary provider finish values. */
  invalidFinishReasonKinds?: ModelResponseInvalidFinishKind[]
  /** Exact-model compatibility: empty partial markers are not terminal receipts. */
  nonterminalFinishPlaceholders?: number
  /** Provider's cumulative completion usage, when explicitly reported. */
  outputTokens?: number
  inputTokens?: number
  cacheReadTokens?: number
  reasoningTokens?: number
}

/** Report protocol structure only, without prompts, tool arguments or response text. */
export function withModelResponseDiagnostics(
  fetchImpl: typeof fetch,
  context: { model: string; purpose: string; knownSecrets?: readonly string[] },
  report: (diagnostic: ModelResponseDiagnostic) => void
): typeof fetch {
  return async (input, init) => {
    let request: {
      stream?: boolean
      n?: number
      messages?: Array<{ role?: string }>
    }
    try {
      request = JSON.parse(typeof init?.body === "string" ? init.body : "null")
    } catch {
      return fetchImpl(input, init)
    }
    if (!request || typeof request !== "object") return fetchImpl(input, init)
    const response = await fetchImpl(input, init)
    if (!response.ok) return response
    const headers = modelResponseHeaders(response, context.knownSecrets)
    const diagnostic: ModelResponseDiagnostic = {
      model: safeSensitiveErrorText(context.model, 256, context.knownSecrets),
      purpose: safeSensitiveErrorText(context.purpose, 160, context.knownSecrets),
      status: headers.status,
      contentType: headers.contentType,
      requestId: headers.requestId ?? null,
      afterTool: request.messages?.at(-1)?.role === "tool",
      messageCount: request.messages?.length ?? 0,
      bytes: 0,
      format: "empty",
      dataEvents: 0,
      deltaEvents: 0,
      messageEvents: 0,
      errorEvents: 0,
      doneEvents: 0,
      uninspectedEvents: 0,
      eofCompleted: false,
      terminalFinishEvents: 0,
      terminalFinishReasons: []
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
    let json = ""
    let oversizedJson = false
    const expectedChoices = request.n ?? 1
    // The configured MiniMax M3 stream emits "" on partial chunks, then a
    // normal terminal and usage at EOF. Treat only that observed placeholder
    // as absent; other models and markers still follow the strict protocol.
    const acceptsEmptyPartialFinish = /(?:^|\/)minimax-m3$/i.test(context.model.trim())
    const terminals = new Map<number, string>()
    let eofEligible =
      request.stream === true &&
      Number.isSafeInteger(expectedChoices) &&
      expectedChoices >= 1 &&
      expectedChoices <= 128
    const eofRejections = new Set<ModelResponseEofRejection>()
    const rejectEof = (reason: ModelResponseEofRejection): void => {
      eofEligible = false
      eofRejections.add(reason)
    }
    if (request.stream !== true) rejectEof("not_stream_request")
    if (!Number.isSafeInteger(expectedChoices) || expectedChoices < 1 || expectedChoices > 128)
      rejectEof("invalid_expected_choices")
    let terminalUsage = false
    let eventType = ""
    const normalFinishReasons = ["stop", "tool_calls", "function_call", "content_filter"]
    const allFinishReasons = [...normalFinishReasons, "length"]
    const recordUsage = (parsed: unknown): boolean => {
      const usage = (
        parsed as {
          usage?: {
            completion_tokens?: unknown
            output_tokens?: unknown
            prompt_tokens?: unknown
            input_tokens?: unknown
            prompt_tokens_details?: { cached_tokens?: unknown }
            input_tokens_details?: { cached_tokens?: unknown }
            completion_tokens_details?: { reasoning_tokens?: unknown }
            output_tokens_details?: { reasoning_tokens?: unknown }
          }
        }
      )?.usage
      const counts = {
        outputTokens: usage?.completion_tokens ?? usage?.output_tokens,
        inputTokens: usage?.prompt_tokens ?? usage?.input_tokens,
        cacheReadTokens:
          usage?.prompt_tokens_details?.cached_tokens ?? usage?.input_tokens_details?.cached_tokens,
        reasoningTokens:
          usage?.completion_tokens_details?.reasoning_tokens ??
          usage?.output_tokens_details?.reasoning_tokens
      }
      for (const key of Object.keys(counts) as (keyof typeof counts)[]) {
        const count = counts[key]
        if (typeof count === "number" && Number.isSafeInteger(count) && count >= 0)
          diagnostic[key] = Math.max(diagnostic[key] ?? 0, count)
      }
      return (
        typeof counts.outputTokens === "number" &&
        Number.isSafeInteger(counts.outputTokens) &&
        counts.outputTokens >= 0
      )
    }
    const observeTerminals = (parsed: unknown): void => {
      const choices = (parsed as { choices?: unknown })?.choices
      if (!Number.isSafeInteger(expectedChoices) || expectedChoices < 1 || expectedChoices > 128) {
        rejectEof("invalid_expected_choices")
        return
      }
      if (!Array.isArray(choices) || choices.length > expectedChoices) {
        rejectEof("invalid_choices")
        return
      }
      for (const choice of choices) {
        const index: unknown = choice?.index,
          delta: unknown = choice?.delta
        if (
          typeof index !== "number" ||
          !Number.isSafeInteger(index) ||
          index < 0 ||
          index >= expectedChoices
        ) {
          rejectEof("invalid_choice_index")
          continue
        }
        if (!delta || typeof delta !== "object" || Array.isArray(delta)) {
          rejectEof("invalid_delta")
          continue
        }
        const fields = delta as Record<string, unknown>
        if (
          terminals.has(index) &&
          Object.values(fields).some((value) =>
            typeof value === "string" ? value.length > 0 : value !== null && value !== undefined
          )
        )
          rejectEof("delta_after_terminal")
        const reason: unknown = choice.finish_reason
        if (reason === null || reason === undefined) continue
        if (reason === "" && acceptsEmptyPartialFinish && !terminals.has(index)) {
          diagnostic.nonterminalFinishPlaceholders =
            (diagnostic.nonterminalFinishPlaceholders ?? 0) + 1
          continue
        }
        if (typeof reason !== "string" || !allFinishReasons.includes(reason)) {
          const kind: ModelResponseInvalidFinishKind =
            typeof reason === "string"
              ? reason.length
                ? "unknown_string"
                : "empty_string"
              : typeof reason === "number"
                ? "number"
                : typeof reason === "boolean"
                  ? "boolean"
                  : Array.isArray(reason)
                    ? "array"
                    : "object"
          diagnostic.invalidFinishReasonKinds ??= []
          if (!diagnostic.invalidFinishReasonKinds.includes(kind))
            diagnostic.invalidFinishReasonKinds.push(kind)
          rejectEof("invalid_finish_reason")
          continue
        }
        const previous = terminals.get(index)
        if (previous && previous !== reason) rejectEof("changed_finish_reason")
        terminals.set(index, reason)
        if (!normalFinishReasons.includes(reason)) rejectEof("truncated_finish")
      }
      diagnostic.terminalFinishEvents = terminals.size
      diagnostic.terminalFinishReasons = [...new Set(terminals.values())]
    }
    const finishEvent = (): void => {
      if (eventType && eventType !== "message") {
        rejectEof("unsupported_event_type")
        if (eventType === "error") diagnostic.errorEvents += 1
        else diagnostic.uninspectedEvents += 1
      }
      if (oversized) diagnostic.uninspectedEvents += 1
      else if (event) {
        diagnostic.dataEvents += 1
        if (event.trim() === "[DONE]") diagnostic.doneEvents += 1
        else {
          try {
            const parsed = JSON.parse(event)
            observeTerminals(parsed)
            const hasUsage = recordUsage(parsed)
            if (parsed?.usage !== undefined && parsed.usage !== null && !hasUsage)
              rejectEof("invalid_usage")
            if (hasUsage && terminals.size === expectedChoices) terminalUsage = true
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
      eventType = ""
      oversized = false
    }
    const consumeLine = (): void => {
      const value = line
      if (!value) finishEvent()
      else if (value.startsWith("event:")) eventType = value.slice(6).trim()
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
      // Inspect a bounded JSON receipt only after EOF. Forward all bytes without
      // waiting for parsing, cloning a second body or logging any model content.
      if (diagnostic.format === "json") {
        if (!oversizedJson && json.length + text.length <= MAX_JSON_CHARS) json += text
        else {
          oversizedJson = true
          json = ""
        }
        return
      }
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
          const unfinishedEvent = !!(line || event || oversized || eventType)
          if (diagnostic.format === "json") {
            if (oversizedJson) diagnostic.uninspectedEvents += 1
            else
              try {
                const parsed = JSON.parse(json)
                if (parsed?.error) diagnostic.errorEvents += 1
                const choices: unknown = parsed?.choices
                if (
                  Array.isArray(choices) &&
                  choices.length > 0 &&
                  choices.every(
                    (choice) =>
                      choice?.message &&
                      ["stop", "length", "tool_calls", "function_call", "content_filter"].includes(
                        choice.finish_reason
                      )
                  )
                ) {
                  diagnostic.messageEvents = choices.length
                  diagnostic.doneEvents = 1
                  recordUsage(parsed)
                }
              } catch {
                diagnostic.uninspectedEvents += 1
              }
          } else {
            if (line) consumeLine()
            if (event || oversized) finishEvent()
            if (diagnostic.format === "sse" && diagnostic.doneEvents === 0) {
              if (unfinishedEvent) eofRejections.add("unfinished_event")
              if (terminals.size !== expectedChoices) eofRejections.add("missing_terminal")
              if (!terminalUsage) eofRejections.add("missing_terminal_usage")
              if (diagnostic.errorEvents > 0) eofRejections.add("protocol_error")
              if (diagnostic.uninspectedEvents > 0) eofRejections.add("uninspected_event")
              diagnostic.eofRejectionReasons = [...eofRejections]
            }
            // The SDK accepts normal EOF. Do not equate EOF alone with a usage
            // receipt: every requested choice must have a normal terminal event,
            // followed by provider usage, with no incomplete/error/unknown frame.
            // A length-truncated EOF retains its reservation unless [DONE] exists.
            if (
              diagnostic.format === "sse" &&
              diagnostic.doneEvents === 0 &&
              !unfinishedEvent &&
              eofEligible &&
              terminals.size === expectedChoices &&
              terminalUsage &&
              diagnostic.errorEvents === 0 &&
              diagnostic.uninspectedEvents === 0
            ) {
              diagnostic.doneEvents = 1
              diagnostic.eofCompleted = true
            }
          }
          safeReport()
        }
      })
    )
    return inheritModelResponseHeaders(
      response,
      new Response(body, {
        status: response.status,
        statusText: response.statusText,
        headers: response.headers
      })
    )
  }
}
