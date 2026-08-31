import {
  closeSync,
  mkdirSync,
  openSync,
  readSync,
  readdirSync,
  statSync,
  writeFileSync,
  type Dirent
} from "node:fs"
import { basename, isAbsolute, join, relative, resolve } from "node:path"
import { DatabaseSync } from "node:sqlite"
import { parseFrontmatter, type MemoryType } from "../memory/manifest"
import type {
  MemoryCatalogFile,
  MemoryCatalogPageBase,
  MemoryCatalogProject,
  MemoryCatalogScanStats,
  MemoryCatalogStats,
  MemoryFileContent,
  MemoryFilesPage,
  MemoryProjectsPage
} from "../../shared/memory-catalog"
import {
  MEMORY_CATALOG_CANCELLED,
  MEMORY_CATALOG_CURSOR_EXPIRED,
  MEMORY_CATALOG_DEFAULT_PAGE_SIZE,
  MEMORY_CATALOG_MAX_ENTRIES,
  MEMORY_CATALOG_MAX_FILE_CONTENT_BYTES,
  MEMORY_CATALOG_MAX_FILE_SIZE,
  MEMORY_CATALOG_MAX_FILES,
  MEMORY_CATALOG_MAX_FRONTMATTER_BYTES,
  MEMORY_CATALOG_MAX_ITEMS,
  MEMORY_CATALOG_MAX_INDEX_BYTES,
  MEMORY_CATALOG_MAX_METADATA_BYTES,
  MEMORY_CATALOG_MAX_PAGE_SIZE,
  MEMORY_CATALOG_MAX_RESPONSE_BYTES,
  MEMORY_CATALOG_MAX_TOTAL_READ_BYTES,
  type MemoryCatalogFilesInput,
  type MemoryCatalogInput,
  type MemoryCatalogProjectsInput,
  type MemoryCatalogResult,
  type MemoryCatalogSource
} from "./protocol"

const PROJECT_METADATA_FILE = ".project.json"
const DREAM_STATE_FILE = ".dream_state.json"
const VALID_TYPES = new Set<MemoryType>(["user", "feedback", "project", "reference"])
const VALID_PROJECT_ID = /^[a-f0-9]{12}$/
const MAX_SNAPSHOTS = 8
const SNAPSHOT_TTL_MS = 2 * 60_000
const MAX_FIELD_CHARS = 8_192
const MAX_PATH_CHARS = 32_768

interface ScanContext {
  cancelFlag?: Int32Array
  stats: MemoryCatalogScanStats
  truncatedReasons: Set<string>
}

interface ProjectSnapshot {
  id: string
  kind: "projects"
  sourceKey: string
  items: MemoryCatalogProject[]
  stats: MemoryCatalogScanStats
  truncatedReasons: string[]
  expiresAt: number
}

interface FileSnapshot {
  id: string
  kind: "files"
  sourceKey: string
  items: MemoryCatalogFile[]
  memoryStats: MemoryCatalogStats
  stats: MemoryCatalogScanStats
  truncatedReasons: string[]
  expiresAt: number
}

type CatalogSnapshot = ProjectSnapshot | FileSnapshot

interface CursorPayload {
  snapshotId: string
  offset: number
}

const snapshots = new Map<string, CatalogSnapshot>()
let nextSnapshotId = 1

export class MemoryCatalogCancelledError extends Error {
  readonly code = MEMORY_CATALOG_CANCELLED

  constructor() {
    super("Memory catalog request was superseded")
    this.name = "MemoryCatalogCancelledError"
  }
}

export class MemoryCatalogCursorExpiredError extends Error {
  readonly code = MEMORY_CATALOG_CURSOR_EXPIRED

  constructor() {
    super("Memory catalog cursor expired; restart from the first page")
    this.name = "MemoryCatalogCursorExpiredError"
  }
}

