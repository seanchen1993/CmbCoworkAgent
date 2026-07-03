import { createHash } from "crypto"
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "fs"
import { appendFile, readFile, writeFile } from "fs/promises"
import { join } from "path"
import { getOpenworkDir } from "../../storage"
import {
  DEFAULT_TASK_MMD_SETTINGS,
  DEFAULT_TASK_MMD_STATE,
  type TaskMmdSettings,
  type TaskMmdSnapshot,
  type TaskMmdState,
  type TaskMmdToolEntry
} from "./types"

const TASK_MMD_DIR = "task-mmd"
const SETTINGS_FILE = "task-mmd-settings.json"
const ENTRIES_FILE = "entries.jsonl"
const ACTIVE_MMD_FILE = "active.mmd"
const STATE_FILE = "state.json"
const SAFE_ID_RE = /^[a-zA-Z0-9_-]+$/
const DELETE_TOMBSTONE_TTL_MS = 10 * 60_000

const threadQueues = new Map<string, Promise<unknown>>()
const deletedThreadIds = new Set<string>()
const deletedThreadCleanupTimers = new Map<
  string,
  ReturnType<typeof setTimeout> & { unref?: () => void }
>()

function safeThreadDirName(threadId: string): string {
  if (SAFE_ID_RE.test(threadId)) return threadId
  const hash = createHash("sha256").update(threadId).digest("hex").slice(0, 16)
  const prefix = threadId.replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 32) || "thread"
  return `${prefix}_${hash}`
}

function atomicWriteFileSync(path: string, content: string): void {
  const temp = `${path}.${process.pid}.${Date.now()}.tmp`
  writeFileSync(temp, content, "utf-8")
  renameSync(temp, path)
}

async function atomicWriteFile(path: string, content: string): Promise<void> {
  const temp = `${path}.${process.pid}.${Date.now()}.tmp`
  await writeFile(temp, content, "utf-8")
  renameSync(temp, path)
}

function readJsonFile<T>(path: string, fallback: T): T {
  if (!existsSync(path)) return fallback
  try {
    return JSON.parse(readFileSync(path, "utf-8")) as T
  } catch {
    return fallback
  }
}

function normalizeSettings(raw: Partial<TaskMmdSettings>): TaskMmdSettings {
  const defaults = DEFAULT_TASK_MMD_SETTINGS
  const intInRange = (value: unknown, fallback: number, min: number, max: number): number => {
    if (typeof value !== "number" || !Number.isFinite(value)) return fallback
    return Math.min(max, Math.max(min, Math.floor(value)))
  }

  return {
    enabled: raw.enabled === true,
    compileModelTier: raw.compileModelTier === "premium" ? "premium" : "economy",
    l2NullThreshold: intInRange(raw.l2NullThreshold, defaults.l2NullThreshold, 1, 50),
    l2TimeoutSeconds: intInRange(raw.l2TimeoutSeconds, defaults.l2TimeoutSeconds, 10, 3600),
    maxEntriesPerCompile: intInRange(raw.maxEntriesPerCompile, defaults.maxEntriesPerCompile, 4, 200),
    maxMmdChars: intInRange(raw.maxMmdChars, defaults.maxMmdChars, 500, 30000),
    argsPreviewChars: intInRange(raw.argsPreviewChars, defaults.argsPreviewChars, 200, 10000),
    resultPreviewChars: intInRange(raw.resultPreviewChars, defaults.resultPreviewChars, 200, 20000)
  }
}

