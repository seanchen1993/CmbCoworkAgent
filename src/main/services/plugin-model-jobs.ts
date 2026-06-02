import { existsSync, readFileSync } from "fs"
import { isAbsolute, relative, resolve } from "path"
import { BrowserWindow } from "electron"
import { HumanMessage, SystemMessage } from "@langchain/core/messages"
import type {
  BackgroundJobListOptions,
  BackgroundJobStatusRecord,
  BackgroundJobUpdatedEvent,
  BackgroundModelJobRequest
} from "../../shared/plugin-model-jobs"
import { createInternalChatModel } from "./model-factory"
import {
  appendLog,
  atomicWriteText,
  cleanupTmp,
  createBaseStatus,
  ensureWorkspaceJobDirs,
  filterJobStatuses,
  loadJobRequests,
  loadJobStatuses,
  markInterrupted,
  pruneRetainedJobs,
  readJobStatus,
  writeJobStatus,
  type LoadedJobRequest
} from "./plugin-model-job-store"
import {
  BackgroundJobValidationError,
  validateBackgroundJobRequest,
  type ValidatedBackgroundJob
} from "./plugin-model-job-permissions"
import { getAllThreads } from "../db"

const MAX_CONCURRENT_JOBS = 1
const POLL_INTERVAL_MS = 10_000
const HEARTBEAT_INTERVAL_MS = 15_000
const LEASE_MS = 45_000
const MAINTENANCE_INTERVAL_MS = 5 * 60_000
const DEFAULT_SYSTEM_PROMPT = [
  "你是 Claw 后台模型任务执行器。",
  "你不会调用工具，也不会进入当前对话流。",
  "你必须只根据用户提供的 prompt、input files 和允许输出清单生成输出。",
  '返回格式必须是严格 JSON：{"files":[{"path":"允许输出路径","content":"文件内容"}]}。',
  "files[].path 必须逐字等于允许输出清单中的某一个 path。",
  "不要返回 Markdown 包裹，不要返回解释性前后缀。"
].join("\n")

interface QueueEntry {
  loaded: LoadedJobRequest
  validated: ValidatedBackgroundJob
}

interface RunningJobControl {
  controller: AbortController
  abortReason?: "timeout" | "shutdown"
}

const knownWorkspaces = new Set<string>()
const reconciledWorkspaces = new Set<string>()
const maintenanceTimestamps = new Map<string, number>()
const queuedKeys = new Set<string>()
const runningControllers = new Map<string, RunningJobControl>()
const queue: QueueEntry[] = []
let runningCount = 0
let started = false
let pollTimer: NodeJS.Timeout | null = null

function broadcastJobUpdated(record: BackgroundJobStatusRecord): void {
  const payload: BackgroundJobUpdatedEvent = {
    jobKey: record.jobKey,
    jobId: record.jobId,
    pluginId: record.pluginId,
    type: record.type,
    workspace: record.workspace,
    status: record.status
  }
  for (const win of BrowserWindow.getAllWindows()) {
    if (win.isDestroyed() || win.webContents.isDestroyed()) continue
    win.webContents.send("pluginJobs:updated", payload)
  }
}

function statusIsTerminal(status: BackgroundJobStatusRecord["status"]): boolean {
  return ["completed", "failed", "timeout", "cancelled", "interrupted", "rejected"].includes(status)
}

function readWorkspaceFromThreadMetadata(metadata: string | null): string | null {
  if (!metadata) return null
  try {
    const parsed = JSON.parse(metadata) as Record<string, unknown>
    return typeof parsed.workspacePath === "string" && parsed.workspacePath.trim()
      ? parsed.workspacePath
      : null
  } catch {
    return null
  }
}

function discoverStartupWorkspaces(): string[] {
  const result = new Set<string>()
  try {
    for (const thread of getAllThreads().slice(0, 30)) {
      const workspace = readWorkspaceFromThreadMetadata(thread.metadata)
      if (workspace) result.add(workspace)
    }
  } catch (error) {
    console.warn("[PluginModelJobs] Failed to discover thread workspaces:", error)
  }
  return Array.from(result)
}

function sameWorkspace(left: string, right: string): boolean {
  if (!isAbsolute(left) || !isAbsolute(right)) return false
  const rel = relative(resolve(left), resolve(right))
  return rel === ""
}

