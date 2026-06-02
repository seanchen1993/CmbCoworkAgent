import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "fs"
import { createHash } from "crypto"
import { basename, dirname, isAbsolute, join, relative, resolve } from "path"
import type {
  BackgroundJobListOptions,
  BackgroundJobStatus,
  BackgroundJobStatusRecord,
  BackgroundModelJobRequest
} from "../../shared/plugin-model-jobs"

export const BACKGROUND_JOBS_ROOT = ".claw/background-jobs"
const REQUESTS_DIR = "requests"
const STATUS_DIR = "status"
const LOGS_DIR = "logs"
const TMP_DIR = "tmp"
const SAFE_JOB_ID_RE = /^[a-zA-Z0-9._-]{1,120}$/

export interface LoadedJobRequest {
  workspace: string
  request: BackgroundModelJobRequest
  absoluteRequestPath: string
  relativeRequestPath: string
  requestHash: string
}

function normalizeSlashes(value: string): string {
  return value.replace(/\\/g, "/")
}

export function isSafeJobId(value: string): boolean {
  return SAFE_JOB_ID_RE.test(value)
}

export function makeWorkspaceHash(workspace: string): string {
  return createHash("sha256").update(resolve(workspace)).digest("hex").slice(0, 12)
}

function safeStatusSegment(value: string | undefined, fallback: string): string {
  if (value && SAFE_JOB_ID_RE.test(value)) return value
  const suffix = createHash("sha256").update(value ?? fallback).digest("hex").slice(0, 10)
  return `${fallback}-${suffix}`
}

export function makeJobKey(workspace: string, pluginId: string, jobId: string): string {
  return `${makeWorkspaceHash(workspace)}:${pluginId}:${jobId}`
}

export function getBackgroundJobsRoot(workspace: string): string {
  return join(resolve(workspace), BACKGROUND_JOBS_ROOT)
}

export function getRequestsDir(workspace: string): string {
  return join(getBackgroundJobsRoot(workspace), REQUESTS_DIR)
}

export function getStatusDir(workspace: string): string {
  return join(getBackgroundJobsRoot(workspace), STATUS_DIR)
}

export function getLogsDir(workspace: string): string {
  return join(getBackgroundJobsRoot(workspace), LOGS_DIR)
}

export function getTmpDir(workspace: string): string {
  return join(getBackgroundJobsRoot(workspace), TMP_DIR)
}

export function getPluginStatusDir(workspace: string, pluginId: string): string {
  return join(getStatusDir(workspace), pluginId)
}

export function getPluginLogsDir(workspace: string, pluginId: string): string {
  return join(getLogsDir(workspace), pluginId)
}

export function getStatusPath(workspace: string, pluginId: string, jobId: string): string {
  return join(getPluginStatusDir(workspace, pluginId), `${jobId}.json`)
}

export function getLogPath(workspace: string, pluginId: string, jobId: string): string {
  return join(getPluginLogsDir(workspace, pluginId), `${jobId}.log`)
}

export function makeWorkspaceRelativePath(workspace: string, absolutePath: string): string {
  const rel = normalizeSlashes(relative(resolve(workspace), resolve(absolutePath)))
  return rel || "."
}

export function resolveWorkspacePath(workspace: string, relOrAbs: string): string | null {
  if (typeof relOrAbs !== "string" || !relOrAbs.trim() || relOrAbs.includes("\0")) return null
  const root = resolve(workspace)
  const target = isAbsolute(relOrAbs) ? resolve(relOrAbs) : resolve(root, relOrAbs)
  const rel = relative(root, target)
  if (rel.startsWith("..") || isAbsolute(rel)) return null
  return target
}

function readJsonFile<T>(filePath: string): T | null {
  try {
    return JSON.parse(readFileSync(filePath, "utf8")) as T
  } catch (error) {
    console.warn("[PluginModelJobs] Failed to read JSON", filePath, error)
    return null
  }
}

export function atomicWriteJson(filePath: string, value: unknown): void {
  mkdirSync(dirname(filePath), { recursive: true })
  const tmpPath = join(dirname(filePath), `.${basename(filePath)}.${process.pid}.${Date.now()}.tmp`)
  writeFileSync(tmpPath, JSON.stringify(value, null, 2) + "\n", "utf8")
  renameSync(tmpPath, filePath)
}

