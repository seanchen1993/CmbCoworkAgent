import { AsyncLocalStorage } from "node:async_hooks"
import { randomUUID } from "node:crypto"
import path from "node:path"
import { getDb } from "../db"
import type { NativeSqliteAdapter, NativeSqliteValue } from "../db/native-sqlite-adapter"
import {
  EXTERNAL_FILE_READ_GRANT_TTL_MS,
  issueExternalFileReadGrant,
  revokeExternalFileReadGrantsForScopes
} from "./external-file-read-tokens"

export type TrustedToolFilePreviewOperation = "read" | "write" | "edit"

export interface TrustedToolFilePreviewContext {
  threadId: string
  toolCallId: string
  toolName: string
}

export interface TrustedToolFilePreviewSource {
  id: string
  threadId: string
  toolCallId: string
  toolName: string
  operation: TrustedToolFilePreviewOperation
  filePath: string
  updatedAt: number
}

export type TrustedToolFilePreviewAuthorizationResult =
  | { success: true; external: false; filePath: string }
  | { success: true; external: true; filePath: string; grant: string; expiresAt: number }
  | { success: false; error: string }

const TRUSTED_TOOL_FILE_PREVIEW_SOURCE_TTL_MS = 24 * 60 * 60 * 1000
const TRUSTED_TOOL_FILE_PREVIEW_MAX_SOURCES = 5_000
const TRUSTED_TOOL_FILE_PREVIEW_MAX_THREAD_GENERATIONS = 5_000
const TRUSTED_TOOL_FILE_PREVIEW_PERSISTED_PRUNE_INTERVAL_MS = 10 * 60 * 1000
const TRUSTED_TOOL_FILE_PREVIEW_MAX_THREAD_ID_LENGTH = 256
const TRUSTED_TOOL_FILE_PREVIEW_MAX_TOOL_CALL_ID_LENGTH = 1_024
const TRUSTED_TOOL_FILE_PREVIEW_MAX_PATH_LENGTH = 32_768
const FILE_TOOL_NAMES = new Set(["read_file", "write_file", "edit_file"])

interface ActiveTrustedToolFilePreviewContext extends TrustedToolFilePreviewContext {
  threadGeneration: number
}

const trustedToolFilePreviewContext = new AsyncLocalStorage<ActiveTrustedToolFilePreviewContext>()
const sourcesByToolCall = new Map<string, Map<string, TrustedToolFilePreviewSource>>()
const threadGenerations = new Map<string, number>()
let nextThreadGeneration = 0
let nextPersistedPruneAt = 0

function validIdentityPart(value: string, maxLength: number): boolean {
  return value.length > 0 && value.length <= maxLength && !value.includes("\u0000")
}

function availableDatabase(): NativeSqliteAdapter | null {
  try {
    if (typeof getDb !== "function") return null
    return getDb()
  } catch (error) {
    if (
      error instanceof Error &&
      /Database not initialized|No "getDb" export is defined/.test(error.message)
    ) {
      return null
    }
    console.warn("[ToolFilePreview] Trusted-source database is unavailable:", error)
    return null
  }
}

function toolCallKey(threadId: string, toolCallId: string): string {
  return `${threadId}\u0000${toolCallId}`
}

function currentThreadGeneration(threadId: string): number {
  const existing = threadGenerations.get(threadId)
  if (existing !== undefined) return existing
  return replaceThreadGeneration(threadId)
}

function replaceThreadGeneration(threadId: string): number {
  nextThreadGeneration += 1
  if (
    !threadGenerations.has(threadId) &&
    threadGenerations.size >= TRUSTED_TOOL_FILE_PREVIEW_MAX_THREAD_GENERATIONS
  ) {
    const oldestThreadId = threadGenerations.keys().next().value
    if (oldestThreadId) threadGenerations.delete(oldestThreadId)
  }
  threadGenerations.delete(threadId)
  threadGenerations.set(threadId, nextThreadGeneration)
  return nextThreadGeneration
}

function invalidateThreadGeneration(threadId: string): void {
  replaceThreadGeneration(threadId)
}

function filePathKey(filePath: string): string {
  const normalized = path.resolve(filePath)
  return process.platform === "win32" ? normalized.toLowerCase() : normalized
}

function isPathInside(parent: string, child: string): boolean {
  const relative = path.relative(parent, child)
  return (
    relative === "" ||
    (relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative))
  )
}

function sourceCount(): number {
  let count = 0
  for (const sources of sourcesByToolCall.values()) count += sources.size
  return count
}

function valueAt(
  columns: string[],
  row: NativeSqliteValue[],
  column: string
): NativeSqliteValue | undefined {
  const index = columns.indexOf(column)
  return index < 0 ? undefined : row[index]
}