function normalizeState(raw: Partial<TaskMmdState>): TaskMmdState {
  return {
    ...DEFAULT_TASK_MMD_STATE,
    ...raw,
    lastCompiledAt: typeof raw.lastCompiledAt === "string" ? raw.lastCompiledAt : null,
    compiledEntryCount:
      typeof raw.compiledEntryCount === "number" && raw.compiledEntryCount >= 0
        ? Math.floor(raw.compiledEntryCount)
        : 0,
    totalEntryCount:
      typeof raw.totalEntryCount === "number" && raw.totalEntryCount >= 0
        ? Math.floor(raw.totalEntryCount)
        : 0,
    compileStatus:
      raw.compileStatus === "compiling" || raw.compileStatus === "error"
        ? raw.compileStatus
        : "idle",
    lastCompileMode: raw.lastCompileMode === "fallback" ? "fallback" : raw.lastCompileMode === "llm" ? "llm" : undefined,
    lastError: typeof raw.lastError === "string" ? raw.lastError : undefined,
    lastFailedAt: typeof raw.lastFailedAt === "string" ? raw.lastFailedAt : null,
    lastFailureCount:
      typeof raw.lastFailureCount === "number" && raw.lastFailureCount >= 0
        ? Math.floor(raw.lastFailureCount)
        : 0,
    userEdited: raw.userEdited === true
  }
}

async function enqueueForThread<T>(threadId: string, task: () => Promise<T>): Promise<T> {
  const previous = threadQueues.get(threadId) ?? Promise.resolve()
  const next = previous
    .catch(() => undefined)
    .then(task)
    .finally(() => {
      if (threadQueues.get(threadId) === next) {
        threadQueues.delete(threadId)
      }
    })
  threadQueues.set(threadId, next)
  return next
}

function scheduleDeletedThreadCleanup(threadId: string): void {
  const existing = deletedThreadCleanupTimers.get(threadId)
  if (existing) clearTimeout(existing)

  const timer = setTimeout(() => {
    if (threadQueues.has(threadId)) {
      scheduleDeletedThreadCleanup(threadId)
      return
    }
    deletedThreadIds.delete(threadId)
    deletedThreadCleanupTimers.delete(threadId)
  }, DELETE_TOMBSTONE_TTL_MS) as ReturnType<typeof setTimeout> & { unref?: () => void }

  timer.unref?.()
  deletedThreadCleanupTimers.set(threadId, timer)
}

function clearDeletedThreadTombstone(threadId: string): void {
  deletedThreadIds.delete(threadId)
  const timer = deletedThreadCleanupTimers.get(threadId)
  if (timer) clearTimeout(timer)
  deletedThreadCleanupTimers.delete(threadId)
}

export function isTaskMmdThreadDeleted(threadId: string): boolean {
  return deletedThreadIds.has(threadId)
}

export function getTaskMmdRootDir(): string {
  const dir = join(getOpenworkDir(), TASK_MMD_DIR)
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
  return dir
}

export function getTaskMmdThreadDir(threadId: string): string {
  const dir = join(getTaskMmdRootDir(), safeThreadDirName(threadId))
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
  return dir
}

function getExistingTaskMmdThreadDir(threadId: string): string {
  return join(getTaskMmdRootDir(), safeThreadDirName(threadId))
}

export function getTaskMmdSettingsPath(): string {
  return join(getOpenworkDir(), SETTINGS_FILE)
}

export function getTaskMmdSettings(): TaskMmdSettings {
  return normalizeSettings(readJsonFile<Partial<TaskMmdSettings>>(getTaskMmdSettingsPath(), {}))
}

export function setTaskMmdSettings(patch: Partial<TaskMmdSettings>): TaskMmdSettings {
  const next = normalizeSettings({ ...getTaskMmdSettings(), ...patch })
  atomicWriteFileSync(getTaskMmdSettingsPath(), JSON.stringify(next, null, 2))
  return next
}

export function getTaskMmdState(threadId: string): TaskMmdState {
  if (deletedThreadIds.has(threadId)) return normalizeState({})
  return normalizeState(
    readJsonFile<Partial<TaskMmdState>>(join(getTaskMmdThreadDir(threadId), STATE_FILE), {})
  )
}

export async function writeTaskMmdState(
  threadId: string,
  state: Partial<TaskMmdState>
): Promise<TaskMmdState> {
  if (deletedThreadIds.has(threadId)) return normalizeState(state)
  const next = normalizeState({ ...getTaskMmdState(threadId), ...state })
  await atomicWriteFile(join(getTaskMmdThreadDir(threadId), STATE_FILE), JSON.stringify(next, null, 2))
  return next
}