function checkCancelled(context: Pick<ScanContext, "cancelFlag">): void {
  if (context.cancelFlag && Atomics.load(context.cancelFlag, 0) !== 0) {
    throw new MemoryCatalogCancelledError()
  }
}

function markTruncated(context: ScanContext, reason: string): void {
  context.truncatedReasons.add(reason)
}

function newContext(cancelFlag?: Int32Array): ScanContext {
  return {
    cancelFlag,
    stats: { scannedEntries: 0, scannedFiles: 0, readBytes: 0 },
    truncatedReasons: new Set()
  }
}

function boundedText(value: unknown, max = MAX_FIELD_CHARS): string | undefined {
  if (typeof value !== "string") return undefined
  return value.slice(0, max)
}

function recordEntry(context: ScanContext): boolean {
  checkCancelled(context)
  if (context.stats.scannedEntries >= MEMORY_CATALOG_MAX_ENTRIES) {
    markTruncated(context, "entry-count")
    return false
  }
  context.stats.scannedEntries += 1
  return true
}

function readPrefix(
  filePath: string,
  maxBytes: number,
  context: ScanContext,
  countAsFile = true
): { text: string; bytesRead: number; size: number } | null {
  checkCancelled(context)
  if (countAsFile && context.stats.scannedFiles >= MEMORY_CATALOG_MAX_FILES) {
    markTruncated(context, "file-count")
    return null
  }
  let size = 0
  try {
    const stat = statSync(filePath)
    if (!stat.isFile()) return null
    size = stat.size
  } catch {
    return null
  }
  if (countAsFile) context.stats.scannedFiles += 1
  const remaining = MEMORY_CATALOG_MAX_TOTAL_READ_BYTES - context.stats.readBytes
  if (remaining <= 0) {
    markTruncated(context, "total-read-bytes")
    return { text: "", bytesRead: 0, size }
  }
  const byteLength = Math.max(0, Math.min(size, maxBytes, remaining))
  if (byteLength === 0) return { text: "", bytesRead: 0, size }
  const buffer = Buffer.allocUnsafe(byteLength)
  let descriptor: number | null = null
  let offset = 0
  try {
    descriptor = openSync(filePath, "r")
    while (offset < byteLength) {
      checkCancelled(context)
      const read = readSync(descriptor, buffer, offset, byteLength - offset, offset)
      if (read <= 0) break
      offset += read
    }
    context.stats.readBytes += offset
    if (offset < Math.min(size, maxBytes)) markTruncated(context, "total-read-bytes")
    return { text: buffer.subarray(0, offset).toString("utf-8"), bytesRead: offset, size }
  } catch {
    return null
  } finally {
    if (descriptor !== null) {
      try {
        closeSync(descriptor)
      } catch {
        // Ignore a descriptor that became invalid during a failed read.
      }
    }
  }
}

function parseBoundedJson(
  filePath: string,
  context: ScanContext,
  oversizedReason = "project-metadata-bytes"
): Record<string, unknown> | null {
  const result = readPrefix(filePath, MEMORY_CATALOG_MAX_METADATA_BYTES, context)
  if (!result || result.size > MEMORY_CATALOG_MAX_METADATA_BYTES) {
    if (result?.size && result.size > MEMORY_CATALOG_MAX_METADATA_BYTES) {
      markTruncated(context, oversizedReason)
    }
    return null
  }
  try {
    const parsed = JSON.parse(result.text) as unknown
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null
  } catch {
    return null
  }
}

function safeEntries(dir: string, context: ScanContext): Dirent[] {
  checkCancelled(context)
  try {
    return readdirSync(dir, { withFileTypes: true })
  } catch {
    return []
  }
}

function sourceKeyForProjects(
  source: MemoryCatalogSource,
  input: MemoryCatalogProjectsInput
): string {
  return JSON.stringify([
    "projects",
    resolve(source.projectsMemoryDir),
    input.currentProject?.projectId ?? null,
    input.currentProject?.gitRoot ?? null
  ])
}

