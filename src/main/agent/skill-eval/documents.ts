import type {
  AgentTrace,
  TraceSkillEvalArtifact,
  TraceSkillEvalCheck,
  TraceSkillEvalCheckCategory,
  TraceSkillEvalEvidence,
  TraceSkillEvalExtension,
  TraceSkillEvalRecord,
  TraceSkillEvalResultStatus,
  TraceSkillEvalSource,
  TraceSkillEvalWarningTag
} from "../trace/types"
import type { SkillEvalWindowContext } from "./window"
import {
  evaluateTraceSkills,
  OUTCOME_SCORE_WEIGHT,
  PASS_THRESHOLD,
  PROCESS_SCORE_WEIGHT,
  type SkillEvalCheck,
  type SkillEvalRecord
} from "./evaluator"
import {
  evaluateTraceResults,
  type SkillResultArtifact,
  type SkillResultEvalRecord
} from "./result-evaluator"

/** Wire format version. Bump when TraceSkillEvalRecord field shape changes. */
export const SKILL_EVAL_SCHEMA_VERSION = "2026.05.26"
/** Scoring algorithm version. Bump when evaluator rules, thresholds, or weights change. */
export const SKILL_EVAL_RULES_VERSION = "2026.05.26"
export const SKILL_EVAL_PROCESS_WEIGHT = PROCESS_SCORE_WEIGHT
export const SKILL_EVAL_OUTCOME_WEIGHT = OUTCOME_SCORE_WEIGHT

export interface BuildSkillEvalTraceExtensionOptions {
  skillAuthorByRawName?: Record<string, string | undefined>
  windowContextByRawName?: Record<string, SkillEvalWindowContext | undefined>
  evalRawSkillNames?: string[]
}

const PROCESS_CHECK_WARNING_TAGS: Partial<Record<string, TraceSkillEvalWarningTag>> = {
  input_tokens_reasonable: "PROMPT_TOKEN_BUDGET_EXCEEDED",
  peak_input_tokens_reasonable: "PROMPT_TOKEN_BUDGET_EXCEEDED",
  no_repeated_tool_calls: "REPEATED_TOOL_CALLS",
  step_budget_reasonable: "STEP_BUDGET_EXCEEDED",
  tool_budget_reasonable: "TOOL_BUDGET_EXCEEDED"
}

const OUTCOME_CHECK_WARNING_TAGS: Partial<Record<string, TraceSkillEvalWarningTag>> = {
  final_response_present: "FINAL_RESPONSE_MISSING",
  no_tool_result_errors: "TOOL_RESULT_ERROR",
  run_completed_successfully: "OUTCOME_NOT_SUCCESS",
  terminal_message_success: "TERMINAL_MESSAGE_FAILED"
}

const RESULT_CHECK_WARNING_TAGS: Partial<Record<string, TraceSkillEvalWarningTag>> = {
  final_response_substantive: "FINAL_RESPONSE_TOO_SHORT",
  has_output_signal: "OUTPUT_SIGNAL_MISSING",
  has_validation_signal: "VALIDATION_SIGNAL_MISSING",
  no_dangerous_commands: "DANGEROUS_COMMAND_DETECTED",
  no_tool_result_errors: "TOOL_RESULT_ERROR"
}

const SHANGHAI_DATE_FORMATTER = new Intl.DateTimeFormat("en-US", {
  day: "2-digit",
  month: "2-digit",
  timeZone: "Asia/Shanghai",
  year: "numeric"
})

function safeString(value: unknown): string {
  return typeof value === "string" ? value : ""
}

function finiteNumber(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0
}

function numericFlag(value: boolean): 0 | 1 {
  return value ? 1 : 0
}

function score100(value: number): number {
  return Number((finiteNumber(value) * 100).toFixed(2))
}

function keywordBoolean(value: boolean | "mixed"): "true" | "false" | "mixed" {
  if (value === "mixed") return "mixed"
  return value ? "true" : "false"
}

