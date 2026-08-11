import { randomUUID } from "node:crypto"
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises"
import { homedir } from "node:os"
import { join, resolve } from "node:path"
import { extractAiRecordingVariables } from "../../../../shared/browser-ai-recording-script"
import { MAX_BROWSER_SCRIPT_LIBRARY_ENTRIES } from "../../../../shared/browser-types"
import type {
  BrowserScriptLibraryDeleteInput,
  BrowserScriptLibraryEntry,
  BrowserScriptLibraryListOptions,
  BrowserScriptLibraryReadInput,
  BrowserScriptLibrarySaveInput,
  BrowserScriptLibraryUpdateInput
} from "../../../../shared/browser-types"

const BROWSER_LIBRARY_LOG_PREFIX = "[内置浏览器][BrowserScriptLibrary]"
const BROWSER_LIBRARY_DIR = "browser"
const BROWSER_LIBRARY_INDEX_FILE = "browser.json"
const BROWSER_LIBRARY_FILE_PREFIX = "browser-recording"
const BROWSER_LIBRARY_FILE_SUFFIX = ".spec.ts"
const SAFE_FILE_NAME_RE = /^[A-Za-z0-9._-]+$/

interface BrowserScriptLibraryManifest {
  entries: BrowserScriptLibraryEntry[]
  version: 1
}

let browserScriptLibraryRootOverride: string | null = null
let browserScriptLibraryMutationQueue: Promise<void> = Promise.resolve()

function getBrowserScriptLibraryRoot(): string {
  return browserScriptLibraryRootOverride ?? join(homedir(), ".cmbcoworkagent", BROWSER_LIBRARY_DIR)
}

function getBrowserScriptLibraryIndexPath(): string {
  return join(getBrowserScriptLibraryRoot(), BROWSER_LIBRARY_INDEX_FILE)
}