function sourceKeyForFiles(input: MemoryCatalogFilesInput): string {
  return JSON.stringify([
    "files",
    input.scope,
    resolve(input.memoryDir),
    input.projectId ?? null,
    input.gitRoot ?? null
  ])
}

function scanDirectoryStats(
  dir: string,
  context: ScanContext
): Pick<MemoryCatalogStats, "fileCount" | "totalSize" | "indexSize"> {
  let fileCount = 0
  let totalSize = 0
  let indexSize = 0
  for (const entry of safeEntries(dir, context)) {
    if (!recordEntry(context)) break
    if (!entry.isFile()) continue
    if (entry.name.endsWith(".md")) {
      if (context.stats.scannedFiles >= MEMORY_CATALOG_MAX_FILES) {
        markTruncated(context, "file-count")
        break
      }
      context.stats.scannedFiles += 1
      try {
        const stat = statSync(join(dir, entry.name))
        fileCount += 1
        totalSize += stat.size
      } catch {
        // Ignore files that disappeared during the scan.
      }
    } else if (entry.name === "index.sqlite") {
      try {
        indexSize = statSync(join(dir, entry.name)).size
      } catch {
        // Ignore files that disappeared during the scan.
      }
    }
  }
  return { fileCount, totalSize, indexSize }
}

function projectFromDirectory(
  projectId: string,
  dir: string,
  currentProjectId: string | undefined,
  context: ScanContext
): MemoryCatalogProject {
  const metadata = parseBoundedJson(join(dir, PROJECT_METADATA_FILE), context)
  const gitRoot = boundedText(metadata?.gitRoot, MAX_PATH_CHARS)
  return {
    projectId,
    displayName: (gitRoot ? basename(gitRoot.replace(/[\\/]+$/, "")) : "") || projectId,
    memoryDir: dir.slice(0, MAX_PATH_CHARS),
    ...(gitRoot ? { gitRoot } : {}),
    ...scanDirectoryStats(dir, context),
    isCurrent: projectId === currentProjectId
  }
}

function scanProjects(
  source: MemoryCatalogSource,
  input: MemoryCatalogProjectsInput,
  context: ScanContext
): ProjectSnapshot {
  mkdirSync(source.globalMemoryDir, { recursive: true })
  mkdirSync(source.projectsMemoryDir, { recursive: true })
  const items: MemoryCatalogProject[] = []
  const seen = new Set<string>()
  const current = input.currentProject

  for (const entry of safeEntries(source.projectsMemoryDir, context)) {
    if (!recordEntry(context)) break
    if (!entry.isDirectory() || !VALID_PROJECT_ID.test(entry.name)) continue
    if (items.length >= MEMORY_CATALOG_MAX_ITEMS) {
      markTruncated(context, "item-count")
      break
    }
    const dir = join(source.projectsMemoryDir, entry.name)
    items.push(projectFromDirectory(entry.name, dir, current?.projectId, context))
    seen.add(entry.name)
  }

  if (current && !seen.has(current.projectId)) {
    if (items.length >= MEMORY_CATALOG_MAX_ITEMS) {
      items.pop()
      markTruncated(context, "item-count")
    }
    items.push({
      projectId: current.projectId,
      displayName: basename(current.gitRoot.replace(/[\\/]+$/, "")) || current.projectId,
      memoryDir: current.memoryDir.slice(0, MAX_PATH_CHARS),
      gitRoot: current.gitRoot.slice(0, MAX_PATH_CHARS),
      fileCount: 0,
      totalSize: 0,
      indexSize: 0,
      isCurrent: true
    })
  }

  items.sort((a, b) => {
    if (a.isCurrent !== b.isCurrent) return a.isCurrent ? -1 : 1
    const nameOrder = a.displayName.localeCompare(b.displayName)
    return nameOrder || a.projectId.localeCompare(b.projectId)
  })
  return saveSnapshot({
    kind: "projects",
    sourceKey: sourceKeyForProjects(source, input),
    items,
    stats: { ...context.stats },
    truncatedReasons: [...context.truncatedReasons]
  })
}

