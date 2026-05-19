import { appendFileSync, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "fs"
import { join } from "path"
import { homedir } from "os"
import type {
  SkillEvalListOptions,
  SkillEvalRecord,
  SkillEvalSkillSummary,
  SkillEvalSummary
} from "./types"

const MAX_SKILL_EVAL_RECORDS = 5000
const RECORD_COMPACT_THRESHOLD = 5500
const RECORD_COMPACT_CHECK_BYTES = 1024 * 1024

function getOpenworkDir(): string {
  return process.env.CMB_COWORK_AGENT_HOME || join(homedir(), ".cmbcoworkagent")
}

function getEvalDir(): string {
  return join(getOpenworkDir(), "skill-evals")
}

function getEvalFilePath(): string {
  return join(getEvalDir(), "records.jsonl")
}

function ensureEvalDir(): void {
  mkdirSync(getEvalDir(), { recursive: true })
}

function readAllRecords(): SkillEvalRecord[] {
  const filePath = getEvalFilePath()
  if (!existsSync(filePath)) return []
  const records: SkillEvalRecord[] = []
  const raw = readFileSync(filePath, "utf-8")
  for (const line of raw.split(/\r?\n/)) {
    if (!line.trim()) continue
    try {
      records.push(JSON.parse(line) as SkillEvalRecord)
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
    .sort((a, b) => b.startedAt.localeCompare(a.startedAt))
    .slice(0, MAX_SKILL_EVAL_RECORDS)
    .sort((a, b) => a.startedAt.localeCompare(b.startedAt))

  const payload = retained.map((record) => JSON.stringify(record)).join("\n")
  writeFileSync(getEvalFilePath(), payload ? `${payload}\n` : "", "utf-8")
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
      if (options.threadId && record.threadId !== options.threadId) return false
      if (typeof options.pass === "boolean" && record.pass !== options.pass) return false
      return true
    })
    .sort((a, b) => b.startedAt.localeCompare(a.startedAt))
    .slice(0, limit)
}

function average(values: number[]): number {
  if (values.length === 0) return 0
  return Number((values.reduce((sum, value) => sum + value, 0) / values.length).toFixed(4))
}

function summarizeSkill(records: SkillEvalRecord[]): SkillEvalSkillSummary {
  const latest = records.reduce((max, record) => (
    record.startedAt > max.startedAt ? record : max
  ), records[0])
  return {
    skillName: latest.skillName,
    ...(latest.skillVersion ? { skillVersion: latest.skillVersion } : {}),
    runs: records.length,
    passRate: average(records.map((record) => record.pass ? 1 : 0)),
    averageScore: average(records.map((record) => record.score)),
    averageToolCalls: average(records.map((record) => record.totalToolCalls)),
    averageDurationMs: average(records.map((record) => record.durationMs)),
    failures: records.filter((record) => !record.pass).length,
    lastRunAt: latest.startedAt
  }
}

export function getSkillEvalSummary(limit = 50): SkillEvalSummary {
  const records = dedupeRecords(readAllRecords()).sort((a, b) => b.startedAt.localeCompare(a.startedAt))
  const groups = new Map<string, SkillEvalRecord[]>()

  for (const record of records) {
    const key = `${record.skillName}:${record.skillVersion ?? ""}`
    const bucket = groups.get(key) ?? []
    bucket.push(record)
    groups.set(key, bucket)
  }

  const skills = [...groups.values()]
    .map(summarizeSkill)
    .sort((a, b) => b.lastRunAt.localeCompare(a.lastRunAt))

  return {
    generatedAt: new Date().toISOString(),
    totalRuns: records.length,
    totalSkills: skills.length,
    passRate: average(records.map((record) => record.pass ? 1 : 0)),
    averageScore: average(records.map((record) => record.score)),
    averageToolCalls: average(records.map((record) => record.totalToolCalls)),
    averageDurationMs: average(records.map((record) => record.durationMs)),
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