function parsePersistedSource(
  columns: string[],
  row: NativeSqliteValue[]
): TrustedToolFilePreviewSource | null {
  const id = valueAt(columns, row, "source_id")
  const threadId = valueAt(columns, row, "thread_id")
  const toolCallId = valueAt(columns, row, "tool_call_id")
  const toolName = valueAt(columns, row, "tool_name")
  const operation = valueAt(columns, row, "operation")
  const filePath = valueAt(columns, row, "file_path")
  const updatedAt = valueAt(columns, row, "updated_at")
  if (
    typeof id !== "string" ||
    !validIdentityPart(id, 128) ||
    typeof threadId !== "string" ||
    !validIdentityPart(threadId, TRUSTED_TOOL_FILE_PREVIEW_MAX_THREAD_ID_LENGTH) ||
    typeof toolCallId !== "string" ||
    !validIdentityPart(toolCallId, TRUSTED_TOOL_FILE_PREVIEW_MAX_TOOL_CALL_ID_LENGTH) ||
    typeof toolName !== "string" ||
    !FILE_TOOL_NAMES.has(toolName) ||
    (operation !== "read" && operation !== "write" && operation !== "edit") ||
    toolName !== `${operation}_file` ||
    typeof filePath !== "string" ||
    !path.isAbsolute(filePath) ||
    filePath.includes("\u0000") ||
    filePath.length > TRUSTED_TOOL_FILE_PREVIEW_MAX_PATH_LENGTH ||
    typeof updatedAt !== "number" ||
    !Number.isSafeInteger(updatedAt)
  ) {
    return null
  }
  return { id, threadId, toolCallId, toolName, operation, filePath, updatedAt }
}

function trustedSourceThreadExists(threadId: string): boolean | null {
  const database = availableDatabase()
  if (!database) return null
  try {
    return Boolean(
      database.exec("SELECT 1 FROM threads WHERE thread_id = ? LIMIT 1", [threadId])[0]?.values
        .length
    )
  } catch (error) {
    console.warn("[ToolFilePreview] Failed to validate trusted-source thread:", error)
    return false
  }
}

function prunePersistedSources(database: NativeSqliteAdapter, now: number): void {
  if (now < nextPersistedPruneAt) return
  database.run("DELETE FROM trusted_tool_file_preview_sources WHERE updated_at < ?", [
    now - TRUSTED_TOOL_FILE_PREVIEW_SOURCE_TTL_MS
  ])
  database.run(
    `DELETE FROM trusted_tool_file_preview_sources
     WHERE rowid IN (
       SELECT rowid FROM trusted_tool_file_preview_sources
       ORDER BY updated_at DESC
       LIMIT -1 OFFSET ?
     )`,
    [TRUSTED_TOOL_FILE_PREVIEW_MAX_SOURCES]
  )
  nextPersistedPruneAt = now + TRUSTED_TOOL_FILE_PREVIEW_PERSISTED_PRUNE_INTERVAL_MS
}

function persistTrustedToolFilePreviewSource(source: TrustedToolFilePreviewSource): void {
  const database = availableDatabase()
  if (!database) return
  try {
    database.run(
      `INSERT INTO trusted_tool_file_preview_sources (
         thread_id, tool_call_id, file_path_key, source_id,
         tool_name, operation, file_path, updated_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(thread_id, tool_call_id, file_path_key) DO UPDATE SET
         source_id = excluded.source_id,
         tool_name = excluded.tool_name,
         operation = excluded.operation,
         file_path = excluded.file_path,
         updated_at = excluded.updated_at`,
      [
        source.threadId,
        source.toolCallId,
        filePathKey(source.filePath),
        source.id,
        source.toolName,
        source.operation,
        source.filePath,
        source.updatedAt
      ]
    )
    prunePersistedSources(database, source.updatedAt)
  } catch (error) {
    console.warn("[ToolFilePreview] Failed to persist trusted source:", error)
  }
}

function readPersistedSources(
  threadId: string,
  toolCallId: string,
  now: number
): TrustedToolFilePreviewSource[] | null {
  const database = availableDatabase()
  if (!database) return []
  try {
    prunePersistedSources(database, now)
    const result = database.exec(
      `SELECT thread_id, tool_call_id, source_id, tool_name, operation, file_path, updated_at
       FROM trusted_tool_file_preview_sources
       WHERE thread_id = ? AND tool_call_id = ? AND updated_at >= ?
       ORDER BY updated_at DESC
       LIMIT 2`,
      [threadId, toolCallId, now - TRUSTED_TOOL_FILE_PREVIEW_SOURCE_TTL_MS]
    )[0]
    if (!result) return []
    const sources: TrustedToolFilePreviewSource[] = []
    for (const row of result.values) {
      const source = parsePersistedSource(result.columns, row)
      if (!source) return null
      sources.push(source)
    }
    return sources
  } catch (error) {
    console.warn("[ToolFilePreview] Failed to restore trusted source:", error)
    return []
  }
}