function readDreamState(memoryDir: string, context: ScanContext): {
  lastRunAt: number
  sessionsSinceLastRun: number
} {
  const raw = parseBoundedJson(join(memoryDir, DREAM_STATE_FILE), context, "dream-state-bytes")
  return {
    lastRunAt: typeof raw?.lastRunAt === "number" ? raw.lastRunAt : 0,
    sessionsSinceLastRun:
      typeof raw?.sessionsSinceLastRun === "number" ? raw.sessionsSinceLastRun : 0
  }
}

function memoryFileFromEntry(
  memoryDir: string,
  entry: Dirent,
  context: ScanContext,
  recallMap: ReadonlyMap<string, number>
): MemoryCatalogFile | null {
  if (!entry.isFile() || !entry.name.endsWith(".md")) return null
  if (context.stats.scannedFiles >= MEMORY_CATALOG_MAX_FILES) {
    markTruncated(context, "file-count")
    return null
  }
  const fullPath = join(memoryDir, entry.name)
  let size = 0
  let modifiedAt = ""
  try {
    const stat = statSync(fullPath)
    if (!stat.isFile()) return null
    size = stat.size
    modifiedAt = stat.mtime.toISOString()
  } catch {
    return null
  }
  context.stats.scannedFiles += 1

  let type: MemoryType | null = null
  let displayName: string | null = null
  let description: string | null = null
  const head = readPrefix(fullPath, MEMORY_CATALOG_MAX_FRONTMATTER_BYTES, context, false)
  if (head?.text) {
    const { frontmatter } = parseFrontmatter(head.text)
    const candidate = frontmatter.type as MemoryType | undefined
    if (candidate && VALID_TYPES.has(candidate)) type = candidate
    if (frontmatter.name) displayName = frontmatter.name.slice(0, MAX_FIELD_CHARS)
    if (frontmatter.description) description = frontmatter.description.slice(0, MAX_FIELD_CHARS)
  }
  if (size > MEMORY_CATALOG_MAX_FILE_SIZE) markTruncated(context, "memory-file-size")
  return {
    name: entry.name,
    size,
    modifiedAt,
    type,
    displayName,
    description,
    recallCount: recallMap.get(fullPath) ?? 0
  }
}

function readRecallMap(
  indexPath: string,
  indexSize: number,
  context: ScanContext
): Map<string, number> {
  const recalls = new Map<string, number>()
  if (indexSize <= 0) return recalls
  if (indexSize > MEMORY_CATALOG_MAX_INDEX_BYTES) {
    markTruncated(context, "memory-index-size")
    return recalls
  }
  if (context.stats.readBytes + indexSize > MEMORY_CATALOG_MAX_TOTAL_READ_BYTES) {
    markTruncated(context, "total-read-bytes")
    return recalls
  }
  checkCancelled(context)
  let database: DatabaseSync | null = null
  try {
    database = new DatabaseSync(indexPath, { readOnly: true, timeout: 100 })
    const rows = database
      .prepare(
        `SELECT path, SUM(COALESCE(recall_count, 0)) AS total
         FROM chunks
         GROUP BY path
         LIMIT ?`
      )
      .all(MEMORY_CATALOG_MAX_ITEMS + 1) as Array<{ path?: unknown; total?: unknown }>
    context.stats.readBytes += indexSize
    if (rows.length > MEMORY_CATALOG_MAX_ITEMS) markTruncated(context, "recall-item-count")
    for (const row of rows.slice(0, MEMORY_CATALOG_MAX_ITEMS)) {
      checkCancelled(context)
      if (typeof row.path !== "string" || typeof row.total !== "number") continue
      recalls.set(row.path, Math.max(0, Math.trunc(row.total)))
    }
  } catch {
    // A missing legacy column or an index being replaced is non-critical to the catalog.
  } finally {
    try {
      database?.close()
    } catch {
      // Ignore close errors for a read-only projection.
    }
  }
  return recalls
}

