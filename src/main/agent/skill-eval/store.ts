import { appendFileSync, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "fs"
import { join } from "path"
import { homedir } from "os"
import type { AgentTrace } from "../trace/types"
import { evaluateTraceSkills } from "./evaluator"
import type {
  SkillEvalListOptions,
  SkillEvalRecord,
  SkillEvalSkillSummary,
  SkillEvalSummary
} from "../../../shared/skill-eval-types"

const MAX_SKILL_EVAL_RECORDS = 5000
const RECORD_COMPACT_THRESHOLD = 5500
const RECORD_COMPACT_CHECK_BYTES = 1024 * 1024

function compareRecordTime(a: SkillEvalRecord, b: SkillEvalRecord): number {
  const aTime = new Date(a.startedAt).getTime()
  const bTime = new Date(b.startedAt).getTime()
  if (Number.isFinite(aTime) && Number.isFinite(bTime)) return aTime - bTime
  return a.startedAt.localeCompare(b.startedAt)
}

function getOpenworkDir(): string {
  return process.env.CMB_COWORK_AGENT_HOME || join(homedir(), ".cmbcoworkagent")
}

function getEvalDir(): string {
  return join(getOpenworkDir(), "skill-evals")
}

function getEvalFilePath(): string {
  return join(getEvalDir(), "records.jsonl")
}

function getTracesRootDir(): string {
  return process.env.CMB_COWORK_TRACES_DIR || join(getOpenworkDir(), "traces")
}

function getTraceFilePath(record: SkillEvalRecord): string {
  return join(getTracesRootDir(), record.threadId, `${record.traceId}.jsonl`)
}

function ensureEvalDir(): void {
  mkdirSync(getEvalDir(), { recursive: true })
}

function readTraceForRecord(record: SkillEvalRecord): AgentTrace | null {
  const filePath = getTraceFilePath(record)
  if (!existsSync(filePath)) return null
  try {
    const line = readFileSync(filePath, "utf-8")
      .split(/\r?\n/)
      .find((item) => item.trim())
    return line ? (JSON.parse(line) as AgentTrace) : null
  } catch {
    return null
  }
}

function needsTraceBackfill(record: SkillEvalRecord): boolean {
  return (
    typeof record.modelCallCount !== "number" ||
    typeof record.totalInputTokens !== "number" ||
    typeof record.totalOutputTokens !== "number" ||
    typeof record.totalTokens !== "number" ||
    typeof record.promptInputTokens !== "number" ||
    typeof record.peakInputTokens !== "number" ||
    typeof record.processScore !== "number" ||
    typeof record.outcomeScore !== "number" ||
    !Array.isArray(record.outcomeChecks)
  )
}

function findEvaluatedRecord(record: SkillEvalRecord, trace: AgentTrace): SkillEvalRecord | null {
  return (
    evaluateTraceSkills(trace).find((candidate) => {
      if (candidate.id === record.id) return true
      if (candidate.rawSkillName === record.rawSkillName) return true
      return (
        candidate.skillName === record.skillName &&
        (candidate.skillVersion ?? "") === (record.skillVersion ?? "")
      )
    }) ?? null
  )
}

function backfillRecordFromTrace(record: SkillEvalRecord): SkillEvalRecord {
  if (!needsTraceBackfill(record)) return record
  const trace = readTraceForRecord(record)
  if (!trace) return record
  const evaluated = findEvaluatedRecord(record, trace)
  if (!evaluated) return record
  return {
    ...record,
    ...evaluated,
    evaluatedAt: record.evaluatedAt || evaluated.evaluatedAt
  }
}

function readAllRecords(): SkillEvalRecord[] {
  const filePath = getEvalFilePath()
  if (!existsSync(filePath)) return []
  const records: SkillEvalRecord[] = []
  const raw = readFileSync(filePath, "utf-8")
  for (const line of raw.split(/\r?\n/)) {
    if (!line.trim()) continue
    try {
      records.push(backfillRecordFromTrace(JSON.parse(line) as SkillEvalRecord))
    } catch {
      // Keep reading other records; a malformed line should not hide the page.
    }
  }
  return records
}

function dedupeRecords(records: SkillEvalRecord[]): SkillEvalRecord[] {
  const byId = new Map<string, SkillEvalRecord>()
  for (const record of records) {
    byId.set(record.id, record)
  }
  return [...byId.values()]
}

function compactEvalFileIfNeeded(): void {
  const filePath = getEvalFilePath()
  try {
    if (statSync(filePath).size < RECORD_COMPACT_CHECK_BYTES) return
  } catch {
    return
  }

  const records = dedupeRecords(readAllRecords())
  if (records.length <= RECORD_COMPACT_THRESHOLD) return

  const retained = records
    .sort((a, b) => compareRecordTime(b, a))
    .slice(0, MAX_SKILL_EVAL_RECORDS)
    .sort(compareRecordTime)

  const payload = retained.map((record) => JSON.stringify(record)).join("\n")
  writeFileSync(getEvalFilePath(), payload ? `${payload}\n` : "", "utf-8")
  console.log(
    `[SkillEval] Compacted records: kept ${retained.length}, dropped ${records.length - retained.length}`
  )
}

export function appendSkillEvalRecords(records: SkillEvalRecord[]): void {
  if (records.length === 0) return
  try {
    ensureEvalDir()
    const payload = records.map((record) => JSON.stringify(record)).join("\n")
    appendFileSync(getEvalFilePath(), `${payload}\n`, "utf-8")
    compactEvalFileIfNeeded()
  } catch (error) {
    console.warn("[SkillEval] Failed to append records:", error)
  }
}

export function listSkillEvalRecords(options: SkillEvalListOptions = {}): SkillEvalRecord[] {
  const limit = Math.max(1, Math.min(options.limit ?? 200, 1000))
  return dedupeRecords(readAllRecords())
    .filter((record) => {
      if (options.skillName && record.skillName !== options.skillName) return false
      if (options.skillVersion && record.skillVersion !== options.skillVersion) return false
      if (options.threadId && record.threadId !== options.threadId) return false
      if (typeof options.pass === "boolean" && record.pass !== options.pass) return false
      return true
    })
    .sort((a, b) => compareRecordTime(b, a))
    .slice(0, limit)
}

function numberValue(value: unknown, fallback = 0): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback
}

