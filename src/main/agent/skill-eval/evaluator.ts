import type { AgentTrace, TraceNode } from "../trace/types"
import { parseSkillNameVersionIdentifier } from "../../utils/skill-identifiers"

const DEFAULT_SKILL_EVAL_TOOL_BUDGET = 40

export interface SkillEvalCheck {
  name: string
  label: string
  ok: boolean
  weight: number
  detail?: Record<string, unknown>
}

export interface SkillEvalRecord {
  id: string
  traceId: string
  threadId: string
  skillName: string
  skillVersion?: string
  rawSkillName: string
  startedAt: string
  endedAt: string
  evaluatedAt: string
  userMessage: string
  modelId: string
  modelName?: string
  outcome: string
  durationMs: number
  totalToolCalls: number
  modelCallCount: number
  totalInputTokens: number
  totalOutputTokens: number
  promptInputTokens: number
  totalTokens: number
  cacheReadTokens: number
  cacheCreationTokens: number
  peakInputTokens: number
  totalTokensIncludesCache: boolean | "mixed"
  /** @deprecated use peakInputTokens */
  maxContextTokens?: number
  errorCount: number
  processScore: number
  outcomeScore: number
  score: number
  outcomePass: boolean
  pass: boolean
  checks: SkillEvalCheck[]
  outcomeChecks: SkillEvalCheck[]
  warnings: string[]
  outcomeWarnings: string[]
}

export const PASS_THRESHOLD = 0.7
export const PROCESS_SCORE_WEIGHT = 0.4
export const OUTCOME_SCORE_WEIGHT = 0.6
const STEP_BUDGET = 12
const MAX_CONSECUTIVE_SAME_CALL = 3
const AVG_PROMPT_INPUT_TOKEN_BUDGET = 48_000
const PEAK_PROMPT_INPUT_TOKEN_BUDGET = 120_000

function nodeHasError(node: TraceNode): boolean {
  return node.status === "error" || node.type === "error" || Boolean(node.metadata?.error)
}

function countErrorNodes(trace: AgentTrace): number {
  return (trace.nodes ?? []).filter(nodeHasError).length
}

function countToolResultErrors(trace: AgentTrace): number {
  return (trace.nodes ?? []).filter((node) => node.type === "tool_result" && nodeHasError(node))
    .length
}

function countToolNodes(trace: AgentTrace): number {
  const nodeCount = (trace.nodes ?? []).filter((node) => node.type === "tool").length
  if (nodeCount > 0) return nodeCount
  return trace.steps.reduce((sum, step) => sum + step.toolCalls.length, 0)
}

function getStepCount(trace: AgentTrace): number {
  return Array.isArray(trace.steps) ? trace.steps.length : 0
}

function normalizeForStableJson(value: unknown, seen = new WeakSet<object>()): unknown {
  if (typeof value === "bigint") return value.toString()
  if (!value || typeof value !== "object") return value
  if (seen.has(value)) return "[Circular]"

  seen.add(value)
  if (Array.isArray(value)) return value.map((item) => normalizeForStableJson(item, seen))

  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, nestedValue]) => [key, normalizeForStableJson(nestedValue, seen)])
  )
}

export function stableJsonStringify(value: unknown): string {
  try {
    const json = JSON.stringify(normalizeForStableJson(value))
    return typeof json === "string" ? json : String(value)
  } catch {
    return String(value)
  }
}

function getToolSignature(call: { name: string; args: Record<string, unknown> }): string {
  return `${call.name}:${stableJsonStringify(call.args ?? {})}`
}

function countRepeatedToolCalls(trace: AgentTrace): number {
  let repeated = 0

  for (const step of trace.steps ?? []) {
    let previous = ""
    let runLength = 0
    for (const call of step.toolCalls ?? []) {
      const signature = getToolSignature(call)
      if (signature === previous) {
        runLength += 1
      } else {
        previous = signature
        runLength = 1
      }
      if (runLength > MAX_CONSECUTIVE_SAME_CALL) repeated += 1
    }
  }

  return repeated
}

function getFinalAssistantText(trace: AgentTrace): string {
  const steps = trace.steps ?? []
  const stepText = steps[steps.length - 1]?.assistantText
  if (typeof stepText === "string" && stepText.trim()) return stepText.trim()

  const terminal = getTerminalMessageNode(trace)
  if (typeof terminal?.output === "string") return terminal.output.trim()
  return ""
}

function getTerminalMessageNode(trace: AgentTrace): TraceNode | null {
  const nodes = Array.isArray(trace.nodes) ? trace.nodes : []
  const root = nodes.find((node) => node.type === "trace")
  const terminalMessages = nodes.filter(
    (node) =>
      node.type === "message" &&
      node.parentId === root?.id &&
      (node.name === "Run Completed" || node.name === "Run Error" || node.name === "Run Cancelled")
  )
  if (terminalMessages.length === 0) return null
  return terminalMessages[terminalMessages.length - 1] ?? null
}