function pruneTrustedToolFilePreviewSources(now = Date.now()): void {
  for (const [key, sources] of sourcesByToolCall) {
    for (const [pathKey, source] of sources) {
      if (now - source.updatedAt > TRUSTED_TOOL_FILE_PREVIEW_SOURCE_TTL_MS) {
        sources.delete(pathKey)
      }
    }
    if (sources.size === 0) sourcesByToolCall.delete(key)
  }

  let excess = sourceCount() - TRUSTED_TOOL_FILE_PREVIEW_MAX_SOURCES
  if (excess <= 0) return
  const oldest = Array.from(sourcesByToolCall.entries())
    .flatMap(([key, sources]) =>
      Array.from(sources.entries()).map(([pathKey, source]) => ({ key, pathKey, source }))
    )
    .sort((left, right) => left.source.updatedAt - right.source.updatedAt)
  for (const entry of oldest) {
    if (excess <= 0) break
    const sources = sourcesByToolCall.get(entry.key)
    sources?.delete(entry.pathKey)
    if (sources?.size === 0) sourcesByToolCall.delete(entry.key)
    excess -= 1
  }
}

const cleanupTimer = setInterval(pruneTrustedToolFilePreviewSources, 10 * 60 * 1000)
cleanupTimer.unref()

export function runWithTrustedToolFilePreviewContext<T>(
  context: TrustedToolFilePreviewContext,
  callback: () => T
): T {
  if (
    !validIdentityPart(context.threadId, TRUSTED_TOOL_FILE_PREVIEW_MAX_THREAD_ID_LENGTH) ||
    !validIdentityPart(context.toolCallId, TRUSTED_TOOL_FILE_PREVIEW_MAX_TOOL_CALL_ID_LENGTH) ||
    !FILE_TOOL_NAMES.has(context.toolName)
  ) {
    return callback()
  }
  return trustedToolFilePreviewContext.run(
    { ...context, threadGeneration: currentThreadGeneration(context.threadId) },
    callback
  )
}

/**
 * Record the actual resolved path reached by a successful file tool. The
 * renderer never writes this registry and cannot turn an arbitrary path into a
 * preview capability.
 */
export function recordTrustedToolFilePreviewSource(
  filePath: string,
  operation: TrustedToolFilePreviewOperation
): void {
  const context = trustedToolFilePreviewContext.getStore()
  if (
    !context ||
    context.threadGeneration !== currentThreadGeneration(context.threadId) ||
    !path.isAbsolute(filePath) ||
    filePath.length > TRUSTED_TOOL_FILE_PREVIEW_MAX_PATH_LENGTH
  ) {
    return
  }

  const expectedToolName = `${operation}_file`
  if (context.toolName !== expectedToolName) return

  pruneTrustedToolFilePreviewSources()
  const resolvedPath = path.resolve(filePath)
  const key = toolCallKey(context.threadId, context.toolCallId)
  let sources = sourcesByToolCall.get(key)
  if (!sources) {
    sources = new Map()
    sourcesByToolCall.set(key, sources)
  }
  const normalizedPathKey = filePathKey(resolvedPath)
  const existing = sources.get(normalizedPathKey)
  const source = {
    id: existing?.id ?? randomUUID(),
    threadId: context.threadId,
    toolCallId: context.toolCallId,
    toolName: context.toolName,
    operation,
    filePath: resolvedPath,
    updatedAt: Date.now()
  } satisfies TrustedToolFilePreviewSource
  sources.set(normalizedPathKey, source)
  persistTrustedToolFilePreviewSource(source)
  pruneTrustedToolFilePreviewSources()
}

export function resolveTrustedToolFilePreviewSource(
  threadId: string,
  toolCallId: string
): TrustedToolFilePreviewSource | null {
  if (
    !validIdentityPart(threadId, TRUSTED_TOOL_FILE_PREVIEW_MAX_THREAD_ID_LENGTH) ||
    !validIdentityPart(toolCallId, TRUSTED_TOOL_FILE_PREVIEW_MAX_TOOL_CALL_ID_LENGTH)
  ) {
    return null
  }
  const now = Date.now()
  pruneTrustedToolFilePreviewSources(now)
  const key = toolCallKey(threadId, toolCallId)
  if (trustedSourceThreadExists(threadId) === false) {
    sourcesByToolCall.delete(key)
    return null
  }
  let sources = sourcesByToolCall.get(key)
  if (!sources) {
    const persisted = readPersistedSources(threadId, toolCallId, now)
    if (persisted && persisted.length > 0) {
      sources = new Map(persisted.map((source) => [filePathKey(source.filePath), source]))
      sourcesByToolCall.set(key, sources)
    }
  }
  if (!sources || sources.size !== 1) return null
  return sources.values().next().value ?? null
}