function recordPromptInputTokens(record: SkillEvalRecord): number {
  return numberValue(
    record.promptInputTokens,
    numberValue(record.totalInputTokens) +
      numberValue(record.cacheReadTokens) +
      numberValue(record.cacheCreationTokens)
  )
}

function recordPeakInputTokens(record: SkillEvalRecord): number {
  return numberValue(record.peakInputTokens, numberValue(record.maxContextTokens))
}

interface SkillEvalTotals {
  runs: number
  passCount: number
  score: number
  processScore: number
  outcomeScore: number
  toolCalls: number
  modelCalls: number
  inputTokens: number
  outputTokens: number
  promptInputTokens: number
  totalTokens: number
  peakInputTokens: number
  durationMs: number
  failures: number
}

function emptyTotals(): SkillEvalTotals {
  return {
    runs: 0,
    passCount: 0,
    score: 0,
    processScore: 0,
    outcomeScore: 0,
    toolCalls: 0,
    modelCalls: 0,
    inputTokens: 0,
    outputTokens: 0,
    promptInputTokens: 0,
    totalTokens: 0,
    peakInputTokens: 0,
    durationMs: 0,
    failures: 0
  }
}

function addRecordTotals(totals: SkillEvalTotals, record: SkillEvalRecord): SkillEvalTotals {
  totals.runs += 1
  totals.passCount += record.pass ? 1 : 0
  totals.score += numberValue(record.score)
  totals.processScore += numberValue(record.processScore, record.score)
  totals.outcomeScore += numberValue(record.outcomeScore, record.score)
  totals.toolCalls += numberValue(record.totalToolCalls)
  totals.modelCalls += numberValue(record.modelCallCount)
  totals.inputTokens += numberValue(record.totalInputTokens)
  totals.outputTokens += numberValue(record.totalOutputTokens)
  totals.promptInputTokens += recordPromptInputTokens(record)
  totals.totalTokens += numberValue(record.totalTokens)
  totals.peakInputTokens += recordPeakInputTokens(record)
  totals.durationMs += numberValue(record.durationMs)
  totals.failures += record.pass ? 0 : 1
  return totals
}