function scanFiles(
  source: MemoryCatalogSource,
  input: MemoryCatalogFilesInput,
  context: ScanContext
): FileSnapshot {
  const memoryDir = resolve(input.memoryDir)
  const items: MemoryCatalogFile[] = []
  let totalSize = 0
  let indexSize = 0
  mkdirSync(memoryDir, { recursive: true })
  const memorySettings = parseBoundedJson(
    source.memorySettingsPath,
    context,
    "memory-settings-bytes"
  )
  const enabled = memorySettings?.enabled === true
  const dreamState = readDreamState(memoryDir, context)
  if (
    input.scope === "project" &&
    input.projectId &&
    VALID_PROJECT_ID.test(input.projectId) &&
    input.gitRoot
  ) {
    try {
      writeFileSync(
        join(memoryDir, PROJECT_METADATA_FILE),
        JSON.stringify(
          {
            projectId: input.projectId,
            gitRoot: input.gitRoot.slice(0, MAX_PATH_CHARS),
            updatedAt: Date.now()
          },
          null,
          2
        ),
        "utf-8"
      )
    } catch {
      // Metadata is advisory; catalog reads can continue if the directory is read-only.
    }
  }
  const entries = safeEntries(memoryDir, context)
  const indexEntry = entries.find((entry) => entry.name === "index.sqlite" && entry.isFile())
  if (indexEntry) {
    try {
      indexSize = statSync(join(memoryDir, indexEntry.name)).size
    } catch {
      // Ignore an index that disappeared during the scan.
    }
  }
  const recallMap = readRecallMap(join(memoryDir, "index.sqlite"), indexSize, context)
  for (const entry of entries) {
    if (!recordEntry(context)) break
    if (entry.name === "index.sqlite" && entry.isFile()) continue
    if (!entry.name.endsWith(".md")) continue
    if (items.length >= MEMORY_CATALOG_MAX_ITEMS) {
      markTruncated(context, "item-count")
      break
    }
    const file = memoryFileFromEntry(memoryDir, entry, context, recallMap)
    if (file) {
      items.push(file)
      totalSize += file.size
    }
  }
  items.sort((a, b) => {
    if (a.name === "MEMORY.md") return -1
    if (b.name === "MEMORY.md") return 1
    const aIsFact = a.type !== null
    const bIsFact = b.type !== null
    if (aIsFact !== bIsFact) return aIsFact ? -1 : 1
    if (aIsFact && bIsFact) return b.modifiedAt.localeCompare(a.modifiedAt)
    return b.name.localeCompare(a.name)
  })
  return saveSnapshot({
    kind: "files",
    sourceKey: sourceKeyForFiles(input),
    items,
    memoryStats: {
      fileCount: items.length,
      totalSize,
      indexSize,
      enabled,
      dreamEnabled: enabled && memorySettings?.dreamEnabled === true,
      dreamState,
      scope: input.scope,
      memoryDir,
      ...(input.projectId ? { projectId: input.projectId } : {}),
      ...(input.gitRoot ? { gitRoot: input.gitRoot } : {})
    },
    stats: { ...context.stats },
    truncatedReasons: [...context.truncatedReasons]
  })
}

function pruneSnapshots(now = Date.now()): void {
  for (const [id, snapshot] of snapshots) {
    if (snapshot.expiresAt <= now) snapshots.delete(id)
  }
  while (snapshots.size >= MAX_SNAPSHOTS) {
    const oldest = snapshots.keys().next().value as string | undefined
    if (!oldest) break
    snapshots.delete(oldest)
  }
}