function enqueue(loaded: LoadedJobRequest, validated: ValidatedBackgroundJob): void {
  const key = `${loaded.request.workspace}:${loaded.request.pluginId}:${loaded.request.jobId}`
  if (queuedKeys.has(key)) return
  queuedKeys.add(key)
  queue.push({ loaded, validated })
  drainQueue()
}

function ensureRequestSchema(raw: BackgroundModelJobRequest): void {
  if (!raw || typeof raw !== "object") throw new BackgroundJobValidationError("INVALID_REQUEST", "job request 不是对象")
}

function rejectJob(loaded: LoadedJobRequest, error: BackgroundJobValidationError | Error): void {
  const jobError = error instanceof BackgroundJobValidationError
    ? error.toJobError()
    : { code: "VALIDATION_FAILED", message: error.message }
  const record = createBaseStatus(loaded, "rejected", jobError)
  writeJobStatus(record)
  appendLog(record.workspace, record.pluginId, record.jobId, `rejected: ${jobError.code} ${jobError.message}`)
  broadcastJobUpdated(record)
}

function prepareWorkspaceForScan(workspace: string): void {
  ensureWorkspaceJobDirs(workspace)
  const now = Date.now()
  const lastMaintenanceAt = maintenanceTimestamps.get(workspace) ?? 0
  if (now - lastMaintenanceAt < MAINTENANCE_INTERVAL_MS) return
  cleanupTmp(workspace)
  pruneRetainedJobs(workspace)
  maintenanceTimestamps.set(workspace, now)
}

function shouldInterruptRunningStatus(status: BackgroundJobStatusRecord, firstReconcile: boolean, now: number): boolean {
  if (runningControllers.has(status.jobKey)) return false
  if (firstReconcile) return true
  const leaseExpiresAt = status.leaseExpiresAt ? Date.parse(status.leaseExpiresAt) : Number.NaN
  return !Number.isFinite(leaseExpiresAt) || leaseExpiresAt < now
}

function reconcileWorkspace(workspace: string): void {
  prepareWorkspaceForScan(workspace)
  const firstReconcile = !reconciledWorkspaces.has(workspace)
  reconciledWorkspaces.add(workspace)
  const now = Date.now()
  for (const status of loadJobStatuses(workspace)) {
    if (status.status !== "running") continue
    if (!shouldInterruptRunningStatus(status, firstReconcile, now)) continue
    const interrupted = markInterrupted(
      status,
      firstReconcile
        ? "Claw 上次退出时该任务仍在运行，已标记为中断"
        : "后台任务租约已过期，已标记为中断"
    )
    writeJobStatus(interrupted)
    appendLog(interrupted.workspace, interrupted.pluginId, interrupted.jobId, "interrupted during reconciliation")
    broadcastJobUpdated(interrupted)
  }
}

export function scanPluginModelJobsWorkspace(workspace: string): void {
  if (!workspace || !existsSync(workspace)) return
  knownWorkspaces.add(workspace)
  reconcileWorkspace(workspace)

  for (const loaded of loadJobRequests(workspace)) {
    const req = loaded.request
    try {
      ensureRequestSchema(req)
      if (!sameWorkspace(req.workspace, workspace)) {
        throw new BackgroundJobValidationError("WORKSPACE_MISMATCH", "job request 的 workspace 与请求文件所在 workspace 不一致", { requestWorkspace: req.workspace, scannedWorkspace: workspace })
      }
      const validated = validateBackgroundJobRequest(req)
      const existing = readJobStatus(req.workspace, req.pluginId, req.jobId)
      if (existing && statusIsTerminal(existing.status)) continue
      if (existing?.status === "running") continue
      const queueKey = `${req.workspace}:${req.pluginId}:${req.jobId}`
      if (existing?.status === "pending" && queuedKeys.has(queueKey)) continue
      if (!existing) {
        const pending = createBaseStatus(loaded, "pending")
        writeJobStatus({
          ...pending,
          timeoutMs: validated.timeoutMs
        })
        broadcastJobUpdated(pending)
      }
      enqueue(loaded, validated)
    } catch (error) {
      rejectJob(loaded, error instanceof Error ? error : new Error(String(error)))
    }
  }
}

function getMessageText(value: unknown): string {
  if (typeof value === "string") return value
  if (Array.isArray(value)) {
    return value.map((item) => getMessageText(item)).filter(Boolean).join("\n")
  }
  if (value && typeof value === "object") {
    const obj = value as Record<string, unknown>
    if (typeof obj.text === "string") return obj.text
    if (typeof obj.content === "string") return obj.content
  }
  return ""
}