function normalizeText(value: string | null | undefined): string {
  return typeof value === "string" ? value.trim() : ""
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function ensureWorkspacePath(workspacePath: string): string {
  const trimmed = normalizeText(workspacePath)
  if (!trimmed) {
    throw new Error("请先为当前会话选择工作区")
  }
  return resolve(trimmed)
}

function normalizeEntry(value: unknown): BrowserScriptLibraryEntry | null {
  if (!isRecord(value)) return null
  const fileName = normalizeText(typeof value.fileName === "string" ? value.fileName : "")
  const threadId = normalizeText(typeof value.threadId === "string" ? value.threadId : "")
  const workspacePath = normalizeText(
    typeof value.workspacePath === "string" ? value.workspacePath : ""
  )
  const displayName = normalizeText(typeof value.displayName === "string" ? value.displayName : "")
  const description = normalizeText(typeof value.description === "string" ? value.description : "")
  const createdAt = normalizeText(typeof value.createdAt === "string" ? value.createdAt : "")
  const recordingSource =
    value.recordingSource === "manual" || value.recordingSource === "ai"
      ? value.recordingSource
      : "ai"

  if (!fileName || !workspacePath || !displayName || !createdAt) return null

  return {
    createdAt,
    description,
    displayName,
    fileName,
    recordingSource,
    threadId,
    workspacePath: resolve(workspacePath)
  }
}

function emptyManifest(): BrowserScriptLibraryManifest {
  return {
    version: 1,
    entries: []
  }
}

function parseManifest(raw: string): BrowserScriptLibraryManifest {
  const parsed = JSON.parse(raw) as unknown
  const entryCandidates = Array.isArray(parsed)
    ? parsed
    : isRecord(parsed) && Array.isArray(parsed.entries)
      ? parsed.entries
      : null

  if (!entryCandidates) {
    throw new Error("browser.json 配置格式无效")
  }

  return {
    version: 1,
    entries: entryCandidates
      .map((entry) => normalizeEntry(entry))
      .filter((entry): entry is BrowserScriptLibraryEntry => entry !== null)
  }
}

async function ensureBrowserScriptLibraryRoot(): Promise<void> {
  await mkdir(getBrowserScriptLibraryRoot(), { recursive: true })
}

async function readManifest(): Promise<BrowserScriptLibraryManifest> {
  try {
    const raw = await readFile(getBrowserScriptLibraryIndexPath(), "utf8")
    return parseManifest(raw)
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code
    if (code === "ENOENT") return emptyManifest()
    console.warn(`${BROWSER_LIBRARY_LOG_PREFIX} Failed to read browser.json:`, error)
    throw new Error("读取 browser.json 失败，请稍后重试")
  }
}

async function writeManifest(manifest: BrowserScriptLibraryManifest): Promise<void> {
  await ensureBrowserScriptLibraryRoot()
  const indexPath = getBrowserScriptLibraryIndexPath()
  const temporaryIndexPath = `${indexPath}.${randomUUID()}.tmp`
  await writeFile(temporaryIndexPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8")
  await rename(temporaryIndexPath, indexPath)
}

function buildUniqueFileName(createdAt: string): string {
  const timestamp = createdAt
    .replace(/\.\d{3}Z$/, "Z")
    .replaceAll("-", "")
    .replaceAll(":", "")
  return `${BROWSER_LIBRARY_FILE_PREFIX}-${timestamp}-${randomUUID().slice(0, 8)}${BROWSER_LIBRARY_FILE_SUFFIX}`
}

function assertSafeFileName(fileName: string): string {
  const normalized = normalizeText(fileName)
  if (
    !normalized ||
    !SAFE_FILE_NAME_RE.test(normalized) ||
    !normalized.startsWith(`${BROWSER_LIBRARY_FILE_PREFIX}-`) ||
    !normalized.endsWith(BROWSER_LIBRARY_FILE_SUFFIX)
  ) {
    throw new Error("脚本文件名无效")
  }
  return normalized
}

function getScriptPath(fileName: string): string {
  return join(getBrowserScriptLibraryRoot(), assertSafeFileName(fileName))
}

function runSerializedMutation<T>(operation: () => Promise<T>): Promise<T> {
  const task = browserScriptLibraryMutationQueue.then(operation, operation)
  browserScriptLibraryMutationQueue = task.then(
    () => undefined,
    () => undefined
  )
  return task
}

export async function saveBrowserScriptLibraryEntry(
  input: BrowserScriptLibrarySaveInput
): Promise<BrowserScriptLibraryEntry> {
  const workspacePath = ensureWorkspacePath(input.workspacePath)
  const displayName = normalizeText(input.displayName)
  const description = normalizeText(input.description)
  const recordingSource = input.recordingSource === "manual" ? "manual" : "ai"
  const script = typeof input.script === "string" ? input.script : ""
  const threadId = normalizeText(input.threadId)

  if (!displayName) {
    throw new Error("请输入文件中文名")
  }
  if (!script.trim()) {
    throw new Error("当前没有可保存的脚本内容")
  }

  return runSerializedMutation(async () => {
    await ensureBrowserScriptLibraryRoot()
    const manifest = await readManifest()
    if (manifest.entries.length >= MAX_BROWSER_SCRIPT_LIBRARY_ENTRIES) {
      throw new Error(
        `录制列表最多保存 ${MAX_BROWSER_SCRIPT_LIBRARY_ENTRIES} 个录制文件，请删除不需要的文件后再新增`
      )
    }

    const createdAt = new Date().toISOString()
    const fileName = buildUniqueFileName(createdAt)
    const nextEntry: BrowserScriptLibraryEntry = {
      createdAt,
      description,
      displayName,
      fileName,
      recordingSource,
      threadId,
      workspacePath
    }
    const scriptPath = getScriptPath(fileName)

    await writeFile(scriptPath, script, "utf8")

    try {
      await writeManifest({
        version: 1,
        entries: [nextEntry, ...manifest.entries]
      })
    } catch (error) {
      await rm(scriptPath, { force: true }).catch(() => undefined)
      throw error
    }

    return nextEntry
  })
}

export async function listBrowserScriptLibraryEntries(
  options: BrowserScriptLibraryListOptions = {}
): Promise<BrowserScriptLibraryEntry[]> {
  void options
  const manifest = await readManifest()
  const entries = [...manifest.entries].sort((a, b) => b.createdAt.localeCompare(a.createdAt))
  return Promise.all(
    entries.map(async (entry) => {
      try {
        const script = await readFile(getScriptPath(entry.fileName), "utf8")
        return {
          ...entry,
          hasVariables: extractAiRecordingVariables(script).length > 0
        }
      } catch {
        return entry
      }
    })
  )
}

export async function readBrowserScriptLibraryScript(
  input: BrowserScriptLibraryReadInput
): Promise<string> {
  const scriptPath = getScriptPath(input.fileName)
  try {
    return await readFile(scriptPath, "utf8")
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code
    if (code === "ENOENT") {
      throw new Error("脚本文件不存在，可能已被删除")
    }
    console.warn(`${BROWSER_LIBRARY_LOG_PREFIX} Failed to read script ${input.fileName}:`, error)
    throw new Error("读取脚本内容失败，请稍后重试")
  }
}

export async function updateBrowserScriptLibraryEntry(
  input: BrowserScriptLibraryUpdateInput
): Promise<void> {
  const fileName = assertSafeFileName(input.fileName)
  const script = typeof input.script === "string" ? input.script : ""
  const shouldUpdateDisplayName = input.displayName !== undefined
  const displayName = shouldUpdateDisplayName ? normalizeText(input.displayName) : undefined

  if (!script.trim()) {
    throw new Error("脚本内容不能为空")
  }
  if (shouldUpdateDisplayName && !displayName) {
    throw new Error("请输入文件中文名")
  }

  return runSerializedMutation(async () => {
    const manifest = await readManifest()
    const currentEntry = manifest.entries.find((entry) => entry.fileName === fileName)
    if (!currentEntry) {
      throw new Error("脚本文件不存在，可能已被删除")
    }

    const scriptPath = getScriptPath(fileName)
    let previousScript: string
    try {
      previousScript = await readFile(scriptPath, "utf8")
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code
      if (code === "ENOENT") {
        throw new Error("脚本文件不存在，可能已被删除")
      }
      console.warn(`${BROWSER_LIBRARY_LOG_PREFIX} Failed to read script ${fileName}:`, error)
      throw new Error("读取脚本内容失败，请稍后重试")
    }

    const nextEntry =
      displayName && displayName !== currentEntry.displayName
        ? {
            ...currentEntry,
            displayName
          }
        : currentEntry

    try {
      await writeFile(scriptPath, script, "utf8")
      if (nextEntry !== currentEntry) {
        await writeManifest({
          version: 1,
          entries: manifest.entries.map((entry) =>
            entry.fileName === fileName ? nextEntry : entry
          )
        })
      }
    } catch (error) {
      await writeFile(scriptPath, previousScript, "utf8").catch(() => undefined)
      console.warn(`${BROWSER_LIBRARY_LOG_PREFIX} Failed to update script ${fileName}:`, error)
      throw new Error("保存脚本内容失败，请稍后重试")
    }
  })
}

export async function deleteBrowserScriptLibraryEntry(
  input: BrowserScriptLibraryDeleteInput
): Promise<void> {
  const fileName = assertSafeFileName(input.fileName)

  return runSerializedMutation(async () => {
    const manifest = await readManifest()
    const nextEntries = manifest.entries.filter((entry) => entry.fileName !== fileName)

    await rm(getScriptPath(fileName), { force: true }).catch(() => undefined)
    await writeManifest({
      version: 1,
      entries: nextEntries
    })
  })
}

export function resetBrowserScriptLibraryForTests(): void {
  browserScriptLibraryMutationQueue = Promise.resolve()
  browserScriptLibraryRootOverride = null
}

export function setBrowserScriptLibraryRootForTests(root: string | null): void {
  browserScriptLibraryRootOverride = root ? resolve(root) : null
}
