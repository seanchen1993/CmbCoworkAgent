import type {
  AgentRunExecutionContext,
  AgentRunFinalAssistant,
  AgentRunGoalNotice,
  AgentRunTerminal
} from "../../agent/agent-run-service"

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
        throw new DOMException(options.cancelledMessage ?? "Managed run was cancelled", "AbortError")
      }

      // A failed run still resolves its completion promise. Rethrowing the
      // original keeps the caller's retry classification working:
      // isRetryableApiError still sees the provider error it was written for,
      // instead of a generic "no reply".
      const outcome = terminal as AgentRunTerminal | null
      if (outcome && outcome.outcome !== "success") {
        if (outcome.error instanceof Error) throw outcome.error
        throw new Error(outcome.message?.trim() || `本轮运行以 ${outcome.code} 结束。`)
      }

      const reply = (finalText as string | null)?.trim()
      if (reply) return reply
      const notice = notices.at(-1)?.message.trim()
      if (notice) return notice
      return onEmpty()
    }
  }
}
