import type { FlowAttempt, FlowDefinition } from "./types"

export const PROMPT_ONLY_PRIOR_MAX_BYTES = 64 * 1024
export interface PromptOnlyPriorProjection {
  version: "prompt-only-prior-v1"
  text: string
  utf8Bytes: number
}

/**
 * Pure serialization of host-validated receipts, never authority to reuse them.
 * Host must independently verify their runtime evidence and current dependencies.
 * Do not pass current running/check/approval attempts as Agent receipts.
 */
export function projectPromptOnlyPrior(
  definition: FlowDefinition,
  targetStepId: string,
  receipts: readonly FlowAttempt[]
): PromptOnlyPriorProjection {
  if (definition.schemaVersion !== 2 || definition.execution.profile !== "prompt-only-v1")
    throw Error("FLOW_PROMPT_PROFILE_REQUIRED")
  const target = definition.steps.findIndex((step) => step.id === targetStepId)
  if (target < 0 || definition.steps[target].kind !== "agent" || !definition.steps[target].enabled)
    throw Error("FLOW_PROMPT_CONTEXT_INVALID")
  const expected = definition.steps
    .slice(0, target)
    .filter((step) => step.enabled && step.kind === "agent")
  if (!Array.isArray(receipts) || receipts.length !== expected.length)
    throw Error("FLOW_PROMPT_CONTEXT_INVALID")
  const rows = expected.map((step, index) => {
    const receipt = receipts[index]
    if (
      !receipt ||
      receipt.stepId !== step.id ||
      receipt.status !== "passed" ||
      receipt.invalidated ||
      receipt.epoch !== 0 ||
      receipt.attempt !== 1 ||
      receipt.result?.source !== "agent" ||
      receipt.result.passed !== true ||
      typeof receipt.result.summary !== "string" ||
      !receipt.result.summary.trim() ||
      receipt.result.summary.length > 8000
    )
      throw Error("FLOW_PROMPT_CONTEXT_INVALID")
    return { stepId: step.id, summary: receipt.result.summary }
  })
  const text = JSON.stringify(rows)
  const utf8Bytes = new TextEncoder().encode(text).byteLength
  if (utf8Bytes > PROMPT_ONLY_PRIOR_MAX_BYTES) throw Error("FLOW_PROMPT_CONTEXT_LIMIT")
  return { version: "prompt-only-prior-v1", text, utf8Bytes }
}
