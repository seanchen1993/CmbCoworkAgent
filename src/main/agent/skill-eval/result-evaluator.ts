import type { AgentTrace, TraceNode, TraceToolCall } from "../trace/types"
import { PASS_THRESHOLD, scoreChecks, stableJsonStringify, type SkillEvalCheck } from "./evaluator"
import { parseSkillNameVersionIdentifier } from "../../utils/skill-identifiers"
import { getSkillEvalAssistantText } from "./assistant-text"

export type SkillResultEvalStatus = "completed" | "failed"

export interface SkillResultArtifact {
  type: "response" | "file" | "command" | "screenshot" | "log" | "other"
  label: string
  path?: string
  url?: string
  detail?: Record<string, unknown>
}

export interface SkillResultEvidence {
  finalResponseLength: number
  changedFiles: string[]
  validationCommands: string[]
  artifactSignals: string[]
  dangerousCommands: string[]
  subagentRuns: number
  subagentCompleted: number
  subagentFailed: number
  subagentResultLength: number
  toolResultErrors: number
  errorNodes: number
  modelCallCount: number
  toolCallCount: number
}

export interface SkillResultEvalRecord {
  id: string
  traceId: string
  threadId: string
  skillName: string
  skillVersion?: string
  rawSkillName: string
  status: SkillResultEvalStatus
  score: number
  pass: boolean
  checks: SkillEvalCheck[]
  artifacts: SkillResultArtifact[]
  evidence: SkillResultEvidence
  issues: string[]
  warnings: string[]
  startedAt: string
  endedAt: string
  evaluatedAt: string
}

