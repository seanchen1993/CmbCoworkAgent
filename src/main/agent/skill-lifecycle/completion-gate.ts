/** Internal host contract, not an upstream Function Mods SDK event. */
export type CompletionGateDecision =
  | { decision: "pass" }
  | { decision: "revise" | "block"; reason: string }

export interface CompletionGateInput {
  signal: AbortSignal
  revisionAttempts: number
  maxRevisionAttempts: number
}

/** Unknown is intentional: a plugin/IPC adapter must not gain trust via a TS cast. */
export type CompletionGate = (input: CompletionGateInput) => Promise<unknown>

export function parseCompletionGateDecision(value: unknown): CompletionGateDecision {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw Error("COMPLETION_GATE_INVALID_RESULT")
  const record = value as Record<string, unknown>
  if (record.decision === "pass" && Object.keys(record).length === 1) return { decision: "pass" }
  if (
    (record.decision === "revise" || record.decision === "block") &&
    typeof record.reason === "string" &&
    record.reason.trim().length > 0 &&
    record.reason.length <= 8000 &&
    Object.keys(record).every((key) => key === "decision" || key === "reason")
  )
    return { decision: record.decision, reason: record.reason }
  throw Error("COMPLETION_GATE_INVALID_RESULT")
}
