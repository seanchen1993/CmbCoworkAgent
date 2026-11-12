import { existsSync, opendirSync, statSync, type Dirent } from "node:fs"
import { isAbsolute, join, resolve } from "node:path"
import { serialize } from "node:v8"
import type { HarnessKnowledgePreviewResult } from "../../shared/harness-board-types"
import {
  HARNESS_KNOWLEDGE_PREVIEW_MAX_DEPTH,
  HARNESS_KNOWLEDGE_PREVIEW_MAX_DIRENTS,
  HARNESS_KNOWLEDGE_PREVIEW_MAX_DIRECTORIES,
  HARNESS_KNOWLEDGE_PREVIEW_MAX_DIRECTORY_ENTRIES,
  HARNESS_KNOWLEDGE_PREVIEW_MAX_FILES,
  type HarnessKnowledgeBasePreviewTarget
} from "./knowledge-preview-protocol"

const MAX_TEXT = 8_192

interface PendingDirectory {
  fullPath: string
  relativePath: string
  depth: number
}

function boundedText(value: unknown, max = MAX_TEXT): string {
  return typeof value === "string" ? value.slice(0, max) : ""
}

function throwIfCancelled(cancelFlag?: Int32Array): void {
  if (cancelFlag && Atomics.load(cancelFlag, 0) !== 0) {
    throw new DOMException("Harness knowledge preview was superseded", "AbortError")
  }
}

function formatError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error)
  return message.slice(0, 1_024)
}

function entryOrder(left: Dirent, right: Dirent): number {
  if (left.isDirectory() && !right.isDirectory()) return -1
  if (!left.isDirectory() && right.isDirectory()) return 1
  return left.name.localeCompare(right.name)
}

function appendError(existing: string | undefined, next: string): string {
  return existing ? `${existing}；${next}`.slice(0, 4_096) : next.slice(0, 4_096)
}

function boundResponse(
  result: HarnessKnowledgePreviewResult,
  maxResponseBytes: number
): HarnessKnowledgePreviewResult {
  const budget = Math.max(64 * 1024, maxResponseBytes)
  if (serialize(result).byteLength <= budget) return result

  let low = 0
  let high = result.files.length
  while (low < high) {
    const middle = Math.ceil((low + high) / 2)
    const candidate = {
      ...result,
      files: result.files.slice(0, middle),
      error: appendError(result.error, "知识库文件较多，预览结果已按传输预算截断")
    }
    if (serialize(candidate).byteLength <= budget) low = middle
    else high = middle - 1
  }
  return {
    ...result,
    files: result.files.slice(0, low),
    error: appendError(result.error, "知识库文件较多，预览结果已按传输预算截断")
  }
}