export function stripJsonFenceForPluginModelJobTest(text: string): string {
  const trimmed = text.trim()
  const match = trimmed.match(/^\s*```(?:json)?\s*([\s\S]*?)\s*```\s*$/i)
  return match?.[1]?.trim() ?? trimmed
}

export function modelJsonCandidatesForPluginModelJobTest(text: string): string[] {
  const stripped = stripJsonFenceForPluginModelJobTest(text)
  const candidates = [stripped]
  const firstBrace = stripped.indexOf("{")
  const lastBrace = stripped.lastIndexOf("}")
  if (firstBrace >= 0 && lastBrace > firstBrace) {
    candidates.push(stripped.slice(firstBrace, lastBrace + 1))
  }
  return Array.from(new Set(candidates.map((candidate) => candidate.trim()).filter(Boolean)))
}

function readInputText(validated: ValidatedBackgroundJob): string {
  const outputList = validated.outputFiles
    .map((output) => `- path: ${output.relativePath}; mode: ${output.mode}; contentType: ${output.contentType ?? "text"}`)
    .join("\n")
  const chunks: string[] = []
  const promptText = readFileSync(validated.promptFile, "utf8")
  chunks.push(`# Allowed Outputs\n\n${outputList}`)
  chunks.push(`# Prompt: ${validated.promptFileRequestPath}\n\n${promptText}`)
  for (let index = 0; index < validated.inputFiles.length; index++) {
    const file = validated.inputFiles[index]
    const requestPath = validated.inputFileRequestPaths[index] ?? file
    const inputText = readFileSync(file, "utf8")
    chunks.push(`\n\n# Input File: ${requestPath}\n\n${inputText}`)
  }
  return chunks.join("\n")
}

interface ModelOutputFile {
  path: string
  content: string
}

export function parseModelFilesForPluginModelJobTest(text: string): ModelOutputFile[] {
  let parsed: { files?: Array<{ path?: unknown; content?: unknown }> } | null = null
  let lastError: unknown = null
  for (const candidate of modelJsonCandidatesForPluginModelJobTest(text)) {
    try {
      parsed = JSON.parse(candidate) as { files?: Array<{ path?: unknown; content?: unknown }> }
      break
    } catch (error) {
      lastError = error
    }
  }
  if (!parsed) {
    const message = lastError instanceof Error ? lastError.message : "unknown parse error"
    throw new Error(`模型输出不是有效 JSON: ${message}`)
  }
  if (!Array.isArray(parsed.files) || parsed.files.length === 0) {
    throw new Error("模型输出 JSON 缺少 files")
  }
  return parsed.files.map((file, index) => {
    if (typeof file.path !== "string" || !file.path.trim()) throw new Error(`files[${index}].path 无效`)
    if (typeof file.content !== "string") throw new Error(`files[${index}].content 必须是字符串`)
    return { path: file.path, content: file.content }
  })
}

function matchOutputSpec(validated: ValidatedBackgroundJob, filePath: string): ValidatedBackgroundJob["outputFiles"][number] | null {
  const normalized = filePath.replace(/\\/g, "/").replace(/^\.\/+/, "")
  return validated.outputFiles.find((output) => output.relativePath === normalized) ?? null
}

