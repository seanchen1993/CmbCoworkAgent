import {
  MODEL_RESPONSE_EOF_REJECTION_REASONS,
  MODEL_RESPONSE_INVALID_FINISH_KINDS,
  type ModelResponseDiagnostic
} from "../agent/model-response-diagnostics"
import type { BotModelUsagePurpose } from "../../shared/bot-model-usage"
import { modelResponseHeaders, safeModelRequestId } from "../models/model-response-headers"
import {
  botModelAttemptStarted,
  botModelAttemptResponse,
  captureBotModelAttemptFailure
} from "./model-error-diagnostic-scope"

/** Correlate protocol diagnostics with the already committed usage identity.
 * Explicit per-request ownership avoids attributing a shared client's callbacks
 * to whichever Bot happened to create that client first. No payloads or URLs. */
export function botModelCallDiagnostics(input: {
  callId: string
  botId: string
  runId?: string
  rootRunId?: string
  purpose: BotModelUsagePurpose
  knownSecrets?: readonly string[]
}) {
  const identity = {
    callId: input.callId,
    botId: input.botId,
    runId: input.runId ?? null,
    rootRunId: input.rootRunId ?? null,
    purpose: input.purpose
  }
  const started = performance.now()
  let finished = false
  const write = (phase: string, details: Record<string, unknown> = {}) => {
    try {
      // Host's existing bounded, redacted, rotating logger also supplies the
      // process identity and timestamp. Logging failure cannot fail execution.
      console.info("[BotModelCall]", {
        ...identity,
        phase,
        elapsedMs: Math.max(0, Math.round(performance.now() - started)),
        ...details
      })
    } catch {
      /* Diagnostic sinks are best effort; the usage reservation is durable. */
    }
  }
  const requestId = (value: string | null) => safeModelRequestId(value, input.knownSecrets) ?? null
  return {
    async send(fetchImpl: typeof fetch, url: Parameters<typeof fetch>[0], init?: RequestInit) {
      write("started")
      botModelAttemptStarted(input.callId)
      try {
        const response = await fetchImpl(url, init)
        const headers = modelResponseHeaders(response, input.knownSecrets)
        botModelAttemptResponse({
          callId: input.callId,
          status: headers.status,
          requestId: headers.requestId
        })
        finished = !response.ok
        write(response.ok ? "response" : "http_rejected", {
          status: response.status,
          requestId: headers.requestId ?? null
        })
        return response
      } catch (error) {
        captureBotModelAttemptFailure(error, { callId: input.callId }, input.knownSecrets)
        finished = true
        write("transport_failed", { aborted: init?.signal?.aborted === true })
        // Provider errors may contain secrets and user text. Propagate through
        // the existing runtime policy without copying their text into this log.
        throw error
      }
    },
    complete(usage: ModelResponseDiagnostic) {
      if (finished) return
      finished = true
      write("stream_ended", {
        status: usage.status,
        requestId: requestId(usage.requestId),
        format: usage.format,
        bytes: usage.bytes,
        protocolComplete:
          usage.doneEvents > 0 && usage.errorEvents === 0 && usage.uninspectedEvents === 0,
        doneEvents: usage.doneEvents,
        errorEvents: usage.errorEvents,
        uninspectedEvents: usage.uninspectedEvents,
        eofCompleted: usage.eofCompleted === true,
        eofRejectionReasons: MODEL_RESPONSE_EOF_REJECTION_REASONS.filter((reason) =>
          usage.eofRejectionReasons?.includes(reason)
        ),
        invalidFinishReasonKinds: MODEL_RESPONSE_INVALID_FINISH_KINDS.filter((kind) =>
          usage.invalidFinishReasonKinds?.includes(kind)
        ),
        nonterminalFinishPlaceholders: usage.nonterminalFinishPlaceholders ?? 0,
        terminalFinishEvents: usage.terminalFinishEvents ?? 0,
        terminalFinishReasons: [
          "stop",
          "tool_calls",
          "function_call",
          "content_filter",
          "length"
        ].filter((reason) => usage.terminalFinishReasons?.includes(reason)),
        inputTokensReported: usage.inputTokens ?? null,
        outputTokensReported: usage.outputTokens ?? null
      })
    }
  }
}