export function readTaskMmd(threadId: string): string {
  if (deletedThreadIds.has(threadId)) return ""
  const path = join(getTaskMmdThreadDir(threadId), ACTIVE_MMD_FILE)
  if (!existsSync(path)) return ""
  try {
    return readFileSync(path, "utf-8")
  } catch {
    return ""
  }
}

export async function writeTaskMmd(threadId: string, mmd: string): Promise<void> {
  if (deletedThreadIds.has(threadId)) return
  await atomicWriteFile(join(getTaskMmdThreadDir(threadId), ACTIVE_MMD_FILE), mmd)
}

export async function appendTaskMmdEntry(entry: TaskMmdToolEntry): Promise<number> {
  if (deletedThreadIds.has(entry.threadId)) return 0
  return enqueueForThread(entry.threadId, async () => {
    if (deletedThreadIds.has(entry.threadId)) return 0
    const dir = getTaskMmdThreadDir(entry.threadId)
    await appendFile(join(dir, ENTRIES_FILE), `${JSON.stringify(entry)}\n`, "utf-8")
    const state = getTaskMmdState(entry.threadId)
    const totalEntryCount = state.totalEntryCount + 1
    await writeTaskMmdState(entry.threadId, { totalEntryCount })
    return totalEntryCount
  })
}

export function readTaskMmdEntries(threadId: string, limit = 200): TaskMmdToolEntry[] {
  if (deletedThreadIds.has(threadId)) return []
  const path = join(getTaskMmdThreadDir(threadId), ENTRIES_FILE)
  if (!existsSync(path)) return []
  try {
    const lines = readFileSync(path, "utf-8").split(/\r?\n/).filter(Boolean)
    return lines
      .slice(Math.max(0, lines.length - limit))
      .map((line) => JSON.parse(line) as TaskMmdToolEntry)
      .filter((entry) => entry && typeof entry.toolCallId === "string")
  } catch {
    return []
  }
}

export async function readTaskMmdEntriesAsync(threadId: string): Promise<TaskMmdToolEntry[]> {
  if (deletedThreadIds.has(threadId)) return []
  const path = join(getTaskMmdThreadDir(threadId), ENTRIES_FILE)
  if (!existsSync(path)) return []
  try {
    const content = await readFile(path, "utf-8")
    return content
      .split(/\r?\n/)
      .filter(Boolean)
      .map((line) => JSON.parse(line) as TaskMmdToolEntry)
      .filter((entry) => entry && typeof entry.toolCallId === "string")
  } catch {
    return []
  }
}

export function getTaskMmdSnapshot(threadId: string): TaskMmdSnapshot {
  const directory = deletedThreadIds.has(threadId)
    ? getExistingTaskMmdThreadDir(threadId)
    : getTaskMmdThreadDir(threadId)
  return {
    threadId,
    directory,
    settings: getTaskMmdSettings(),
    state: getTaskMmdState(threadId),
    mmd: readTaskMmd(threadId),
    entries: readTaskMmdEntries(threadId, 100)
  }
}

export function clearTaskMmdThread(threadId: string): void {
  clearDeletedThreadTombstone(threadId)
  const dir = getTaskMmdThreadDir(threadId)
  if (existsSync(dir)) rmSync(dir, { recursive: true, force: true })
}

export function deleteTaskMmdThread(threadId: string): void {
  deletedThreadIds.add(threadId)
  scheduleDeletedThreadCleanup(threadId)
  const dir = getExistingTaskMmdThreadDir(threadId)
  if (existsSync(dir)) rmSync(dir, { recursive: true, force: true })
}

export function getTaskMmdDirectorySize(threadId: string): number {
  if (deletedThreadIds.has(threadId)) return 0
  const dir = getTaskMmdThreadDir(threadId)
  let total = 0
  for (const file of [ENTRIES_FILE, ACTIVE_MMD_FILE, STATE_FILE]) {
    const path = join(dir, file)
    if (existsSync(path)) total += statSync(path).size
  }
  return total
}

export function withTaskMmdThreadQueue<T>(
  threadId: string,
  task: () => Promise<T>
): Promise<T> {
  return enqueueForThread(threadId, task)
}
