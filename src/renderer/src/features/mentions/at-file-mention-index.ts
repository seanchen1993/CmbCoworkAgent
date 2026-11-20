import { isBinaryFile } from "@/lib/file-types"
import type { FileInfo } from "@/types"

export interface AtFileSuggestion {
  id: string
  displayPath: string
  workspaceFilePath: string
  filename: string
  size?: number
}

export interface WorkspaceMentionSearchPage {
  files: FileInfo[]
  continuationAvailable?: boolean
}

export interface ProgressiveWorkspaceMentionSearchResult {
  files: FileInfo[]
  suggestions: AtFileSuggestion[]
  continuationAvailable: boolean
}

interface IndexedSuggestion {
  suggestion: AtFileSuggestion
  lowerPath: string
  lowerName: string
}

const INDEX_BATCH_SIZE = 256
const SEARCH_BATCH_SIZE = 512
const MAX_PROGRESSIVE_FILE_COUNT = 50_000
const MAX_PROGRESSIVE_LOADS = 4
const indexes = new WeakMap<FileInfo[], Promise<IndexedSuggestion[]>>()
const yieldResolvers: Array<() => void> = []
let cooperativeYieldCount = 0
const yieldChannel =
  typeof MessageChannel === "undefined"
    ? null
    : (() => {
        const channel = new MessageChannel()
        channel.port1.onmessage = () => yieldResolvers.shift()?.()
        return channel
      })()

function yieldTask(): Promise<void> {
  cooperativeYieldCount += 1
  if (!yieldChannel || cooperativeYieldCount % 8 === 0) {
    return new Promise((resolve) => setTimeout(resolve, 0))
  }
  return new Promise((resolve) => {
    yieldResolvers.push(resolve)
    yieldChannel.port2.postMessage(0)
  })
}

function normalizeDisplayPath(filePath: string): string {
  return filePath.replace(/\\/g, "/").replace(/^\/+/, "")
}

function basename(displayPath: string): string {
  const parts = displayPath.split("/")
  return parts[parts.length - 1] || displayPath
}

function supported(filePath: string): boolean {
  return !isBinaryFile(basename(filePath.replace(/\\/g, "/")))
}

async function buildIndex(files: FileInfo[]): Promise<IndexedSuggestion[]> {
  const indexed: IndexedSuggestion[] = []
  for (let offset = 0; offset < files.length; offset += INDEX_BATCH_SIZE) {
    const end = Math.min(files.length, offset + INDEX_BATCH_SIZE)
    for (let index = offset; index < end; index += 1) {
      const file = files[index]
      if (file.is_dir || !supported(file.path)) continue
      const displayPath = normalizeDisplayPath(file.path)
      const filename = basename(displayPath)
      indexed.push({
        suggestion: {
          id: file.path,
          displayPath,
          workspaceFilePath: file.path.startsWith("/") ? file.path : `/${displayPath}`,
          filename,
          size: file.size
        },
        lowerPath: displayPath.toLowerCase(),
        lowerName: filename.toLowerCase()
      })
    }
    if (end < files.length) await yieldTask()
  }
  return indexed
}

function getIndex(files: FileInfo[]): Promise<IndexedSuggestion[]> {
  const existing = indexes.get(files)
  if (existing) return existing
  const pending = buildIndex(files).catch((error) => {
    if (indexes.get(files) === pending) indexes.delete(files)
    throw error
  })
  indexes.set(files, pending)
  return pending
}

function scoreSuggestion(candidate: IndexedSuggestion, query: string): number {
  if (!query) return candidate.suggestion.displayPath.length
  if (candidate.lowerPath === query) return 0
  if (candidate.lowerName === query) return 1
  if (candidate.lowerName.startsWith(query)) return 2
  if (candidate.lowerPath.startsWith(query)) return 3
  if (candidate.lowerName.includes(query)) return 4
  if (candidate.lowerPath.includes(query)) return 5
  return Number.POSITIVE_INFINITY
}

interface RankedSuggestion {
  suggestion: AtFileSuggestion
  score: number
}

function compareRanked(left: RankedSuggestion, right: RankedSuggestion): number {
  if (left.score !== right.score) return left.score - right.score
  if (left.suggestion.displayPath.length !== right.suggestion.displayPath.length) {
    return left.suggestion.displayPath.length - right.suggestion.displayPath.length
  }
  return left.suggestion.displayPath.localeCompare(right.suggestion.displayPath)
}

function insertTopSuggestion(
  top: RankedSuggestion[],
  candidate: RankedSuggestion,
  limit: number
): void {
  let low = 0
  let high = top.length
  while (low < high) {
    const middle = (low + high) >>> 1
    if (compareRanked(top[middle], candidate) <= 0) low = middle + 1
    else high = middle
  }
  if (low >= limit && top.length >= limit) return
  top.splice(low, 0, candidate)
  if (top.length > limit) top.pop()
}

