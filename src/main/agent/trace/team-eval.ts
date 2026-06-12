import type { AgentTrace, TraceOutcome, TraceSkillEvalExtension } from "./types"
import type { SkillEvalWindowContext } from "../skill-eval/window"
import { buildSkillEvalTraceExtension } from "../skill-eval/documents"

function uniqueStrings(values: string[]): string[] {
  return Array.from(new Set(values.filter(Boolean)))
}

function timestampMs(value: string | undefined): number {
  if (!value) return 0
  const ms = new Date(value).getTime()
  return Number.isNaN(ms) ? 0 : ms
}

function earliestIso(values: string[]): string {
  return values.filter(Boolean).sort((a, b) => timestampMs(a) - timestampMs(b))[0] ?? ""
}

function latestIso(values: string[]): string {
  return values.filter(Boolean).sort((a, b) => timestampMs(b) - timestampMs(a))[0] ?? ""
}

function wallClockDurationMs(startedAt: string, endedAt: string, fallback: number): number {
  const started = timestampMs(startedAt)
  const ended = timestampMs(endedAt)
  if (started > 0 && ended >= started) return ended - started
  return fallback
}

function teamOutcome(traces: AgentTrace[]): TraceOutcome {
  if (traces.some((trace) => trace.outcome === "error")) return "error"
  if (traces.some((trace) => trace.outcome === "cancelled")) return "cancelled"
  if (traces.some((trace) => trace.outcome === "unknown")) return "unknown"
  return "success"
}

function sumToolCalls(trace: AgentTrace): number {
  if (typeof trace.totalToolCalls === "number" && Number.isFinite(trace.totalToolCalls)) {
    return trace.totalToolCalls
  }
  return (trace.nodes ?? []).filter((node) => node.type === "tool").length
}

function buildTeamWindowContexts(
  coordinatorTrace: AgentTrace,
  rawSkillNames: string[],
  traceIds: string[]
): Record<string, SkillEvalWindowContext> {
  const contextTraceIds = uniqueStrings(traceIds)
  const skillEvalTraceIds = uniqueStrings(traceIds)
  return Object.fromEntries(
    rawSkillNames.map((rawSkillName) => [
      rawSkillName,
      {
        skillTaskId: `${coordinatorTrace.threadId}:${rawSkillName}:${coordinatorTrace.traceId}`,
        skillTaskTraceIndex: 0,
        contextTraceIds,
        skillEvalTraceIds,
        contextTraceCount: contextTraceIds.length,
        skillEvalTraceCount: skillEvalTraceIds.length
      }
    ])
  )
}

export function buildTeamEvalTrace(
  coordinatorTrace: AgentTrace,
  workerTraces: AgentTrace[]
): AgentTrace {
  const traces = [coordinatorTrace, ...workerTraces].filter(Boolean)
  const traceIds = uniqueStrings(traces.map((trace) => trace.traceId))
  const startedAt =
    earliestIso(traces.map((trace) => trace.startedAt)) || coordinatorTrace.startedAt
  const endedAt = latestIso(traces.map((trace) => trace.endedAt)) || coordinatorTrace.endedAt
  let stepIndex = 0

  return {
    ...coordinatorTrace,
    traceId: coordinatorTrace.traceId,
    threadId: coordinatorTrace.threadId,
    traceRole: "coordinator",
    startedAt,
    endedAt,
    durationMs: wallClockDurationMs(
      startedAt,
      endedAt,
      traces.reduce((sum, trace) => sum + (trace.durationMs || 0), 0)
    ),
    outcome: teamOutcome(traces),
    errorMessage: traces.find((trace) => trace.errorMessage)?.errorMessage,
    steps: traces.flatMap((trace) =>
      (trace.steps ?? []).map((step) => ({
        ...step,
        index: stepIndex++
      }))
    ),
    modelCalls: traces.flatMap((trace) => trace.modelCalls ?? []),
    nodes: traces.flatMap((trace) => trace.nodes ?? []),
    totalToolCalls: traces.reduce((sum, trace) => sum + sumToolCalls(trace), 0),
    usedSkills: uniqueStrings(traces.flatMap((trace) => trace.usedSkills ?? [])),
    evolvedSkills: uniqueStrings(traces.flatMap((trace) => trace.evolvedSkills ?? [])),
    metadata: {
      ...(coordinatorTrace.metadata ?? {}),
      teamEval: {
        aggregated: true,
        coordinatorTraceId: coordinatorTrace.traceId,
        traceIds,
        workerTraceIds: workerTraces.map((trace) => trace.traceId)
      }
    }
  }
}

export function buildTeamSkillEvalExtension(
  coordinatorTrace: AgentTrace,
  workerTraces: AgentTrace[]
): TraceSkillEvalExtension | undefined {
  const teamTrace = buildTeamEvalTrace(coordinatorTrace, workerTraces)
  const rawSkillNames = uniqueStrings(teamTrace.usedSkills ?? [])
  if (rawSkillNames.length === 0) return undefined

  const traceIds = uniqueStrings([
    coordinatorTrace.traceId,
    ...workerTraces.map((trace) => trace.traceId)
  ])
  return buildSkillEvalTraceExtension(teamTrace, {
    evalRawSkillNames: rawSkillNames,
    windowContextByRawName: buildTeamWindowContexts(coordinatorTrace, rawSkillNames, traceIds)
  })
}