const MIN_FINAL_RESPONSE_CHARS = 20
const VALIDATION_COMMAND_PATTERNS: RegExp[] = [
  /\bnpm\s+(?:run\s+)?(?:test|build|lint|typecheck)\b/,
  /\bpnpm\s+(?:run\s+)?(?:test|build|lint|typecheck)\b/,
  /\byarn\s+(?:run\s+)?(?:test|build|lint|typecheck)\b/,
  /\b(?:pytest|vitest|jest)\b/,
  /\bcargo\s+test\b/,
  /\bgo\s+test\b/,
  /\bmvn\s+test\b/,
  /\bgradle\s+test\b/,
  /\btsc\s+--noEmit\b/,
  /\bplaywright\s+(?:test|screenshot|show-report)\b/,
  /\bnpm\s+run\s+[^&|;]*screenshot\b/,
  /\bpnpm\s+(?:run\s+)?[^&|;]*screenshot\b/,
  /\byarn\s+(?:run\s+)?[^&|;]*screenshot\b/
]
const DANGEROUS_COMMAND_PATTERNS: RegExp[] = [
  /\brm\s+-[^\s]*r[^\s]*f\b/,
  /\bgit\s+reset\s+--hard\b/,
  /\bgit\s+checkout\s+--\b/,
  /\bsudo\b/,
  /\bchmod\s+777\b/,
  /\bmkfs\b/,
  /:\(\)\s*\{/,
  /\bdd\s+if=/
]
const SHELL_TOOL_NAMES = new Set([
  "execute",
  "exec",
  "shell",
  "bash",
  "exec_command",
  "code_exec",
  "invoke_deferred_tool"
])
const ARTIFACT_TOOL_NAMES = new Set([
  "write_file",
  "edit_file",
  "apply_patch",
  "prepare_save_code_exec_tool",
  "save_code_exec_tool"
])
const CHANGED_FILE_TOOL_NAMES = new Set([
  "write_file",
  "edit_file",
  "apply_patch",
  "save_code_exec_tool"
])
const SUBAGENT_TOOL_NAMES = new Set(["task"])

type EvidenceToolCall = TraceToolCall & {
  source: "step" | "model" | "node"
  status?: TraceNode["status"]
}

function skillVersionKey(skillName: string, skillVersion?: string): string {
  return `${skillName}:${skillVersion ?? ""}`
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

function collectSubagentStats(trace: AgentTrace): {
  subagentRuns: number
  subagentCompleted: number
  subagentFailed: number
  subagentResultLength: number
} {
  const taskCalls = new Set<string>()
  let subagentCompleted = 0
  let subagentFailed = 0
  let subagentResultLength = 0
  const nodes = trace.nodes ?? []
  const nodeById = new Map(nodes.map((node) => [node.id, node]))

  for (const node of nodes) {
    if (node.type === "tool" && node.name && SUBAGENT_TOOL_NAMES.has(node.name)) {
      const callId =
        typeof node.metadata?.toolCallId === "string" ? node.metadata.toolCallId : node.id
      taskCalls.add(callId)
    }
    if (node.type !== "tool_result") continue
    const parent = nodeById.get(String(node.parentId ?? ""))
    if (!parent?.name || !SUBAGENT_TOOL_NAMES.has(parent.name)) continue
    if (node.status === "error") subagentFailed += 1
    else subagentCompleted += 1
    if (node.status !== "error" && typeof node.output === "string") {
      subagentResultLength += node.output.trim().length
    }
  }

  return {
    subagentRuns: Math.max(taskCalls.size, subagentCompleted + subagentFailed),
    subagentCompleted,
    subagentFailed,
    subagentResultLength
  }
}

function toRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {}
}

function toolCallKey(call: TraceToolCall): string {
  try {
    return `${call.name}:${stableJsonStringify(call.args ?? {})}`
  } catch {
    return `${call.name}:unserializable`
  }
}

function dedupeToolCalls(calls: EvidenceToolCall[]): EvidenceToolCall[] {
  const seen = new Set<string>()
  const result: EvidenceToolCall[] = []
  for (const call of calls) {
    const key = toolCallKey(call)
    if (seen.has(key)) continue
    seen.add(key)
    result.push(call)
  }
  return result
}

function getAllToolCalls(trace: AgentTrace): EvidenceToolCall[] {
  const fromSteps = (trace.steps ?? []).flatMap((step) =>
    (step.toolCalls ?? []).map((call): EvidenceToolCall => ({ ...call, source: "step" }))
  )
  const fromModelCalls = (trace.modelCalls ?? []).flatMap((call) =>
    (call.toolCalls ?? []).map((toolCall): EvidenceToolCall => ({ ...toolCall, source: "model" }))
  )
  const primaryCalls = fromSteps.length > 0 ? fromSteps : fromModelCalls
  const fromNodes = (trace.nodes ?? [])
    .filter((node) => node.type === "tool" && node.name)
    .map(
      (node): EvidenceToolCall => ({
        name: node.name || "unknown",
        args: toRecord(node.input),
        source: "node",
        status: node.status
      })
    )
  return dedupeToolCalls([...primaryCalls, ...fromNodes])
}

function stringifyArg(value: unknown): string {
  if (typeof value === "string") return value
  if (value === null || value === undefined) return ""
  try {
    return JSON.stringify(value)
  } catch {
    return String(value)
  }
}

function commandText(call: TraceToolCall): string {
  if (!SHELL_TOOL_NAMES.has(call.name)) return ""
  const args = call.args ?? {}
  const candidates = [args.command, args.cmd, args.script, args.shellCommand, args.argv]
  return candidates.map(stringifyArg).filter(Boolean).join(" ")
}

function isValidationCommand(text: string): boolean {
  const normalized = text.toLowerCase()
  return VALIDATION_COMMAND_PATTERNS.some((pattern) => pattern.test(normalized))
}

function isDangerousCommand(text: string): boolean {
  const normalized = text.toLowerCase()
  return DANGEROUS_COMMAND_PATTERNS.some((pattern) => pattern.test(normalized))
}

function getPathSignal(call: TraceToolCall): string {
  const args = call.args ?? {}
  return (
    stringifyArg(args.path) ||
    stringifyArg(args.file_path) ||
    stringifyArg(args.filePath) ||
    stringifyArg(args.targetPath) ||
    stringifyArg(args.outputPath) ||
    stringifyArg(args.filename)
  )
}

function collectEvidence(trace: AgentTrace): SkillResultEvidence {
  const toolCalls = getAllToolCalls(trace)
  const validationCommands: string[] = []
  const artifactSignals: string[] = []
  const dangerousCommands: string[] = []
  const changedFiles = new Set<string>()
  const subagentStats = collectSubagentStats(trace)

  for (const call of toolCalls) {
    const name = call.name || "unknown"
    const command = commandText(call)
    if (command && isValidationCommand(command)) validationCommands.push(command)
    if (command && isDangerousCommand(command)) dangerousCommands.push(command)

    const pathSignal = getPathSignal(call)
    if (pathSignal && CHANGED_FILE_TOOL_NAMES.has(name)) {
      changedFiles.add(pathSignal)
    }

    if (pathSignal && ARTIFACT_TOOL_NAMES.has(name)) {
      artifactSignals.push(`${name}:${pathSignal}`)
    } else if (ARTIFACT_TOOL_NAMES.has(name) && call.source === "node" && call.status !== "error") {
      artifactSignals.push(name)
    }
  }

  const evidence: SkillResultEvidence = {
    finalResponseLength: getSkillEvalAssistantText(trace).length,
    changedFiles: [...changedFiles],
    validationCommands: [...new Set(validationCommands)],
    artifactSignals: [...new Set(artifactSignals)],
    dangerousCommands: [...new Set(dangerousCommands)],
    ...subagentStats,
    toolResultErrors: countToolResultErrors(trace),
    errorNodes: countErrorNodes(trace),
    modelCallCount: Array.isArray(trace.modelCalls) ? trace.modelCalls.length : 0,
    toolCallCount:
      typeof trace.totalToolCalls === "number" ? trace.totalToolCalls : toolCalls.length
  }

  return evidence
}

function buildChecks(evidence: SkillResultEvidence): SkillEvalCheck[] {
  const hasArtifactSignal = evidence.changedFiles.length > 0 || evidence.artifactSignals.length > 0
  const hasSubstantiveResponse = evidence.finalResponseLength >= MIN_FINAL_RESPONSE_CHARS
  const validationNeeded = evidence.changedFiles.length > 0

  return [
    {
      name: "final_response_substantive",
      label: "响应内容足够",
      ok: hasSubstantiveResponse,
      weight: 2,
      detail: {
        responseLength: evidence.finalResponseLength,
        min: MIN_FINAL_RESPONSE_CHARS
      }
    },
    {
      name: "has_output_signal",
      label: "存在响应或产出信号",
      ok: hasArtifactSignal || hasSubstantiveResponse,
      weight: 3,
      detail: {
        changedFiles: evidence.changedFiles.length,
        artifactSignals: evidence.artifactSignals.length,
        finalResponseLength: evidence.finalResponseLength
      }
    },
    {
      name: "has_validation_signal",
      label: "验证要求满足",
      ok: !validationNeeded || evidence.validationCommands.length > 0,
      weight: 2,
      detail: {
        validationNeeded,
        validationCommands: evidence.validationCommands.slice(0, 5)
      }
    },
    {
      name: "no_tool_result_errors",
      label: "工具结果无错误",
      ok: evidence.toolResultErrors === 0,
      weight: 2,
      detail: { toolResultErrors: evidence.toolResultErrors }
    },
    {
      name: "no_dangerous_commands",
      label: "无高风险命令",
      ok: evidence.dangerousCommands.length === 0,
      weight: 2,
      detail: { dangerousCommands: evidence.dangerousCommands.slice(0, 5) }
    }
  ]
}

function buildArtifacts(evidence: SkillResultEvidence): SkillResultArtifact[] {
  const artifacts: SkillResultArtifact[] = []
  if (evidence.finalResponseLength > 0) {
    artifacts.push({
      type: "response",
      label: "最终响应",
      detail: { length: evidence.finalResponseLength }
    })
  }
  for (const filePath of evidence.changedFiles.slice(0, 20)) {
    artifacts.push({ type: "file", label: "文件产物", path: filePath })
  }
  for (const command of evidence.validationCommands.slice(0, 10)) {
    artifacts.push({
      type: "command",
      label: "验证命令",
      detail: { command }
    })
  }
  for (const signal of evidence.artifactSignals.slice(0, 20)) {
    artifacts.push({
      type: "other",
      label: "产出信号",
      detail: { signal }
    })
  }
  return artifacts
}

function buildIssues(trace: AgentTrace, evidence: SkillResultEvidence): string[] {
  const issues: string[] = []
  if (trace.errorMessage) issues.push(trace.errorMessage)
  if (evidence.subagentFailed > 0) issues.push(`子 agent 失败 ${evidence.subagentFailed} 次`)
  if (evidence.dangerousCommands.length > 0) issues.push("检测到高风险命令")
  return [...new Set(issues)]
}

function buildWarnings(evidence: SkillResultEvidence): string[] {
  const warnings: string[] = []
  if (evidence.changedFiles.length > 0 && evidence.validationCommands.length === 0) {
    warnings.push("没有检测到验证动作")
  }
  if (evidence.changedFiles.length === 0 && evidence.artifactSignals.length === 0) {
    warnings.push("没有检测到文件或工具产物信号")
  }
  if (evidence.subagentFailed > 0) {
    warnings.push(`检测到 ${evidence.subagentFailed} 个子 agent 失败`)
  }
  if (evidence.dangerousCommands.length > 0) {
    warnings.push(`检测到 ${evidence.dangerousCommands.length} 条高风险命令`)
  }
  return warnings
}

export function evaluateTraceResults(trace: AgentTrace): SkillResultEvalRecord[] {
  if (!Array.isArray(trace.usedSkills) || trace.usedSkills.length === 0) return []

  const evidence = collectEvidence(trace)
  const checks = buildChecks(evidence)
  const score = scoreChecks(checks)
  const pass = score >= PASS_THRESHOLD
  const artifacts = buildArtifacts(evidence)
  const issues = buildIssues(trace, evidence)
  const warnings = buildWarnings(evidence)
  const evaluatedAt = new Date().toISOString()

  return trace.usedSkills.map((rawSkillName) => {
    const { skillName, skillVersion } = parseSkillNameVersionIdentifier(rawSkillName)
    return {
      id: `${trace.traceId}:${skillVersionKey(skillName, skillVersion)}:result`,
      traceId: trace.traceId,
      threadId: trace.threadId,
      skillName,
      ...(skillVersion ? { skillVersion } : {}),
      rawSkillName,
      status: "completed",
      score,
      pass,
      checks: cloneChecks(checks),
      artifacts: cloneArtifacts(artifacts),
      evidence: cloneEvidence(evidence),
      issues: [...issues],
      warnings: [...warnings],
      startedAt: trace.startedAt,
      endedAt: trace.endedAt,
      evaluatedAt
    }
  })
}

function cloneChecks(checks: SkillEvalCheck[]): SkillEvalCheck[] {
  return checks.map((check) => ({
    ...check,
    ...(check.detail ? { detail: { ...check.detail } } : {})
  }))
}

function cloneArtifacts(artifacts: SkillResultArtifact[]): SkillResultArtifact[] {
  return artifacts.map((artifact) => ({
    ...artifact,
    ...(artifact.detail ? { detail: { ...artifact.detail } } : {})
  }))
}

function cloneEvidence(evidence: SkillResultEvidence): SkillResultEvidence {
  return {
    ...evidence,
    changedFiles: [...evidence.changedFiles],
    validationCommands: [...evidence.validationCommands],
    artifactSignals: [...evidence.artifactSignals],
    dangerousCommands: [...evidence.dangerousCommands]
  }
}