function outputLength(value: unknown): number {
  if (typeof value === "string") return value.trim().length
  if (value === null || value === undefined) return 0
  return JSON.stringify(value)?.length ?? 0
}

function buildChecks(
  trace: AgentTrace,
  toolCalls: number,
  averagePromptInputTokens: number,
  peakInputTokens: number
): SkillEvalCheck[] {
  const stepCount = getStepCount(trace)
  const repeatedToolCalls = countRepeatedToolCalls(trace)

  return [
    {
      name: "step_budget_reasonable",
      label: "步骤数合理",
      ok: stepCount <= STEP_BUDGET,
      weight: 2,
      detail: { steps: stepCount, max: STEP_BUDGET }
    },
    {
      name: "tool_budget_reasonable",
      label: "工具调用预算合理",
      ok: toolCalls <= DEFAULT_SKILL_EVAL_TOOL_BUDGET,
      weight: 2,
      detail: { totalToolCalls: toolCalls, max: DEFAULT_SKILL_EVAL_TOOL_BUDGET }
    },
    {
      name: "no_repeated_tool_calls",
      label: "无重复无效调用",
      ok: repeatedToolCalls === 0,
      weight: 2,
      detail: { repeatedToolCalls, maxConsecutiveSameCall: MAX_CONSECUTIVE_SAME_CALL }
    },
    {
      name: "input_tokens_reasonable",
      label: "平均 Prompt 输入不过高",
      ok: averagePromptInputTokens <= AVG_PROMPT_INPUT_TOKEN_BUDGET,
      weight: 1,
      detail: {
        averagePromptInputTokens: Math.round(averagePromptInputTokens),
        max: AVG_PROMPT_INPUT_TOKEN_BUDGET
      }
    },
    {
      name: "peak_input_tokens_reasonable",
      label: "最高单次输入不过高",
      ok: peakInputTokens <= PEAK_PROMPT_INPUT_TOKEN_BUDGET,
      weight: 1,
      detail: {
        peakInputTokens: Math.round(peakInputTokens),
        max: PEAK_PROMPT_INPUT_TOKEN_BUDGET
      }
    }
  ]
}

function buildOutcomeChecks(trace: AgentTrace, toolResultErrors: number): SkillEvalCheck[] {
  const finalAssistantText = getFinalAssistantText(trace)
  const terminalNode = getTerminalMessageNode(trace)
  const terminalOutputLength = outputLength(terminalNode?.output)
  return [
    {
      name: "run_completed_successfully",
      label: "运行成功结束",
      ok: trace.outcome === "success",
      weight: 3,
      detail: { outcome: trace.outcome }
    },
    {
      name: "final_response_present",
      label: "有最终响应",
      ok: finalAssistantText.length > 0,
      weight: 2,
      detail: { responseLength: finalAssistantText.length }
    },
    {
      name: "terminal_message_success",
      label: "终止消息有内容",
      ok: terminalOutputLength > 0,
      weight: 2,
      detail: {
        terminalNodeId: terminalNode?.id,
        terminalStatus: terminalNode?.status,
        terminalOutputLength
      }
    },
    {
      name: "no_tool_result_errors",
      label: "工具结果无错误",
      ok: toolResultErrors === 0,
      weight: 2,
      detail: { toolResultErrors }
    }
  ]
}

export function scoreChecks(checks: SkillEvalCheck[]): number {
  const totalWeight = checks.reduce((sum, check) => sum + check.weight, 0) || 1
  const earned = checks.reduce((sum, check) => sum + (check.ok ? check.weight : 0), 0)
  return Number((earned / totalWeight).toFixed(4))
}

// Overall skill score intentionally covers process + outcome only. Result quality
// is evaluated separately as resultScore because not every trace has result evidence.
function combineScores(processScore: number, outcomeScore: number): number {
  return Number(
    (processScore * PROCESS_SCORE_WEIGHT + outcomeScore * OUTCOME_SCORE_WEIGHT).toFixed(4)
  )
}