function saveSnapshot<T extends Omit<CatalogSnapshot, "id" | "expiresAt">>(snapshot: T): T & {
  id: string
  expiresAt: number
} {
  pruneSnapshots()
  const stored = {
    ...snapshot,
    id: `${Date.now().toString(36)}-${nextSnapshotId++}`,
    expiresAt: Date.now() + SNAPSHOT_TTL_MS
  }
  snapshots.set(stored.id, stored as CatalogSnapshot)
  return stored
}

function encodeCursor(payload: CursorPayload): string {
  return Buffer.from(JSON.stringify(payload), "utf-8").toString("base64url")
}

function decodeCursor(cursor: string): CursorPayload {
  try {
    const parsed = JSON.parse(Buffer.from(cursor, "base64url").toString("utf-8")) as CursorPayload
    if (
      !parsed ||
      typeof parsed.snapshotId !== "string" ||
      !Number.isSafeInteger(parsed.offset) ||
      parsed.offset < 0
    ) {
      throw new Error("invalid cursor")
    }
    return parsed
  } catch {
    throw new MemoryCatalogCursorExpiredError()
  }
}

function pageLimit(limit: number | undefined): number {
  if (!Number.isFinite(limit)) return MEMORY_CATALOG_DEFAULT_PAGE_SIZE
  return Math.max(1, Math.min(MEMORY_CATALOG_MAX_PAGE_SIZE, Math.trunc(limit!)))
}

function pageBase(
  snapshot: CatalogSnapshot,
  offset: number,
  count: number
): MemoryCatalogPageBase {
  const nextOffset = offset + count
  const hasMore = nextOffset < snapshot.items.length
  return {
    ...(hasMore ? { nextCursor: encodeCursor({ snapshotId: snapshot.id, offset: nextOffset }) } : {}),
    hasMore,
    totalCount: snapshot.items.length,
    truncated: snapshot.truncatedReasons.length > 0,
    truncatedReasons: snapshot.truncatedReasons,
    scanStats: snapshot.stats
  }
}

function boundedItemsPage<T, P extends MemoryCatalogPageBase & { items: T[] }>(options: {
  snapshot: CatalogSnapshot & { items: T[] }
  offset: number
  limit: number
  build: (items: T[], base: MemoryCatalogPageBase) => P
}): P {
  const selected: T[] = []
  for (
    let index = options.offset;
    index < options.snapshot.items.length && selected.length < options.limit;
    index += 1
  ) {
    const candidate = [...selected, options.snapshot.items[index]]
    const page = options.build(
      candidate,
      pageBase(options.snapshot, options.offset, candidate.length)
    )
    if (Buffer.byteLength(JSON.stringify(page), "utf-8") > MEMORY_CATALOG_MAX_RESPONSE_BYTES) break
    selected.push(options.snapshot.items[index])
  }
  return options.build(selected, pageBase(options.snapshot, options.offset, selected.length))
}

function snapshotFromCursor<T extends CatalogSnapshot["kind"]>(
  cursor: string,
  kind: T,
  sourceKey: string
): { snapshot: Extract<CatalogSnapshot, { kind: T }>; offset: number } {
  pruneSnapshots()
  const decoded = decodeCursor(cursor)
  const snapshot = snapshots.get(decoded.snapshotId)
  if (!snapshot || snapshot.kind !== kind || snapshot.sourceKey !== sourceKey) {
    throw new MemoryCatalogCursorExpiredError()
  }
  snapshot.expiresAt = Date.now() + SNAPSHOT_TTL_MS
  return { snapshot: snapshot as Extract<CatalogSnapshot, { kind: T }>, offset: decoded.offset }
}

function projectsPage(
  source: MemoryCatalogSource,
  input: MemoryCatalogProjectsInput,
  cancelFlag?: Int32Array
): MemoryProjectsPage {
  const sourceKey = sourceKeyForProjects(source, input)
  const selected = input.cursor
    ? snapshotFromCursor(input.cursor, "projects", sourceKey)
    : { snapshot: scanProjects(source, input, newContext(cancelFlag)), offset: 0 }
  checkCancelled({ cancelFlag })
  return boundedItemsPage({
    snapshot: selected.snapshot,
    offset: selected.offset,
    limit: pageLimit(input.limit),
    build: (items, base) => ({ ...base, items })
  })
}