function scanKnowledgeFiles(
  rootPath: string,
  cancelFlag?: Int32Array
): Pick<HarnessKnowledgePreviewResult, "files" | "error"> {
  const files: HarnessKnowledgePreviewResult["files"] = []
  const pending: PendingDirectory[] = [{ fullPath: rootPath, relativePath: "", depth: 0 }]
  let pendingIndex = 0
  let scannedDirectories = 0
  let scannedDirents = 0
  let error: string | undefined
  let truncated = false

  while (pendingIndex < pending.length && files.length < HARNESS_KNOWLEDGE_PREVIEW_MAX_FILES) {
    throwIfCancelled(cancelFlag)
    if (scannedDirectories >= HARNESS_KNOWLEDGE_PREVIEW_MAX_DIRECTORIES) {
      truncated = true
      break
    }
    const directory = pending[pendingIndex++]!
    scannedDirectories += 1
    const entries: Dirent[] = []
    let handle: ReturnType<typeof opendirSync> | null = null
    try {
      handle = opendirSync(directory.fullPath)
      let entriesRead = 0
      while (
        entriesRead < HARNESS_KNOWLEDGE_PREVIEW_MAX_DIRECTORY_ENTRIES &&
        scannedDirents < HARNESS_KNOWLEDGE_PREVIEW_MAX_DIRENTS
      ) {
        throwIfCancelled(cancelFlag)
        const entry = handle.readSync()
        if (!entry) break
        entriesRead += 1
        scannedDirents += 1
        if (entry.name.startsWith(".") || (entry.isDirectory() && entry.name === "node_modules")) {
          continue
        }
        entries.push(entry)
      }
      if (
        entriesRead >= HARNESS_KNOWLEDGE_PREVIEW_MAX_DIRECTORY_ENTRIES ||
        scannedDirents >= HARNESS_KNOWLEDGE_PREVIEW_MAX_DIRENTS
      ) {
        truncated = true
      }
    } catch (scanError) {
      error = appendError(error, `${directory.fullPath}: ${formatError(scanError)}`)
      continue
    } finally {
      try {
        handle?.closeSync()
      } catch {
        // The directory can already be closed after reaching EOF.
      }
    }

    entries.sort(entryOrder)
    for (const entry of entries) {
      throwIfCancelled(cancelFlag)
      if (files.length >= HARNESS_KNOWLEDGE_PREVIEW_MAX_FILES) {
        truncated = true
        break
      }
      const relativePath = directory.relativePath
        ? `${directory.relativePath}/${entry.name}`
        : entry.name
      if (relativePath.length > MAX_TEXT) {
        truncated = true
        continue
      }
      const fullPath = join(directory.fullPath, entry.name)
      if (entry.isDirectory()) {
        files.push({ path: `/${relativePath}`, is_dir: true })
        if (directory.depth < HARNESS_KNOWLEDGE_PREVIEW_MAX_DEPTH) {
          pending.push({
            fullPath,
            relativePath,
            depth: directory.depth + 1
          })
        } else {
          truncated = true
        }
        continue
      }

      try {
        const stats = statSync(fullPath)
        if (!stats.isFile()) continue
        files.push({
          path: `/${relativePath}`,
          is_dir: false,
          size: stats.size,
          modified_at: stats.mtime.toISOString()
        })
      } catch (statError) {
        error = appendError(error, `${fullPath}: ${formatError(statError)}`)
      }
    }
  }

  if (pendingIndex < pending.length || files.length >= HARNESS_KNOWLEDGE_PREVIEW_MAX_FILES) {
    truncated = true
  }
  if (truncated) {
    error = appendError(error, "知识库文件较多，仅显示有界预览；请缩小知识目录后重试")
  }
  return { files, ...(error ? { error } : {}) }
}

export function readKnowledgeBasePreview(
  target: HarnessKnowledgeBasePreviewTarget,
  maxResponseBytes: number,
  cancelFlag?: Int32Array
): HarnessKnowledgePreviewResult {
  throwIfCancelled(cancelFlag)
  const idKey = boundedText(target.idKey, 512).trim()
  const name = boundedText(target.name, 1_024).trim()
  const knowledgePath = resolve(target.path)
  if (!idKey || !name || !isAbsolute(target.path)) {
    throw new Error("知识库预览目标无效")
  }
  if (!existsSync(knowledgePath)) {
    return { exists: false, path: knowledgePath, files: [] }
  }
  try {
    if (!statSync(knowledgePath).isDirectory()) {
      return {
        exists: false,
        path: knowledgePath,
        files: [],
        error: "知识库路径不是目录"
      }
    }
  } catch (error) {
    return {
      exists: false,
      path: knowledgePath,
      files: [],
      error: `无法读取知识库路径：${formatError(error)}`
    }
  }
  const scanned = scanKnowledgeFiles(knowledgePath, cancelFlag)
  throwIfCancelled(cancelFlag)
  return boundResponse(
    {
      exists: true,
      path: knowledgePath,
      files: scanned.files,
      ...(scanned.error ? { error: scanned.error } : {})
    },
    maxResponseBytes
  )
}