function summarizeTokenUsage(trace: AgentTrace): {
  modelCallCount: number
  totalInputTokens: number
  totalOutputTokens: number
  promptInputTokens: number
  totalTokens: number
  cacheReadTokens: number
  cacheCreationTokens: number
  peakInputTokens: number
  maxContextTokens: number
  averagePromptInputTokens: number
  totalTokensIncludesCache: boolean | "mixed"
} {
  const calls = Array.isArray(trace.modelCalls) ? trace.modelCalls : []
  const summary = calls.reduce(
    (acc, call) => {
      const usage = call.tokenUsage
      const input = usage?.inputTokens ?? 0
      const output = usage?.outputTokens ?? 0
      const cacheRead = usage?.cacheReadTokens ?? 0
      const cacheCreation = usage?.cacheCreationTokens ?? 0
      const promptInput = input + cacheRead + cacheCreation
      const total = input + output + cacheRead + cacheCreation

      acc.totalInputTokens += input
      acc.totalOutputTokens += output
      acc.promptInputTokens += promptInput
      acc.totalTokens += total
      acc.cacheReadTokens += cacheRead
      acc.cacheCreationTokens += cacheCreation
      acc.peakInputTokens = Math.max(acc.peakInputTokens, promptInput)
      acc.maxContextTokens = Math.max(acc.maxContextTokens, input)
      return acc
    },
    {
      modelCallCount: calls.length,
      totalInputTokens: 0,
      totalOutputTokens: 0,
      promptInputTokens: 0,
      totalTokens: 0,
      cacheReadTokens: 0,
      cacheCreationTokens: 0,
      peakInputTokens: 0,
      maxContextTokens: 0
    }
  )
  return {
    modelCallCount: summary.modelCallCount,
    totalInputTokens: summary.totalInputTokens,
    totalOutputTokens: summary.totalOutputTokens,
    promptInputTokens: summary.promptInputTokens,
    totalTokens: summary.totalTokens,
    cacheReadTokens: summary.cacheReadTokens,
    cacheCreationTokens: summary.cacheCreationTokens,
    peakInputTokens: summary.peakInputTokens,
    maxContextTokens: summary.maxContextTokens,
    averagePromptInputTokens: averageValue(summary.promptInputTokens, summary.modelCallCount),
    totalTokensIncludesCache: true
  }
}

function averageValue(total: number, count: number): number {
  return count > 0 ? total / count : 0
}

function buildWarnings(trace: AgentTrace, errorCount: number, toolCalls: number): string[] {
  const warnings: string[] = []
  if (trace.outcome !== "success") warnings.push(`任务结果为 ${trace.outcome}`)
  if (errorCount > 0) warnings.push(`检测到 ${errorCount} 个错误节点`)
  if (toolCalls > DEFAULT_SKILL_EVAL_TOOL_BUDGET) {
    warnings.push(`工具调用 ${toolCalls} 次，超过默认预算 ${DEFAULT_SKILL_EVAL_TOOL_BUDGET}`)
  }
  return warnings
}

function buildOutcomeWarnings(trace: AgentTrace, outcomeScore: number): string[] {
  const warnings: string[] = []
  if (outcomeScore < PASS_THRESHOLD) warnings.push("成果质量低于通过阈值")
  if (trace.errorMessage) warnings.push(trace.errorMessage)
  return warnings
}

export function evaluateTraceSkills(trace: AgentTrace): SkillEvalRecord[] {
  if (!Array.isArray(trace.usedSkills) || trace.usedSkills.length === 0) return []

  const errorCount = countErrorNodes(trace)
  const toolResultErrors = countToolResultErrors(trace)
  const toolCalls =
    typeof trace.totalToolCalls === "number" ? trace.totalToolCalls : countToolNodes(trace)
  const tokenUsage = summarizeTokenUsage(trace)
  const checks = buildChecks(
    trace,
    toolCalls,
    tokenUsage.averagePromptInputTokens,
    tokenUsage.peakInputTokens
  )
  const outcomeChecks = buildOutcomeChecks(trace, toolResultErrors)
  const processScore = scoreChecks(checks)
  const outcomeScore = scoreChecks(outcomeChecks)
  const score = combineScores(processScore, outcomeScore)
  const pass = score >= PASS_THRESHOLD
  const outcomePass = outcomeScore >= PASS_THRESHOLD
  const warnings = buildWarnings(trace, errorCount, toolCalls)
  const outcomeWarnings = buildOutcomeWarnings(trace, outcomeScore)
  const evaluatedAt = new Date().toISOString()

  return trace.usedSkills.map((rawSkillName) => {
    const { skillName, skillVersion } = parseSkillNameVersionIdentifier(rawSkillName)
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
      ...tokenUsage,
      errorCount,
      processScore,
      outcomeScore,
      score,
      outcomePass,
      pass,
      checks: cloneChecks(checks),
      outcomeChecks: cloneChecks(outcomeChecks),
      warnings: [...warnings],
      outcomeWarnings: [...outcomeWarnings]
    }
  })
}

function cloneChecks(checks: SkillEvalCheck[]): SkillEvalCheck[] {
  return checks.map((check) => ({
    ...check,
    ...(check.detail ? { detail: { ...check.detail } } : {})
  }))
}