export function issueTrustedToolFilePreviewGrant(
  threadId: string,
  toolCallId: string,
  senderId: number
):
  | { success: true; external: true; filePath: string; grant: string; expiresAt: number }
  | { success: false; error: string } {
  const source = resolveTrustedToolFilePreviewSource(threadId, toolCallId)
  if (!source) {
    return {
      success: false,
      error: "Trusted tool file preview source is unavailable or ambiguous"
    }
  }

  const issuedAt = Date.now()
  const issued = issueExternalFileReadGrant(
    path.dirname(source.filePath),
    senderId,
    [path.basename(source.filePath)],
    `tool-file-preview:${source.id}`
  )
  if ("error" in issued) return { success: false, error: issued.error }
  return {
    success: true,
    external: true,
    filePath: source.filePath,
    grant: issued.grant,
    expiresAt: issuedAt + EXTERNAL_FILE_READ_GRANT_TTL_MS
  }
}

export function authorizeTrustedToolFilePreview(
  threadId: string,
  toolCallId: string,
  senderId: number,
  workspacePath: string | null
): TrustedToolFilePreviewAuthorizationResult {
  const source = resolveTrustedToolFilePreviewSource(threadId, toolCallId)
  if (!source) {
    return {
      success: false,
      error: "Trusted tool file preview source is unavailable or ambiguous"
    }
  }

  if (
    workspacePath &&
    path.isAbsolute(workspacePath) &&
    isPathInside(path.resolve(workspacePath), source.filePath)
  ) {
    return { success: true, external: false, filePath: source.filePath }
  }
  return issueTrustedToolFilePreviewGrant(threadId, toolCallId, senderId)
}

export function collectTrustedToolFilePreviewScopeKeysForThread(
  threadId: string
): Set<string> {
  const prefix = `${threadId}\u0000`
  const scopeKeys = new Set<string>()
  for (const [key, sources] of sourcesByToolCall) {
    if (!key.startsWith(prefix)) continue
    for (const source of sources.values()) scopeKeys.add(`tool-file-preview:${source.id}`)
  }
  const database = availableDatabase()
  if (database) {
    try {
      const result = database.exec(
        "SELECT source_id FROM trusted_tool_file_preview_sources WHERE thread_id = ?",
        [threadId]
      )[0]
      if (result) {
        const sourceIdIndex = result.columns.indexOf("source_id")
        if (sourceIdIndex >= 0) {
          for (const row of result.values) {
            const sourceId = row[sourceIdIndex]
            if (typeof sourceId === "string" && validIdentityPart(sourceId, 128)) {
              scopeKeys.add(`tool-file-preview:${sourceId}`)
            }
          }
        }
      }
    } catch (error) {
      console.warn("[ToolFilePreview] Failed to collect trusted sources for thread:", error)
    }
  }
  return scopeKeys
}

/**
 * Complete thread teardown after the durable delete succeeds. Callers that
 * delete the DB row first must capture scope keys before that delete and pass
 * them here so already-issued grants cannot outlive an evicted source row.
 */
export function clearTrustedToolFilePreviewSourcesForThread(
  threadId: string,
  capturedScopeKeys?: ReadonlySet<string>
): void {
  const scopeKeys = collectTrustedToolFilePreviewScopeKeysForThread(threadId)
  if (capturedScopeKeys) {
    for (const scopeKey of capturedScopeKeys) scopeKeys.add(scopeKey)
  }
  invalidateThreadGeneration(threadId)
  const prefix = `${threadId}\u0000`
  for (const key of sourcesByToolCall.keys()) {
    if (key.startsWith(prefix)) sourcesByToolCall.delete(key)
  }
  const database = availableDatabase()
  try {
    database?.run("DELETE FROM trusted_tool_file_preview_sources WHERE thread_id = ?", [threadId])
  } catch (error) {
    console.warn("[ToolFilePreview] Failed to clear trusted sources for thread:", error)
  }
  revokeExternalFileReadGrantsForScopes(scopeKeys)
}

export function clearTrustedToolFilePreviewSourcesForTests(): void {
  sourcesByToolCall.clear()
  threadGenerations.clear()
  nextThreadGeneration = 0
  nextPersistedPruneAt = 0
  const database = availableDatabase()
  database?.run("DELETE FROM trusted_tool_file_preview_sources")
}

export function clearTrustedToolFilePreviewMemoryForTests(): void {
  sourcesByToolCall.clear()
}