async function runQueueEntry(entry: QueueEntry): Promise<void> {
  const req = entry.loaded.request
  const controller = new AbortController()
  const control: RunningJobControl = { controller }
  const startedAt = new Date().toISOString()
  const timeoutMs = entry.validated.timeoutMs
  const base = readJobStatus(req.workspace, req.pluginId, req.jobId) ?? createBaseStatus(entry.loaded, "pending")
  let record: BackgroundJobStatusRecord = {
    ...base,
    status: "running",
    startedAt,
    heartbeatAt: startedAt,
    attempt: (base.attempt ?? 0) + 1,
    timeoutMs,
    leaseOwner: `main-process:${process.pid}`,
    leaseExpiresAt: new Date(Date.now() + LEASE_MS).toISOString(),
    error: null
  }
  writeJobStatus(record)
  appendLog(req.workspace, req.pluginId, req.jobId, "running")
  broadcastJobUpdated(record)
  runningControllers.set(record.jobKey, control)

  const heartbeat = setInterval(() => {
    record = {
      ...record,
      heartbeatAt: new Date().toISOString(),
      leaseExpiresAt: new Date(Date.now() + LEASE_MS).toISOString()
    }
    writeJobStatus(record)
  }, HEARTBEAT_INTERVAL_MS)

  const timeout = setTimeout(() => {
    control.abortReason = "timeout"
    controller.abort()
  }, timeoutMs)

  try {
    const model = createInternalChatModel(entry.validated.modelId, {
      timeoutMs,
      maxOutputTokens: entry.validated.maxOutputTokens
    })
    if (!model) throw new Error("未配置可用模型或模型缺少 API Key")

    const userText = readInputText(entry.validated)
    const response = await model.invoke(
      [new SystemMessage(DEFAULT_SYSTEM_PROMPT), new HumanMessage(userText)],
      { signal: controller.signal }
    )
    if (controller.signal.aborted) throw new Error("任务已取消或超时")

    const files = parseModelFilesForPluginModelJobTest(getMessageText(response.content))
    const written: string[] = []
    for (const file of files) {
      const spec = matchOutputSpec(entry.validated, file.path)
      if (!spec) throw new Error(`模型请求写入未声明输出: ${file.path}`)
      atomicWriteText(spec.absolutePath, file.content, spec.mode)
      written.push(spec.relativePath)
    }

    const endedAt = new Date().toISOString()
    record = {
      ...record,
      status: "completed",
      endedAt,
      durationMs: Math.max(0, Date.parse(endedAt) - Date.parse(startedAt)),
      outputFiles: written,
      leaseOwner: undefined,
      leaseExpiresAt: undefined,
      error: null
    }
    writeJobStatus(record)
    appendLog(req.workspace, req.pluginId, req.jobId, `completed outputs=${written.length}`)
    broadcastJobUpdated(record)
  } catch (error) {
    const endedAt = new Date().toISOString()
    const aborted = controller.signal.aborted
    const shutdownAbort = aborted && control.abortReason === "shutdown"
    record = {
      ...record,
      status: shutdownAbort ? "interrupted" : aborted ? "timeout" : "failed",
      endedAt,
      durationMs: Math.max(0, Date.parse(endedAt) - Date.parse(startedAt)),
      leaseOwner: undefined,
      leaseExpiresAt: undefined,
      error: {
        code: shutdownAbort ? "SHUTDOWN" : aborted ? "TIMEOUT" : "EXECUTION_FAILED",
        message: shutdownAbort
          ? "Claw 正在退出，后台任务已中断"
          : error instanceof Error
            ? error.message
            : String(error)
      }
    }
    writeJobStatus(record)
    appendLog(req.workspace, req.pluginId, req.jobId, `${record.status}: ${record.error?.message ?? ""}`)
    broadcastJobUpdated(record)
  } finally {
    clearInterval(heartbeat)
    clearTimeout(timeout)
    runningControllers.delete(record.jobKey)
  }
}

function drainQueue(): void {
  while (runningCount < MAX_CONCURRENT_JOBS && queue.length > 0) {
    const entry = queue.shift()!
    const key = `${entry.loaded.request.workspace}:${entry.loaded.request.pluginId}:${entry.loaded.request.jobId}`
    runningCount++
    void runQueueEntry(entry)
      .catch((error) => console.error("[PluginModelJobs] worker error:", error))
      .finally(() => {
        queuedKeys.delete(key)
        runningCount--
        drainQueue()
      })
  }
}

export function startPluginModelJobs(): void {
  if (started) return
  started = true
  for (const workspace of discoverStartupWorkspaces()) {
    scanPluginModelJobsWorkspace(workspace)
  }
  pollTimer = setInterval(() => {
    for (const workspace of Array.from(knownWorkspaces)) {
      scanPluginModelJobsWorkspace(workspace)
    }
  }, POLL_INTERVAL_MS)
  console.log("[PluginModelJobs] started")
}

export function stopPluginModelJobs(): void {
  if (!started) return
  started = false
  if (pollTimer) clearInterval(pollTimer)
  pollTimer = null
  for (const control of runningControllers.values()) {
    control.abortReason = "shutdown"
    control.controller.abort()
  }
  queue.length = 0
  queuedKeys.clear()
  console.log("[PluginModelJobs] stopped")
}

export function listPluginModelJobs(options?: BackgroundJobListOptions): BackgroundJobStatusRecord[] {
  if (!options?.workspace) return []
  return filterJobStatuses(loadJobStatuses(options.workspace), options)
}

export function getPluginModelJob(workspace: string, pluginId: string, jobId: string): BackgroundJobStatusRecord | null {
  return readJobStatus(workspace, pluginId, jobId)
}