export function atomicWriteText(filePath: string, value: string, mode: "create" | "overwrite" | "append" = "overwrite"): void {
  mkdirSync(dirname(filePath), { recursive: true })
  if (mode === "append") {
    const prev = existsSync(filePath) ? readFileSync(filePath, "utf8") : ""
    const tmpPath = join(dirname(filePath), `.${basename(filePath)}.${process.pid}.${Date.now()}.tmp`)
    writeFileSync(tmpPath, prev + value, "utf8")
    renameSync(tmpPath, filePath)
    return
  }
  if (mode === "create" && existsSync(filePath)) {
    throw new Error(`目标文件已存在: ${filePath}`)
  }
  const tmpPath = join(dirname(filePath), `.${basename(filePath)}.${process.pid}.${Date.now()}.tmp`)
  writeFileSync(tmpPath, value, "utf8")
  renameSync(tmpPath, filePath)
}

export function appendLog(workspace: string, pluginId: string, jobId: string, message: string): string {
  const logPath = getLogPath(workspace, pluginId, jobId)
  mkdirSync(dirname(logPath), { recursive: true })
  const line = `[${new Date().toISOString()}] ${message}\n`
  const previous = existsSync(logPath) ? readFileSync(logPath, "utf8") : ""
  const next = (previous + line).slice(-2 * 1024 * 1024)
  writeFileSync(logPath, next, "utf8")
  return makeWorkspaceRelativePath(workspace, logPath)
}

function hashFile(filePath: string): string {
  return createHash("sha256").update(readFileSync(filePath)).digest("hex")
}

function walkJsonFiles(dirPath: string): string[] {
  if (!existsSync(dirPath)) return []
  const result: string[] = []
  const stack = [dirPath]
  while (stack.length > 0) {
    const current = stack.pop()!
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const fullPath = join(current, entry.name)
      if (entry.isDirectory()) {
        stack.push(fullPath)
      } else if (entry.isFile() && entry.name.endsWith(".json")) {
        result.push(fullPath)
      }
    }
  }
  return result
}

export function loadJobRequests(workspace: string): LoadedJobRequest[] {
  const root = getRequestsDir(workspace)
  const result: LoadedJobRequest[] = []
  for (const filePath of walkJsonFiles(root)) {
    const request = readJsonFile<BackgroundModelJobRequest>(filePath)
    if (!request) continue
    result.push({
      workspace,
      request,
      absoluteRequestPath: filePath,
      relativeRequestPath: makeWorkspaceRelativePath(workspace, filePath),
      requestHash: hashFile(filePath)
    })
  }
  return result
}

export function readStatusRecord(filePath: string): BackgroundJobStatusRecord | null {
  return readJsonFile<BackgroundJobStatusRecord>(filePath)
}

export function readJobStatus(workspace: string, pluginId: string, jobId: string): BackgroundJobStatusRecord | null {
  const filePath = getStatusPath(workspace, pluginId, jobId)
  return existsSync(filePath) ? readStatusRecord(filePath) : null
}

export function writeJobStatus(record: BackgroundJobStatusRecord): void {
  atomicWriteJson(getStatusPath(record.workspace, record.pluginId, record.jobId), record)
}

export function loadJobStatuses(workspace: string): BackgroundJobStatusRecord[] {
  const root = getStatusDir(workspace)
  const result: BackgroundJobStatusRecord[] = []
  for (const filePath of walkJsonFiles(root)) {
    const record = readStatusRecord(filePath)
    if (record) result.push(record)
  }
  return result
}

export function filterJobStatuses(
  records: BackgroundJobStatusRecord[],
  options?: BackgroundJobListOptions
): BackgroundJobStatusRecord[] {
  const statusSet = options?.status?.length ? new Set<BackgroundJobStatus>(options.status) : null
  const filtered = records.filter((record) => {
    if (options?.workspace && resolve(record.workspace) !== resolve(options.workspace)) return false
    if (options?.pluginId && record.pluginId !== options.pluginId) return false
    if (options?.type && record.type !== options.type) return false
    if (statusSet && !statusSet.has(record.status)) return false
    return true
  })
  filtered.sort((a, b) => {
    const aTime = Date.parse(a.startedAt ?? a.acceptedAt ?? a.createdAt)
    const bTime = Date.parse(b.startedAt ?? b.acceptedAt ?? b.createdAt)
    return bTime - aTime
  })
  return filtered.slice(0, Math.max(1, Math.min(options?.limit ?? 50, 200)))
}