function formatShanghaiDate(isoTimestamp: string): string {
  const date = new Date(isoTimestamp)
  if (Number.isNaN(date.getTime())) return ""

  const parts = SHANGHAI_DATE_FORMATTER.formatToParts(date)
  const year = parts.find((part) => part.type === "year")?.value ?? ""
  const month = parts.find((part) => part.type === "month")?.value ?? ""
  const day = parts.find((part) => part.type === "day")?.value ?? ""
  return year && month && day ? `${year}-${month}-${day}` : ""
}

function startedMonth(startedDate: string): string {
  return startedDate.length >= 7 ? startedDate.slice(0, 7) : ""
}

function failedCheckNames(checks: SkillEvalCheck[]): string[] {
  return checks.filter((check) => !check.ok).map((check) => check.name)
}

function withCategory(
  checks: SkillEvalCheck[],
  category: TraceSkillEvalCheckCategory
): TraceSkillEvalCheck[] {
  return checks.map((check) => ({ ...check, category }))
}

function warningTagsFromChecks(
  checks: SkillEvalCheck[],
  mapping: Partial<Record<string, TraceSkillEvalWarningTag>>
): TraceSkillEvalWarningTag[] {
  return checks
    .filter((check) => !check.ok)
    .map((check) => mapping[check.name])
    .filter((tag): tag is TraceSkillEvalWarningTag => Boolean(tag))
}

function buildWarningTags(
  trace: AgentTrace,
  skillRecord: SkillEvalRecord,
  resultRecord: SkillResultEvalRecord | undefined
): TraceSkillEvalWarningTag[] {
  const tags = new Set<TraceSkillEvalWarningTag>([
    ...warningTagsFromChecks(skillRecord.checks, PROCESS_CHECK_WARNING_TAGS),
    ...warningTagsFromChecks(skillRecord.outcomeChecks, OUTCOME_CHECK_WARNING_TAGS),
    ...warningTagsFromChecks(resultRecord?.checks ?? [], RESULT_CHECK_WARNING_TAGS)
  ])

  if (skillRecord.errorCount > 0) tags.add("ERROR_NODES_DETECTED")
  if (skillRecord.outcome !== "success") tags.add("OUTCOME_NOT_SUCCESS")
  if (skillRecord.outcomeScore < PASS_THRESHOLD) tags.add("OUTCOME_QUALITY_LOW")
  if (trace.errorMessage) tags.add("RUNTIME_ERROR")
  if ((resultRecord?.evidence.subagentFailed ?? 0) > 0) tags.add("SUBAGENT_FAILED")

  return [...tags].sort()
}

function buildEvidence(resultRecord: SkillResultEvalRecord | undefined): TraceSkillEvalEvidence {
  const evidence = resultRecord?.evidence
  return {
    artifactSignals: evidence?.artifactSignals.length ?? 0,
    changedFiles: evidence?.changedFiles.length ?? 0,
    dangerousCommands: evidence?.dangerousCommands.length ?? 0,
    finalResponseLength: evidence?.finalResponseLength ?? 0,
    subagentCompleted: evidence?.subagentCompleted ?? 0,
    subagentFailed: evidence?.subagentFailed ?? 0,
    subagentResultLength: evidence?.subagentResultLength ?? 0,
    subagentRuns: evidence?.subagentRuns ?? 0,
    toolResultErrors: evidence?.toolResultErrors ?? 0,
    validationCommands: evidence?.validationCommands.length ?? 0
  }
}

function artifactLabel(artifact: SkillResultArtifact): string {
  if (artifact.path) return artifact.path
  if (artifact.url) return artifact.url
  return artifact.label
}

function buildArtifacts(resultRecord: SkillResultEvalRecord | undefined): TraceSkillEvalArtifact[] {
  return (resultRecord?.artifacts ?? []).map((artifact) => ({
    type: artifact.type,
    label: artifactLabel(artifact)
  }))
}