function throwIfAborted(signal?: AbortSignal): void {
  if (!signal?.aborted) return
  const error = new Error("Workspace mention search was cancelled")
  error.name = "AbortError"
  throw error
}

/**
 * Builds the reusable 50k-file projection and performs top-N selection in
 * cooperative chunks. Query keystrokes never sort or traverse the full tree in
 * one renderer task.
 */
export async function searchWorkspaceMentionFiles(
  files: FileInfo[],
  rawQuery: string,
  options: { limit?: number; signal?: AbortSignal } = {}
): Promise<AtFileSuggestion[]> {
  const limit = Math.max(1, Math.min(50, Math.floor(options.limit ?? 15)))
  const query = rawQuery.toLowerCase()
  throwIfAborted(options.signal)
  const indexed = await getIndex(files)
  const top: RankedSuggestion[] = []
  for (let offset = 0; offset < indexed.length; offset += SEARCH_BATCH_SIZE) {
    throwIfAborted(options.signal)
    const end = Math.min(indexed.length, offset + SEARCH_BATCH_SIZE)
    for (let index = offset; index < end; index += 1) {
      const candidate = indexed[index]
      const score = scoreSuggestion(candidate, query)
      if (!Number.isFinite(score)) continue
      insertTopSuggestion(top, { suggestion: candidate.suggestion, score }, limit)
    }
    if (end < indexed.length) await yieldTask()
  }
  throwIfAborted(options.signal)
  return top.map((entry) => entry.suggestion)
}

/**
 * Searches the already-hydrated workspace first, then fetches a bounded number
 * of additional scan segments for a real query. Scan pages are not ordered by
 * match quality, so a full first-page result set cannot prove that a later page
 * has no exact filename/path match. This keeps a bare `@` cheap while selecting
 * the global top-N across as many as 50k retained files.
 */
export async function searchWorkspaceMentionFilesProgressively(
  initialFiles: FileInfo[],
  rawQuery: string,
  options: {
    limit?: number
    signal?: AbortSignal
    loadMore?: (signal: AbortSignal) => Promise<WorkspaceMentionSearchPage | null>
    maxAdditionalLoads?: number
    maxFileCount?: number
    onUpdate?: (result: ProgressiveWorkspaceMentionSearchResult) => void
  } = {}
): Promise<ProgressiveWorkspaceMentionSearchResult> {
  const limit = Math.max(1, Math.min(50, Math.floor(options.limit ?? 15)))
  const maxAdditionalLoads = Math.max(
    0,
    Math.min(
      MAX_PROGRESSIVE_LOADS,
      Math.floor(options.maxAdditionalLoads ?? MAX_PROGRESSIVE_LOADS)
    )
  )
  const maxFileCount = Math.max(
    initialFiles.length,
    Math.min(
      MAX_PROGRESSIVE_FILE_COUNT,
      Math.floor(options.maxFileCount ?? MAX_PROGRESSIVE_FILE_COUNT)
    )
  )
  const fallbackController = new AbortController()
  const signal = options.signal ?? fallbackController.signal
  let files = initialFiles
  let continuationAvailable = options.loadMore !== undefined
  let suggestions = await searchWorkspaceMentionFiles(files, rawQuery, { limit, signal })
  let result: ProgressiveWorkspaceMentionSearchResult = {
    files,
    suggestions,
    continuationAvailable
  }
  options.onUpdate?.(result)

  // Loading more for an empty query would enumerate a large repository merely
  // because the popover opened. Once there is a real query, however, a full
  // local top-N is not a safe stopping condition: the worker deliberately does
  // not sort scan pages, and a later segment can still contain a better match.
  if (!rawQuery || !options.loadMore) return result

  for (let loadIndex = 0; loadIndex < maxAdditionalLoads; loadIndex += 1) {
    throwIfAborted(signal)
    if (!continuationAvailable || files.length >= maxFileCount) break
    const previousFiles = files
    const page = await options.loadMore(signal)
    throwIfAborted(signal)
    if (!page) {
      continuationAvailable = false
      break
    }
    files =
      page.files.length > maxFileCount ? page.files.slice(0, maxFileCount) : page.files
    continuationAvailable =
      page.continuationAvailable === true && files.length < maxFileCount
    // A shared loader may return its current cache while another consumer is
    // settling. Do not spin on the same immutable array.
    if (files === previousFiles) break
    suggestions = await searchWorkspaceMentionFiles(files, rawQuery, { limit, signal })
    result = { files, suggestions, continuationAvailable }
    options.onUpdate?.(result)
  }

  return { files, suggestions, continuationAvailable }
}
