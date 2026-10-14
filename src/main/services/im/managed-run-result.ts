import type {
  AgentRunExecutionContext,
  AgentRunFinalAssistant,
  AgentRunGoalNotice,
  AgentRunTerminal
} from "../../agent/agent-run-service"
import {
  ImCompletionHookRejectedError,
  ImPreparedPromptRejectedError,
  ImTurnIncompleteError
} from "./turn-failures"

/**
 * The run body's single code for "ran, did not crash, is not complete": a Stop
 * hook halting the turn, a blocked goal, and — since the turn-completion gate
 * landed — an unresolved protocol defect or todos the model left open. The run
 * body mints no separate code for those on purpose, so that managed callers
 * keep one incomplete rule (see the gate's note in agent.ts). The terminal
 * guarantee also reports it for a run that exits without classifying itself.
 */
const INCOMPLETE_TERMINAL_CODE = "unknown"

/** Used when the terminal carried no reason of its own — the unclassified exit. */
const UNCLASSIFIED_INCOMPLETE_REASON = "本轮以未知状态结束，结果可能不完整。"

/**
 * Collects what a managed run produced and turns it into the one string an IM
 * reply needs.
 *
 * Both IM entry points — an ordinary turn and a Goal turn — drive the same run
 * body and face the same problem: the run body reports failures to the renderer
 * and then resolves normally, so "no final text" is ambiguous between a
 * successful tool-only turn and a provider error. Collecting that in one place
 * is why the two paths cannot drift apart on it again.
 */
export interface ManagedRunResultCollector {
  /** Spread into the AgentRunExecutionContext handed to startAgentRun. */
  readonly hooks: Pick<
    AgentRunExecutionContext,
    "onGoalNotice" | "onFinalAssistant" | "onRunCancelled" | "onRunTerminated"
  >
  /**
   * Resolves the reply, or throws.
   *
   * A returned string does not always mean the turn succeeded: an incomplete
   * turn that still wrote an answer returns that answer with the reason
   * appended, because the alternative is discarding usable work.
   *
   * `onEmpty` decides what a *successful* run with nothing to say means for
   * this caller — an ordinary turn answers with a placeholder, a Goal turn
   * treats it as an error — so it may return a string or throw.
   */
  resolve(onEmpty: () => string): string
}

export interface ManagedRunResultOptions {
  /** Chained after the collector records it, for callers that also observe it. */
  onFinalAssistant?: (result: AgentRunFinalAssistant) => void | Promise<void>
  cancelledMessage?: string
}

export function createManagedRunResultCollector(
  options: ManagedRunResultOptions = {}
): ManagedRunResultCollector {
  const notices: AgentRunGoalNotice[] = []
  let finalText: string | null = null
  let cancelled = false
  let terminal: AgentRunTerminal | null = null

  return {
    hooks: {
      onGoalNotice: (notice) => notices.push(notice),
      onFinalAssistant: async (result) => {
        finalText = result.finalText
        await options.onFinalAssistant?.(result)
      },
      onRunCancelled: () => {
        cancelled = true
      },
      onRunTerminated: (result) => {
        terminal = result
      }
    },

    resolve(onEmpty) {
      if (cancelled) {
        throw new DOMException(
          options.cancelledMessage ?? "Managed run was cancelled",
          "AbortError"
        )
      }

      // A failed run still resolves its completion promise. Rethrowing the
      // original keeps the caller's retry classification working:
      // isRetryableApiError still sees the provider error it was written for,
      // instead of a generic "no reply".
      const outcome = terminal as AgentRunTerminal | null
      if (outcome && outcome.outcome !== "success") {
        const reason = outcome.message?.trim() || `本轮运行以 ${outcome.code} 结束。`
        // A blocked turn is not a broken one. The IM runner maps a thrown error
        // to a reason code by instanceof, so losing the classification here
        // turns "your message was stopped by policy" into a generic robot
        // failure — and a retryable-looking one at that.
        if (outcome.code === "prompt_blocked") throw new ImPreparedPromptRejectedError(reason)
        if (outcome.code === "hook_halt") throw new ImCompletionHookRejectedError(reason)
        // An incomplete turn often still produced a usable answer — the gate
        // bounces a turn for HOW it ended, not for what it wrote. Desktop shows
        // that text and the reason side by side; IM has one message, so it
        // carries both. Throwing here instead would answer a working turn with
        // a bare short code, and returning the text alone would claim a turn
        // finished when it did not.
        if (outcome.code === INCOMPLETE_TERMINAL_CODE) {
          const detail = outcome.message?.trim() || UNCLASSIFIED_INCOMPLETE_REASON
          const partial = (finalText as string | null)?.trim()
          if (partial) return `${partial}\n\n${detail}`
          throw new ImTurnIncompleteError(detail)
        }
        // Everything else keeps the original error, so isRetryableApiError
        // still sees the provider error it was written for.
        if (outcome.error instanceof Error) throw outcome.error
        throw new Error(reason)
      }

      const reply = (finalText as string | null)?.trim()
      if (reply) return reply
      const notice = notices.at(-1)?.message.trim()
      if (notice) return notice
      return onEmpty()
    }
  }
}