function averageTotal(total: number, count: number): number {
  if (count === 0) return 0
  return Number((total / count).toFixed(4))
}

function summarizeSkill(records: SkillEvalRecord[]): SkillEvalSkillSummary {
  const latest = records.reduce(
    (max, record) => (compareRecordTime(record, max) > 0 ? record : max),
    records[0]
  )
  const totals = records.reduce(addRecordTotals, emptyTotals())

  return {
    skillName: latest.skillName,
    ...(latest.skillVersion ? { skillVersion: latest.skillVersion } : {}),
    runs: totals.runs,
    passRate: averageTotal(totals.passCount, totals.runs),
    averageScore: averageTotal(totals.score, totals.runs),
    averageProcessScore: averageTotal(totals.processScore, totals.runs),
    averageOutcomeScore: averageTotal(totals.outcomeScore, totals.runs),
    averageToolCalls: averageTotal(totals.toolCalls, totals.runs),
    averageModelCalls: averageTotal(totals.modelCalls, totals.runs),
    averageInputTokens: averageTotal(totals.inputTokens, totals.runs),
    averageOutputTokens: averageTotal(totals.outputTokens, totals.runs),
    averagePromptInputTokens: averageTotal(totals.promptInputTokens, totals.runs),
    averageTotalTokens: averageTotal(totals.totalTokens, totals.runs),
    averagePeakInputTokens: averageTotal(totals.peakInputTokens, totals.runs),
    averageDurationMs: averageTotal(totals.durationMs, totals.runs),
    failures: totals.failures,
    lastRunAt: latest.startedAt
  }
}

export function getSkillEvalSummary(limit = 50): SkillEvalSummary {
  const records = dedupeRecords(readAllRecords()).sort((a, b) => compareRecordTime(b, a))
  const groups = new Map<string, SkillEvalRecord[]>()

  for (const record of records) {
    const key = `${record.skillName}:${record.skillVersion ?? ""}`
    const bucket = groups.get(key) ?? []
    bucket.push(record)
    groups.set(key, bucket)
  }

  const skills = [...groups.values()].map(summarizeSkill).sort((a, b) => {
    const aTime = new Date(a.lastRunAt).getTime()
    const bTime = new Date(b.lastRunAt).getTime()
    if (Number.isFinite(aTime) && Number.isFinite(bTime)) return bTime - aTime
    return b.lastRunAt.localeCompare(a.lastRunAt)
  })

  const totals = records.reduce(addRecordTotals, emptyTotals())

  return {
    generatedAt: new Date().toISOString(),
    totalRuns: totals.runs,
    totalSkills: skills.length,
    passRate: averageTotal(totals.passCount, totals.runs),
    averageScore: averageTotal(totals.score, totals.runs),
    averageProcessScore: averageTotal(totals.processScore, totals.runs),
    averageOutcomeScore: averageTotal(totals.outcomeScore, totals.runs),
    averageToolCalls: averageTotal(totals.toolCalls, totals.runs),
    averageModelCalls: averageTotal(totals.modelCalls, totals.runs),
    totalInputTokens: totals.inputTokens,
    totalOutputTokens: totals.outputTokens,
    totalPromptInputTokens: totals.promptInputTokens,
    totalTokens: totals.totalTokens,
    averageInputTokens: averageTotal(totals.inputTokens, totals.runs),
    averageOutputTokens: averageTotal(totals.outputTokens, totals.runs),
    averagePromptInputTokens: averageTotal(totals.promptInputTokens, totals.runs),
    averageTotalTokens: averageTotal(totals.totalTokens, totals.runs),
    averagePeakInputTokens: averageTotal(totals.peakInputTokens, totals.runs),
    averageDurationMs: averageTotal(totals.durationMs, totals.runs),
    skills,
    recent: records.slice(0, Math.max(1, Math.min(limit, 200)))
  }
}

export function clearSkillEvalRecords(): void {
  try {
    ensureEvalDir()
    writeFileSync(getEvalFilePath(), "", "utf-8")
  } catch (error) {
    console.warn("[SkillEval] Failed to clear records:", error)
  }
}

export function getSkillEvalFilePath(): string {
  return getEvalFilePath()
}
