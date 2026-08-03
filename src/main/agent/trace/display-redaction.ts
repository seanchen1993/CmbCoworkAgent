import { redactLogValue, redactSensitiveText } from "../../log-redaction"
import type {
  TraceNode,
  TraceSkillEvalArtifact,
  TraceSkillEvalCheck,
  TraceSkillEvalRecord
} from "./types"

function redactUnknown(value: unknown): unknown {
  return redactLogValue(value)
}

function redactRecord(value: Record<string, unknown>): Record<string, unknown> {
  const redacted = redactUnknown(value)
  return redacted && typeof redacted === "object" && !Array.isArray(redacted)
    ? (redacted as Record<string, unknown>)
    : {}
}

/**
 * Return a detached Trace node that is safe to cross the dashboard IPC boundary.
 * Structural identifiers stay intact; only user-controlled display content is redacted.
 */
export function redactTraceNodeForDisplay(node: TraceNode): TraceNode {
  return {
    ...node,
    ...(node.name ? { name: redactSensitiveText(node.name) } : {}),
    ...(node.input !== undefined ? { input: redactUnknown(node.input) } : {}),
    ...(node.output !== undefined ? { output: redactUnknown(node.output) } : {}),
    ...(node.metadata !== undefined ? { metadata: redactRecord(node.metadata) } : {})
  }
}

export interface TraceDisplayDetail {
  userMessage: string
  nodes?: TraceNode[]
  rawError?: string
}

/** Redact the complete Trace detail object returned by dashboard IPC handlers. */
export function redactTraceDetailForDisplay<T extends TraceDisplayDetail>(trace: T): T {
  return {
    ...trace,
    userMessage: redactSensitiveText(trace.userMessage ?? ""),
    ...(Array.isArray(trace.nodes)
      ? { nodes: trace.nodes.map((node) => redactTraceNodeForDisplay(node)) }
      : {}),
    ...(trace.rawError ? { rawError: redactSensitiveText(trace.rawError) } : {})
  }
}

function redactSkillEvalCheckForDisplay(check: TraceSkillEvalCheck): TraceSkillEvalCheck {
  return {
    ...check,
    label: redactSensitiveText(check.label),
    ...(check.detail !== undefined ? { detail: redactRecord(check.detail) } : {})
  }
}

function redactSkillEvalArtifactForDisplay(
  artifact: TraceSkillEvalArtifact
): TraceSkillEvalArtifact {
  return {
    ...artifact,
    label: redactSensitiveText(artifact.label)
  }
}

function redactStrings(values: string[] | undefined): string[] {
  return (values ?? []).map((value) => redactSensitiveText(value))
}

/**
 * Redact the free-form content copied into a skill-evaluation record without
 * changing its identity, scores, counters, or trace linkage.
 */
export function redactTraceSkillEvalRecordForDisplay(
  record: TraceSkillEvalRecord
): TraceSkillEvalRecord {
  return {
    ...record,
    userMessage: redactSensitiveText(record.userMessage ?? ""),
    checks: (record.checks ?? []).map(redactSkillEvalCheckForDisplay),
    outcomeChecks: (record.outcomeChecks ?? []).map(redactSkillEvalCheckForDisplay),
    resultChecks: (record.resultChecks ?? []).map(redactSkillEvalCheckForDisplay),
    warnings: redactStrings(record.warnings),
    outcomeWarnings: redactStrings(record.outcomeWarnings),
    resultWarnings: redactStrings(record.resultWarnings),
    resultIssues: redactStrings(record.resultIssues),
    artifacts: (record.artifacts ?? []).map(redactSkillEvalArtifactForDisplay)
  }
}
