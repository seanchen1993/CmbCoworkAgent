import type { AgentTrace, TraceNode } from "../trace/types"
import {
  DEFAULT_SKILL_EVAL_TOOL_BUDGET,
  type SkillEvalCheck,
  type SkillEvalRecord
} from "../../../shared/skill-eval-types"

const PASS_THRESHOLD = 0.7
const PROCESS_SCORE_WEIGHT = 0.4
const OUTCOME_SCORE_WEIGHT = 0.6
const STEP_BUDGET = 12
const TOOL_REPETITION_LIMIT = 3
const AVG_PROMPT_INPUT_TOKEN_BUDGET = 48_000

function parseSkill(raw: string): { skillName: string; skillVersion?: string } {
  const text = String(raw || "").trim()
  const match = text.match(/^(.*?)-(v\d+(?:\.\d+){0,3})$/)
  if (!match) return { skillName: text || "unknown" }
  return { skillName: match[1] || text, skillVersion: match[2] }
}

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

function getToolSignature(call: { name: string; args: Record<string, unknown> }): string {
  return `${call.name}:${JSON.stringify(call.args ?? {})}`
}

function countRepeatedToolCalls(trace: AgentTrace): number {
  let repeated = 0
  let previous = ""
  let runLength = 0

  for (const step of trace.steps ?? []) {
    for (const call of step.toolCalls ?? []) {
      const signature = getToolSignature(call)
      if (signature === previous) {
        runLength += 1
      } else {
        previous = signature
        runLength = 1
      }
      if (runLength > TOOL_REPETITION_LIMIT) repeated += 1
    }
  }

  return repeated
}

function getAveragePromptInputTokens(trace: AgentTrace): number {
  const calls = Array.isArray(trace.modelCalls) ? trace.modelCalls : []
  if (calls.length === 0) return 0
  const total = calls.reduce((sum, call) => {
    const usage = call.tokenUsage
    return (
      sum +
      (usage?.inputTokens ?? 0) +
      (usage?.cacheReadTokens ?? 0) +
      (usage?.cacheCreationTokens ?? 0)
    )
  }, 0)
  return total / calls.length
}

function getFinalAssistantText(trace: AgentTrace): string {
  const text = trace.steps[trace.steps.length - 1]?.assistantText
  return typeof text === "string" ? text.trim() : ""
}

function getTerminalMessageNode(trace: AgentTrace): TraceNode | null {
  const nodes = Array.isArray(trace.nodes) ? trace.nodes : []
  const root = nodes.find((node) => node.parentId === null || node.type === "trace")
  const terminalMessages = nodes.filter(
    (node) => node.type === "message" && node.parentId === root?.id && node.name !== "User Message"
  )
  if (terminalMessages.length === 0) return null
  return terminalMessages[terminalMessages.length - 1] ?? null
}

function outputLength(value: unknown): number {
  if (typeof value === "string") return value.trim().length
  if (value === null || value === undefined) return 0
  return JSON.stringify(value)?.length ?? 0
}

function buildChecks(trace: AgentTrace, toolCalls: number): SkillEvalCheck[] {
  const stepCount = getStepCount(trace)
  const repeatedToolCalls = countRepeatedToolCalls(trace)
  const averagePromptInputTokens = getAveragePromptInputTokens(trace)

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
      detail: { repeatedToolCalls, maxConsecutiveSameCall: TOOL_REPETITION_LIMIT }
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
    }
  ]
}

function buildOutcomeChecks(trace: AgentTrace, toolResultErrors: number): SkillEvalCheck[] {
  const finalAssistantText = getFinalAssistantText(trace)
  const terminalNode = getTerminalMessageNode(trace)
  const terminalOutputLength = outputLength(terminalNode?.output)
  const terminalSuccess = Boolean(
    terminalNode && terminalNode.status === "success" && terminalOutputLength > 0
  )

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
      label: "终止消息成功",
      ok: terminalSuccess,
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

function scoreChecks(checks: SkillEvalCheck[]): number {
  const totalWeight = checks.reduce((sum, check) => sum + check.weight, 0) || 1
  const earned = checks.reduce((sum, check) => sum + (check.ok ? check.weight : 0), 0)
  return Number((earned / totalWeight).toFixed(4))
}

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
} {
  const calls = Array.isArray(trace.modelCalls) ? trace.modelCalls : []
  return calls.reduce(
    (acc, call) => {
      const usage = call.tokenUsage
      const input = usage?.inputTokens ?? 0
      const output = usage?.outputTokens ?? 0
      const total = usage?.totalTokens ?? input + output
      const cacheRead = usage?.cacheReadTokens ?? 0
      const cacheCreation = usage?.cacheCreationTokens ?? 0
      const promptInput = input + cacheRead + cacheCreation

      acc.totalInputTokens += input
      acc.totalOutputTokens += output
      acc.promptInputTokens += promptInput
      // Some providers include cache tokens in totalTokens, others do not. Keep
      // provider-reported totals when present and only fall back to input+output.
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
  const checks = buildChecks(trace, toolCalls)
  const outcomeChecks = buildOutcomeChecks(trace, toolResultErrors)
  const processScore = scoreChecks(checks)
  const outcomeScore = scoreChecks(outcomeChecks)
  const score = combineScores(processScore, outcomeScore)
  const pass = score >= PASS_THRESHOLD
  const outcomePass = outcomeScore >= PASS_THRESHOLD
  const warnings = buildWarnings(trace, errorCount, toolCalls)
  const outcomeWarnings = buildOutcomeWarnings(trace, outcomeScore)
  const tokenUsage = summarizeTokenUsage(trace)
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
      ...tokenUsage,
      errorCount,
      processScore,
      outcomeScore,
      score,
      outcomePass,
      pass,
      checks,
      outcomeChecks,
      warnings,
      outcomeWarnings
    }
  })
}
