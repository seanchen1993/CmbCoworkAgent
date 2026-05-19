import { appendFileSync, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "fs"
import { homedir } from "os"
import { join } from "path"
import type {
  SkillResultEvalListOptions,
  SkillResultEvalRecord
} from "../../../shared/skill-eval-types"

const MAX_RESULT_EVAL_RECORDS = 5000
const RESULT_COMPACT_THRESHOLD = 5500
const RESULT_COMPACT_CHECK_BYTES = 1024 * 1024

function compareRecordTime(a: SkillResultEvalRecord, b: SkillResultEvalRecord): number {
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

function getResultEvalFilePath(): string {
  return join(getEvalDir(), "result-records.jsonl")
}

function getLegacyOutcomeEvalFilePath(): string {
  return join(getEvalDir(), "outcome-records.jsonl")
}

function ensureEvalDir(): void {
  mkdirSync(getEvalDir(), { recursive: true })
}

function readResultRecordsFromFile(filePath: string): SkillResultEvalRecord[] {
  if (!existsSync(filePath)) return []
  const records: SkillResultEvalRecord[] = []
  const raw = readFileSync(filePath, "utf-8")
  for (const line of raw.split(/\r?\n/)) {
    if (!line.trim()) continue
    try {
      records.push(JSON.parse(line) as SkillResultEvalRecord)
    } catch {
      // Keep reading other records; one malformed line should not hide the page.
    }
  }
  return records
}

function readAllResultRecords(): SkillResultEvalRecord[] {
  return [
    ...readResultRecordsFromFile(getLegacyOutcomeEvalFilePath()),
    ...readResultRecordsFromFile(getResultEvalFilePath())
  ]
}

function dedupeResultRecords(records: SkillResultEvalRecord[]): SkillResultEvalRecord[] {
  const byId = new Map<string, SkillResultEvalRecord>()
  for (const record of records) {
    byId.set(record.id, record)
  }
  return [...byId.values()]
}

function compactResultEvalFileIfNeeded(): void {
  const filePath = getResultEvalFilePath()
  try {
    if (statSync(filePath).size < RESULT_COMPACT_CHECK_BYTES) return
  } catch {
    return
  }

  const records = dedupeResultRecords(readAllResultRecords())
  if (records.length <= RESULT_COMPACT_THRESHOLD) return

  const retained = records
    .sort((a, b) => compareRecordTime(b, a))
    .slice(0, MAX_RESULT_EVAL_RECORDS)
    .sort(compareRecordTime)

  const payload = retained.map((record) => JSON.stringify(record)).join("\n")
  writeFileSync(getResultEvalFilePath(), payload ? `${payload}\n` : "", "utf-8")
  console.log(
    `[SkillEval] Compacted result records: kept ${retained.length}, dropped ${
      records.length - retained.length
    }`
  )
}

export function appendSkillResultEvalRecords(records: SkillResultEvalRecord[]): void {
  if (records.length === 0) return
  try {
    ensureEvalDir()
    const payload = records.map((record) => JSON.stringify(record)).join("\n")
    appendFileSync(getResultEvalFilePath(), `${payload}\n`, "utf-8")
    compactResultEvalFileIfNeeded()
  } catch (error) {
    console.warn("[SkillEval] Failed to append result records:", error)
  }
}

export function listSkillResultEvalRecords(
  options: SkillResultEvalListOptions = {}
): SkillResultEvalRecord[] {
  const limit = Math.max(1, Math.min(options.limit ?? 200, 1000))
  return dedupeResultRecords(readAllResultRecords())
    .filter((record) => {
      if (options.skillName && record.skillName !== options.skillName) return false
      if (options.skillVersion && record.skillVersion !== options.skillVersion) return false
      if (options.threadId && record.threadId !== options.threadId) return false
      if (options.traceId && record.traceId !== options.traceId) return false
      if (typeof options.pass === "boolean" && record.pass !== options.pass) return false
      if (options.status && record.status !== options.status) return false
      return true
    })
    .sort((a, b) => compareRecordTime(b, a))
    .slice(0, limit)
}

export function clearSkillResultEvalRecords(): void {
  try {
    ensureEvalDir()
    writeFileSync(getResultEvalFilePath(), "", "utf-8")
    writeFileSync(getLegacyOutcomeEvalFilePath(), "", "utf-8")
  } catch (error) {
    console.warn("[SkillEval] Failed to clear result records:", error)
  }
}

export function getSkillResultEvalFilePath(): string {
  return getResultEvalFilePath()
}