export function createBaseStatus(
  loaded: LoadedJobRequest,
  status: BackgroundJobStatus,
  error?: BackgroundJobStatusRecord["error"]
): BackgroundJobStatusRecord {
  const now = new Date().toISOString()
  const req = loaded.request
  const pluginId = safeStatusSegment(req.pluginId, "invalid-plugin")
  const jobId = safeStatusSegment(req.jobId, "invalid-job")
  const statusWorkspace = loaded.workspace
  const logFile = makeWorkspaceRelativePath(statusWorkspace, getLogPath(statusWorkspace, pluginId, jobId))
  return {
    schemaVersion: 1,
    jobKey: makeJobKey(statusWorkspace, pluginId, jobId),
    jobId,
    pluginId,
    type: typeof req.type === "string" && req.type.trim() ? req.type : "invalid",
    workspace: statusWorkspace,
    requestPath: loaded.relativeRequestPath,
    requestHash: loaded.requestHash,
    status,
    createdAt: req.createdAt ?? now,
    acceptedAt: status === "pending" ? now : undefined,
    endedAt: status === "rejected" ? now : undefined,
    durationMs: status === "rejected" ? 0 : undefined,
    attempt: 0,
    timeoutMs: req.timeoutMs,
    inputFiles: Array.isArray(req.inputFiles) ? req.inputFiles : [],
    outputFiles: [],
    logFile,
    error: error ?? null
  }
}

export function markInterrupted(record: BackgroundJobStatusRecord, reason = "Claw 上次退出时该任务仍在运行，已标记为中断"): BackgroundJobStatusRecord {
  const now = new Date().toISOString()
  return {
    ...record,
    status: "interrupted",
    endedAt: now,
    durationMs: record.startedAt ? Math.max(0, Date.parse(now) - Date.parse(record.startedAt)) : record.durationMs,
    leaseOwner: undefined,
    leaseExpiresAt: undefined,
    error: { code: "PROCESS_RESTARTED", message: reason }
  }
}

const TERMINAL_STATUSES = new Set(["completed", "failed", "timeout", "cancelled", "interrupted", "rejected"])

export function pruneRetainedJobs(workspace: string, options?: { maxAgeMs?: number; maxTerminalRecords?: number }): void {
  const maxAgeMs = options?.maxAgeMs ?? 30 * 24 * 60 * 60 * 1000
  const maxTerminalRecords = options?.maxTerminalRecords ?? 500
  const now = Date.now()
  const terminal = loadJobStatuses(workspace)
    .filter((record) => TERMINAL_STATUSES.has(record.status))
    .sort((a, b) => {
      const aTime = Date.parse(a.endedAt ?? a.startedAt ?? a.acceptedAt ?? a.createdAt) || 0
      const bTime = Date.parse(b.endedAt ?? b.startedAt ?? b.acceptedAt ?? b.createdAt) || 0
      return bTime - aTime
    })

  for (let index = 0; index < terminal.length; index++) {
    const record = terminal[index]
    const time = Date.parse(record.endedAt ?? record.startedAt ?? record.acceptedAt ?? record.createdAt) || 0
    if (index < maxTerminalRecords && now - time <= maxAgeMs) continue
    rmSync(getStatusPath(record.workspace, record.pluginId, record.jobId), { force: true })
    rmSync(getLogPath(record.workspace, record.pluginId, record.jobId), { force: true })
  }
}

export function cleanupTmp(workspace: string, maxAgeMs = 60 * 60 * 1000): void {
  const tmpDir = getTmpDir(workspace)
  if (!existsSync(tmpDir)) return
  const now = Date.now()
  for (const entry of readdirSync(tmpDir, { withFileTypes: true })) {
    const fullPath = join(tmpDir, entry.name)
    try {
      const stat = statSync(fullPath)
      if (now - stat.mtimeMs > maxAgeMs) rmSync(fullPath, { recursive: true, force: true })
    } catch {
      /* ignore */
    }
  }
}

function ensureGitExclude(workspace: string): void {
  const infoDir = join(resolve(workspace), ".git", "info")
  if (!existsSync(infoDir)) return
  const excludePath = join(infoDir, "exclude")
  const entry = `${BACKGROUND_JOBS_ROOT}/`
  const content = existsSync(excludePath) ? readFileSync(excludePath, "utf8") : ""
  if (content.split("\n").some((line) => line.trim() === entry)) return
  writeFileSync(excludePath, `${content}${content.endsWith("\n") || !content ? "" : "\n"}${entry}\n`, "utf8")
}

export function ensureWorkspaceJobDirs(workspace: string): void {
  mkdirSync(getRequestsDir(workspace), { recursive: true })
  mkdirSync(getStatusDir(workspace), { recursive: true })
  mkdirSync(getLogsDir(workspace), { recursive: true })
  mkdirSync(getTmpDir(workspace), { recursive: true })
  ensureGitExclude(workspace)
}
