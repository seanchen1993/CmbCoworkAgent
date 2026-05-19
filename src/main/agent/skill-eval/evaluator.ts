import type { AgentTrace, TraceNode } from "../trace/types"
import type { SkillEvalCheck, SkillEvalRecord } from "./types"

const PASS_THRESHOLD = 0.7

function parseSkill(raw: string): { skillName: string; skillVersion?: string } {
  const text = String(raw || "").trim()
  const match = text.match(/^(.*?)-(v\d+(?:\.\d+){0,3})$/)
  if (!match) return { skillName: text || "unknown" }
  return { skillName: match[1] || text, skillVersion: match[2] }
}

function nodeHasError(node: TraceNode): boolean {
  return (
    node.status === "error" ||
    node.type === "error" ||
    Boolean(node.metadata?.error)
  )
}

function countErrorNodes(trace: AgentTrace): number {
  return (trace.nodes ?? []).filter(nodeHasError).length
}

function countToolNodes(trace: AgentTrace): number {
  const nodeCount = (trace.nodes ?? []).filter((node) => node.type === "tool").length
  if (nodeCount > 0) return nodeCount
  return trace.steps.reduce((sum, step) => sum + step.toolCalls.length, 0)
}

function buildChecks(trace: AgentTrace, errorCount: number, toolCalls: number): SkillEvalCheck[] {
  return [
    {
      name: "trace_outcome_success",
      label: "任务成功结束",
      ok: trace.outcome === "success",
      weight: 3,
      detail: { outcome: trace.outcome }
    },
    {
      name: "skill_detected",
      label: "识别到 skill 使用",
      ok: trace.usedSkills.length > 0,
      weight: 2,
      detail: { usedSkills: trace.usedSkills }
    },
    {
      name: "no_tool_errors",
      label: "工具调用无错误",
      ok: errorCount === 0,
      weight: 2,
      detail: { errorCount }
    },
    {
      name: "tool_budget_reasonable",
      label: "工具调用预算合理",
      ok: toolCalls <= 40,
      weight: 1,
      detail: { totalToolCalls: toolCalls, max: 40 }
    }
  ]
}

function scoreChecks(checks: SkillEvalCheck[]): number {
  const totalWeight = checks.reduce((sum, check) => sum + check.weight, 0) || 1
  const earned = checks.reduce((sum, check) => sum + (check.ok ? check.weight : 0), 0)
  return Number((earned / totalWeight).toFixed(4))
}

function buildWarnings(trace: AgentTrace, errorCount: number, toolCalls: number): string[] {
  const warnings: string[] = []
  if (trace.outcome !== "success") warnings.push(`任务结果为 ${trace.outcome}`)
  if (errorCount > 0) warnings.push(`检测到 ${errorCount} 个错误节点`)
  if (toolCalls > 40) warnings.push(`工具调用 ${toolCalls} 次，超过默认预算 40`)
  return warnings
}

export function evaluateTraceSkills(trace: AgentTrace): SkillEvalRecord[] {
  if (!Array.isArray(trace.usedSkills) || trace.usedSkills.length === 0) return []

  const errorCount = countErrorNodes(trace)
  const toolCalls = typeof trace.totalToolCalls === "number" ? trace.totalToolCalls : countToolNodes(trace)
  const checks = buildChecks(trace, errorCount, toolCalls)
  const score = scoreChecks(checks)
  const pass = score >= PASS_THRESHOLD
  const warnings = buildWarnings(trace, errorCount, toolCalls)
  const evaluatedAt = new Date().toISOString()

  return trace.usedSkills.map((rawSkillName) => {
    const { skillName, skillVersion } = parseSkill(rawSkillName)
    return {
      id: `${trace.traceId}:${rawSkillName}`,
      traceId: trace.traceId,
      threadId: trace.threadId,
      skillName,
      ...(skillVersion ? { skillVersion } : {}),
      rawSkillName,
      startedAt: trace.startedAt,
      endedAt: trace.endedAt,
      evaluatedAt,
      userMessage: trace.userMessage,
      modelId: trace.modelId,
      ...(trace.modelName ? { modelName: trace.modelName } : {}),
      outcome: trace.outcome,
      durationMs: trace.durationMs,
      totalToolCalls: toolCalls,
      errorCount,
      score,
      pass,
      checks,
      warnings
    }
  })
}