function filesPage(
  source: MemoryCatalogSource,
  input: MemoryCatalogFilesInput,
  cancelFlag?: Int32Array
): MemoryFilesPage {
  const sourceKey = sourceKeyForFiles(input)
  const selected = input.cursor
    ? snapshotFromCursor(input.cursor, "files", sourceKey)
    : { snapshot: scanFiles(source, input, newContext(cancelFlag)), offset: 0 }
  checkCancelled({ cancelFlag })
  return boundedItemsPage({
    snapshot: selected.snapshot,
    offset: selected.offset,
    limit: pageLimit(input.limit),
    build: (items, base) => ({ ...base, items, stats: selected.snapshot.memoryStats })
  })
}

function isSafeMemoryFile(memoryDir: string, name: string): string | null {
  if (!name || name.includes("\0") || basename(name) !== name || !name.endsWith(".md")) return null
  const root = resolve(memoryDir)
  const target = resolve(root, name)
  const rel = relative(root, target)
  return !rel || rel.startsWith("..") || isAbsolute(rel) ? null : target
}

function boundedFileContent(
  memoryDir: string,
  name: string,
  cancelFlag?: Int32Array
): MemoryFileContent {
  const context = newContext(cancelFlag)
  const filePath = isSafeMemoryFile(memoryDir, name)
  if (!filePath) return { content: "", bytesRead: 0, totalBytes: 0, truncated: false }
  let size = 0
  try {
    const stat = statSync(filePath)
    if (!stat.isFile()) return { content: "", bytesRead: 0, totalBytes: 0, truncated: false }
    size = stat.size
  } catch {
    return { content: "", bytesRead: 0, totalBytes: 0, truncated: false }
  }
  if (size > MEMORY_CATALOG_MAX_FILE_SIZE) {
    return {
      content: "",
      bytesRead: 0,
      totalBytes: size,
      truncated: true,
      truncatedReason: "file-size"
    }
  }
  const prefix = readPrefix(filePath, MEMORY_CATALOG_MAX_FILE_CONTENT_BYTES, context)
  if (!prefix) return { content: "", bytesRead: 0, totalBytes: size, truncated: false }
  let content = prefix.text
  let result: MemoryFileContent = {
    content,
    bytesRead: prefix.bytesRead,
    totalBytes: size,
    truncated: prefix.bytesRead < size,
    ...(prefix.bytesRead < size ? { truncatedReason: "response-bytes" as const } : {})
  }
  if (Buffer.byteLength(JSON.stringify(result), "utf-8") > MEMORY_CATALOG_MAX_RESPONSE_BYTES) {
    let low = 0
    let high = content.length
    while (low < high) {
      const middle = Math.ceil((low + high) / 2)
      const candidate = { ...result, content: content.slice(0, middle), truncated: true }
      if (Buffer.byteLength(JSON.stringify(candidate), "utf-8") <= MEMORY_CATALOG_MAX_RESPONSE_BYTES) {
        low = middle
      } else {
        high = middle - 1
      }
    }
    content = content.slice(0, low)
    result = {
      ...result,
      content,
      bytesRead: Buffer.byteLength(content, "utf-8"),
      truncated: true,
      truncatedReason: "response-bytes"
    }
  }
  return result
}

export function readMemoryCatalog(
  source: MemoryCatalogSource,
  input: MemoryCatalogInput,
  cancelFlag?: Int32Array
): MemoryCatalogResult {
  if (input.kind === "projects") return projectsPage(source, input, cancelFlag)
  if (input.kind === "files") return filesPage(source, input, cancelFlag)
  return boundedFileContent(input.memoryDir, input.name, cancelFlag)
}

export function clearMemoryCatalogSnapshotsForTests(): void {
  snapshots.clear()
}
