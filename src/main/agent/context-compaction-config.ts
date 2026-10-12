/** Original Cmb context budgets and handoff contract, shared by desktop and Bot Host. */
import {
  calculateModelInputBudgetTokens,
  calculateSummarizationKeepTokens,
  calculateSummarizationTriggerTokens
} from "../../shared/model-token-budget"

export const CONTEXT_COMPACTION_MAX_OUTPUT_TOKENS = 20_000
// Used only after the summary request itself reports context overflow. Normal compaction
// sends the complete old history so user intent is not discarded before summarization.
const SUMMARY_OVERFLOW_RETRY_TARGET_RATIO = 0.65
const SUMMARY_OVERFLOW_RETRY_TOKEN_CAP = 700_000

export function calculateSummaryOverflowRetryTargetTokens(
  contextWindowTokens: number,
  summaryMaxOutputTokens: number
): number {
  return Math.min(
    SUMMARY_OVERFLOW_RETRY_TOKEN_CAP,
    Math.floor(contextWindowTokens * SUMMARY_OVERFLOW_RETRY_TARGET_RATIO),
    calculateModelInputBudgetTokens(contextWindowTokens, summaryMaxOutputTokens)
  )
}

export const CMB_COWORK_SUMMARY_PROMPT = `Create a compact continuation handoff from the structured conversation messages above. The next agent must be able to continue without redoing completed work.

Use these exact headings:
## Goal
## Constraints
## Completed
## Current State
## Blockers
## Key Decisions
## Next Step
## Critical Evidence

Use concise, high-information bullets. Preserve exact user corrections, file paths, symbols, commands, test results, errors, identifiers, configuration values, Git state, and unresolved decisions when they matter. Explicitly preserve unresolved contradictions between user requirements, current source code, tests, compiled artifacts, workflow reports, and claimed verification results. Do not let a later conclusion hide conflicting evidence. Treat any <previous-summary> as authoritative context: retain facts that are still true, update changed facts, and remove stale facts. If the latest request is complete, say so under Next Step instead of inventing work. Preserve the user's language for user-facing details. Do not include private reasoning, generic narrative, a verbatim transcript, or full code unless exact code is essential.`

export function createContextCompactionConfig(
  contextWindowTokens: number,
  configuredMaxOutputTokens: number
) {
  const triggerTokens = calculateSummarizationTriggerTokens(
    contextWindowTokens,
    configuredMaxOutputTokens
  )
  const mainModelInputBudget = calculateModelInputBudgetTokens(
    contextWindowTokens,
    configuredMaxOutputTokens
  )
  const summaryMaxOutputTokens = Math.min(
    configuredMaxOutputTokens,
    CONTEXT_COMPACTION_MAX_OUTPUT_TOKENS
  )
  const summaryInputBudget = calculateModelInputBudgetTokens(
    contextWindowTokens,
    summaryMaxOutputTokens
  )
  const keepTokens = calculateSummarizationKeepTokens(contextWindowTokens)
  const toolEvictLimit = Math.min(20_000, Math.max(Math.floor(contextWindowTokens * 0.08), 6_000))
  const summaryOverflowRetryTarget = calculateSummaryOverflowRetryTargetTokens(
    contextWindowTokens,
    summaryMaxOutputTokens
  )
  return {
    triggerTokens,
    mainModelInputBudget,
    summaryMaxOutputTokens,
    summaryInputBudget,
    keepTokens,
    toolEvictLimit,
    summaryOverflowRetryTarget,
    graphOptions: {
      summarizationTrigger: { type: "tokens" as const, value: triggerTokens },
      summarizationKeep: { type: "tokens" as const, value: keepTokens },
      toolTokenLimitBeforeEvict: toolEvictLimit,
      trimTokensToSummarize: summaryOverflowRetryTarget,
      summarizationMaxInputTokens: contextWindowTokens,
      summarizationPostCompactionInputBudgetTokens: mainModelInputBudget,
      summarizationSummaryPrompt: CMB_COWORK_SUMMARY_PROMPT,
      summarizationTruncateArgsSettings: {
        trigger: { type: "tokens" as const, value: triggerTokens },
        keep: { type: "tokens" as const, value: keepTokens },
        maxLength: 2000
      }
    }
  }
}
