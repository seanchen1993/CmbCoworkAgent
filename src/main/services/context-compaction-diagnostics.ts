import { randomUUID } from "node:crypto"
import { mkdir, readFile, rename, stat, writeFile } from "node:fs/promises"
import { join } from "node:path"

export const COMPACTION_DIAGNOSTICS_FILE = "context_compaction.json"
const MAX_REPORTS = 5
const MAX_FILE_BYTES = 1024 * 1024

export interface CompactionDiagnosticReport {
  id: string
  startedAt: string
  finishedAt?: string
  status: "running" | "completed" | "failed" | "cancelled"
  context: Record<string, unknown>
  events: Array<{ at: string; event: string; details: Record<string, unknown> }>
}

export type CompactionDiagnosticSink = (report: CompactionDiagnosticReport) => Promise<void> | void

export function compactionErrorDetails(error: unknown, depth = 0): Record<string, unknown> {
  const record = error && typeof error === "object" ? (error as Record<string, unknown>) : {}
  return {
    name: typeof record.name === "string" ? record.name : undefined,
    message: String(record.message ?? error).slice(0, 8_192),
    status: record.status ?? record.statusCode,
    code: record.code,
    requestId: record.request_id ?? record.requestId,
    ...(typeof record.responseBody === "string"
      ? { responseBody: record.responseBody.slice(0, 8_192) }
      : {}),
    ...(depth < 2 && record.cause ? { cause: compactionErrorDetails(record.cause, depth + 1) } : {})
  }
}

/** One invocation owns its recorder; concurrent task subagents never share mutable events. */
export class CompactionDiagnostics {
  readonly report: CompactionDiagnosticReport

  constructor(context: Record<string, unknown>) {
    this.report = {
      id: randomUUID(),
      startedAt: new Date().toISOString(),
      status: "running",
      context,
      events: []
    }
    this.record("triggered", context)
  }

  record(event: string, details: Record<string, unknown>): void {
    const entry = { at: new Date().toISOString(), event, details }
    if (this.report.events.length < 64) this.report.events.push(entry)
    console.log("[ContextCompaction]", JSON.stringify({ id: this.report.id, ...entry }))
  }

  async finish(
    status: CompactionDiagnosticReport["status"],
    sink?: CompactionDiagnosticSink
  ): Promise<void> {
    this.report.status = status
    this.report.finishedAt = new Date().toISOString()
    this.record(status, {})
    try {
      await sink?.(this.report)
    } catch (error) {
      // Observation must never replace the original provider error or fail a recovered turn.
      console.warn("[ContextCompaction] Failed to persist diagnostics:", error)
    }
  }
}

interface DiagnosticFile {
  version: 1
  reports: CompactionDiagnosticReport[]
  lastFailure?: CompactionDiagnosticReport
  unavailableReason?: string
}

const pendingWrites = new Map<string, Promise<void>>()

async function readDiagnosticFile(path: string): Promise<DiagnosticFile> {
  try {
    if ((await stat(path)).size > MAX_FILE_BYTES) {
      return { version: 1, reports: [], unavailableReason: "diagnostic_file_too_large" }
    }
    const parsed = JSON.parse(await readFile(path, "utf8")) as DiagnosticFile
    if (parsed.version !== 1 || !Array.isArray(parsed.reports)) throw new Error("Invalid format")
    return {
      version: 1,
      reports: parsed.reports.slice(-MAX_REPORTS),
      lastFailure: parsed.lastFailure
    }
  } catch (error) {
    return {
      version: 1,
      reports: [],
      unavailableReason:
        (error as NodeJS.ErrnoException).code === "ENOENT"
          ? "no_compaction_recorded"
          : "diagnostic_read_failed"
    }
  }
}

/** Persist bounded reports in the app-managed thread directory, independent of the raw-request LRU. */
export function createCompactionDiagnosticSink(
  directory: string,
  identity: { threadId: string; modelId: string; model: string }
): CompactionDiagnosticSink {
  const path = join(directory, COMPACTION_DIAGNOSTICS_FILE)
  return async (report) => {
    const write = (pendingWrites.get(path) ?? Promise.resolve())
      .catch(() => {})
      .then(async () => {
        const previous = await readDiagnosticFile(path)
        const current = { ...report, context: { ...identity, ...report.context } }
        const reports = [...previous.reports, current].slice(-MAX_REPORTS)
        const lastFailure = report.status === "failed" ? current : previous.lastFailure
        let body = JSON.stringify({ version: 1, reports, lastFailure }, null, 2)
        while (Buffer.byteLength(body) > MAX_FILE_BYTES && reports.length > 1) {
          reports.shift()
          body = JSON.stringify({ version: 1, reports, lastFailure }, null, 2)
        }
        if (Buffer.byteLength(body) > MAX_FILE_BYTES)
          throw new Error("Compaction diagnostic exceeds size limit")
        await mkdir(directory, { recursive: true })
        const temporary = `${path}.tmp`
        await writeFile(temporary, `${body}\n`, "utf8")
        await rename(temporary, path)
      })
    pendingWrites.set(path, write)
    try {
      await write
    } finally {
      if (pendingWrites.get(path) === write) pendingWrites.delete(path)
    }
  }
}

export async function readCompactionDiagnostics(directory: string | null): Promise<string> {
  if (!directory)
    return `${JSON.stringify({ version: 1, reports: [], unavailableReason: "workspace_unavailable" })}\n`
  const path = join(directory, COMPACTION_DIAGNOSTICS_FILE)
  await pendingWrites.get(path)?.catch(() => {})
  return `${JSON.stringify(await readDiagnosticFile(path), null, 2)}\n`
}