function resultStatus(resultRecord: SkillResultEvalRecord | undefined): TraceSkillEvalResultStatus {
  if (!resultRecord) return "skipped"
  return resultRecord.status === "completed" ? "evaluated" : "failed"
}

function resultRecordMap(records: SkillResultEvalRecord[]): Map<string, SkillResultEvalRecord> {
  return new Map(records.map((record) => [record.rawSkillName, record]))
}

function uniqueStrings(values: string[]): string[] {
  return Array.from(new Set(values.filter(Boolean)))
}

function traceWithEvalSkillNames(trace: AgentTrace, rawSkillNames: string[]): AgentTrace {
  return { ...trace, usedSkills: uniqueStrings(rawSkillNames) }
}

function evalSourceForRecord(trace: AgentTrace, rawSkillName: string): TraceSkillEvalSource {
  return trace.usedSkills.includes(rawSkillName) ? "explicit" : "inherited_context"
}

function buildRecord(
  trace: AgentTrace,
  skillRecord: SkillEvalRecord,
  resultRecord: SkillResultEvalRecord | undefined,
  options: BuildSkillEvalTraceExtensionOptions,
  startedDateValue: string
): TraceSkillEvalRecord {
  const processChecks = withCategory(skillRecord.checks, "process")
  const outcomeChecks = withCategory(skillRecord.outcomeChecks, "outcome")
  const rawResultChecks = resultRecord?.checks ?? []
  const resultChecks = withCategory(rawResultChecks, "result")
  const failedProcessChecks = failedCheckNames(skillRecord.checks)
  const failedOutcomeChecks = failedCheckNames(skillRecord.outcomeChecks)
  const failedResultChecks = failedCheckNames(rawResultChecks)
  const status = resultStatus(resultRecord)
  const skillAuthor = options.skillAuthorByRawName?.[skillRecord.rawSkillName]
  const windowContext = options.windowContextByRawName?.[skillRecord.rawSkillName]
  const contextTraceIds = windowContext?.contextTraceIds ?? [skillRecord.traceId]
  const skillEvalTraceIds = windowContext?.skillEvalTraceIds ?? [skillRecord.traceId]

  return {
    id: `${skillRecord.traceId}:${skillRecord.rawSkillName}`,
    traceId: skillRecord.traceId,
    threadId: skillRecord.threadId,
    rawSkillName: skillRecord.rawSkillName,
    skillName: skillRecord.skillName,
    ...(skillRecord.skillVersion ? { skillVersion: skillRecord.skillVersion } : {}),
    evalSource: evalSourceForRecord(trace, skillRecord.rawSkillName),

    contextTraceIds,
    skillEvalTraceIds,
    contextTraceCount: contextTraceIds.length,
    skillEvalTraceCount: skillEvalTraceIds.length,

    startedAt: skillRecord.startedAt,
    endedAt: skillRecord.endedAt,
    startedDate: startedDateValue,
    startedMonth: startedMonth(startedDateValue),

    ystId: safeString(trace.ystId),
    sapId: safeString(trace.sapId),
    userName: safeString(trace.userName),
    orgName: safeString(trace.orgName),
    originOrgId: safeString(trace.originOrgId),
    upperOrgLv0: safeString(trace.upperOrgLv0),
    upperOrgLv1: safeString(trace.upperOrgLv1),
    upperOrgLv2: safeString(trace.upperOrgLv2),
    upperOrgLv3: safeString(trace.upperOrgLv3),
    appVersion: safeString(trace.appVersion),
    ...(skillAuthor ? { skillAuthor } : {}),

    userMessage: skillRecord.userMessage,
    modelId: skillRecord.modelId,
    modelName: safeString(skillRecord.modelName),
    outcome: skillRecord.outcome as AgentTrace["outcome"],

    score: score100(skillRecord.score),
    processScore: score100(skillRecord.processScore),
    outcomeScore: score100(skillRecord.outcomeScore),
    ...(status === "evaluated" ? { resultScore: score100(resultRecord?.score ?? 0) } : {}),
    processWeight: SKILL_EVAL_PROCESS_WEIGHT,
    outcomeWeight: SKILL_EVAL_OUTCOME_WEIGHT,

    pass: skillRecord.pass,
    passNumeric: numericFlag(skillRecord.pass),
    outcomePass: skillRecord.outcomePass,
    outcomePassNumeric: numericFlag(skillRecord.outcomePass),
    ...(status === "evaluated"
      ? {
          resultPass: Boolean(resultRecord?.pass),
          resultPassNumeric: numericFlag(Boolean(resultRecord?.pass))
        }
      : {}),
    resultStatus: status,

    durationMs: finiteNumber(skillRecord.durationMs),
    totalToolCalls: finiteNumber(skillRecord.totalToolCalls),
    modelCallCount: finiteNumber(skillRecord.modelCallCount),
    errorCount: finiteNumber(skillRecord.errorCount),
    totalInputTokens: finiteNumber(skillRecord.totalInputTokens),
    totalOutputTokens: finiteNumber(skillRecord.totalOutputTokens),
    totalTokens: finiteNumber(skillRecord.totalTokens),
    promptInputTokens: finiteNumber(skillRecord.promptInputTokens),
    cacheReadTokens: finiteNumber(skillRecord.cacheReadTokens),
    cacheCreationTokens: finiteNumber(skillRecord.cacheCreationTokens),
    peakInputTokens: finiteNumber(skillRecord.peakInputTokens),
    totalTokensIncludesCache: keywordBoolean(skillRecord.totalTokensIncludesCache),

    failedProcessChecks,
    failedOutcomeChecks,
    failedResultChecks,
    failedProcessCheckCount: failedProcessChecks.length,
    totalProcessCheckCount: skillRecord.checks.length,
    failedOutcomeCheckCount: failedOutcomeChecks.length,
    totalOutcomeCheckCount: skillRecord.outcomeChecks.length,
    failedResultCheckCount: failedResultChecks.length,
    totalResultCheckCount: rawResultChecks.length,
    warningTags: buildWarningTags(trace, skillRecord, resultRecord),

    checks: processChecks,
    outcomeChecks,
    resultChecks,

    warnings: skillRecord.warnings,
    outcomeWarnings: skillRecord.outcomeWarnings,
    resultWarnings: resultRecord?.warnings ?? [],
    resultIssues: resultRecord?.issues ?? [],

    artifacts: buildArtifacts(resultRecord),
    evidence: buildEvidence(resultRecord)
  }
}

export function buildSkillEvalTraceExtension(
  trace: AgentTrace,
  options: BuildSkillEvalTraceExtensionOptions = {}
): TraceSkillEvalExtension | undefined {
  const startedDateValue = formatShanghaiDate(trace.startedAt)
  if (!startedDateValue) return undefined

  const evalRawSkillNames = options.evalRawSkillNames ?? trace.usedSkills
  const evalTrace = traceWithEvalSkillNames(trace, evalRawSkillNames)
  const skillRecords = evaluateTraceSkills(evalTrace)
  if (skillRecords.length === 0) return undefined

  const evaluatedAt = new Date().toISOString()
  const resultByRawName = resultRecordMap(evaluateTraceResults(evalTrace))
  const records = skillRecords.map((skillRecord) =>
    buildRecord(
      trace,
      skillRecord,
      resultByRawName.get(skillRecord.rawSkillName),
      options,
      startedDateValue
    )
  )

  return {
    schemaVersion: SKILL_EVAL_SCHEMA_VERSION,
    evalRulesVersion: SKILL_EVAL_RULES_VERSION,
    evaluatedAt,
    records
  }
}
