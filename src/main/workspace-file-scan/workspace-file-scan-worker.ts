import { promises as fs, type Dir, type Dirent } from "node:fs"
import path from "node:path"
import { parentPort } from "node:worker_threads"
import micromatch from "micromatch"
import {
  WORKSPACE_FILE_SCAN_SEGMENT_MAX_ACTIVE_MS,
  WORKSPACE_FILE_SCAN_SEGMENT_MAX_BYTES,
  WORKSPACE_FILE_SCAN_SEGMENT_MAX_DIRECTORIES,
  WORKSPACE_FILE_SCAN_SEGMENT_MAX_ENTRIES,
  WORKSPACE_GITIGNORE_MAX_BYTES,
  WORKSPACE_GITIGNORE_MAX_RULES,
  type WorkspaceFileScanEntry
} from "../../shared/workspace-file-scan"
import type { WorkspaceFileScanWorkerRequest, WorkspaceFileScanWorkerResponse } from "./protocol"
import { WORKSPACE_FILE_SCAN_CANCELLED } from "./protocol"

interface GitignoreRule {
  pattern: string
  negated: boolean
  directoryOnly: boolean
  anchored: boolean
  hasSlash: boolean
  matchPattern: (input: string) => boolean
  matchAnywhere?: (input: string) => boolean
  matchDescendants?: (input: string) => boolean
}

interface DirectoryFrame {
  fullPath: string
  relativePath: string
  directory: Dir | null
}

interface ScanState {
  scanId: string
  workspacePath: string
  cancellation: Int32Array
  frames: DirectoryFrame[]
  frameIndex: number
  pending: WorkspaceFileScanEntry[]
  rules: GitignoreRule[] | null
  segmentActiveMs: number
  segmentEntries: number
  segmentBytes: number
  segmentDirectories: number
  continuationSequence: number
  requiredContinuation: string | null
}

class WorkspaceFileScanCancelledError extends Error {
  constructor() {
    super("Workspace file scan was cancelled")
    this.name = WORKSPACE_FILE_SCAN_CANCELLED
  }
}

if (!parentPort) throw new Error("Workspace file scan worker requires a parent port")
const workerPort = parentPort

let state: ScanState | null = null
let requestChain = Promise.resolve()

function normalizeRelativePath(input: string): string {
  return input
    .replace(/\\/g, "/")
    .replace(/^\.\/+/, "")
    .replace(/^\/+/, "")
    .replace(/\/+/g, "/")
    .replace(/\/$/, "")
}

const MICROMATCH_OPTIONS = { dot: true, nocase: process.platform === "win32" }

function parseGitignoreRules(content: string): GitignoreRule[] {
  const rules: GitignoreRule[] = []
  for (const rawLine of content.split(/\r?\n/)) {
    const trimmed = rawLine.trim()
    if (!trimmed || trimmed.startsWith("#")) continue
    let line = trimmed
    let negated = false
    if (line.startsWith("\\#") || line.startsWith("\\!")) {
      line = line.slice(1)
    } else if (line.startsWith("!")) {
      negated = true
      line = line.slice(1).trim()
    }
    if (!line) continue
    const anchored = line.startsWith("/")
    if (anchored) line = line.slice(1)
    const directoryOnly = line.endsWith("/")
    if (directoryOnly) line = line.slice(0, -1)
    const pattern = normalizeRelativePath(line)
    if (!pattern) continue
    rules.push({
      pattern,
      negated,
      directoryOnly,
      anchored,
      hasSlash: pattern.includes("/"),
      matchPattern: micromatch.matcher(pattern, MICROMATCH_OPTIONS),
      ...(!anchored && pattern.includes("/")
        ? { matchAnywhere: micromatch.matcher(`**/${pattern}`, MICROMATCH_OPTIONS) }
        : {}),
      ...(directoryOnly && !anchored && pattern.includes("/")
        ? {
            matchDescendants: micromatch.matcher(`**/${pattern}/**`, MICROMATCH_OPTIONS)
          }
        : {})
    })
    if (rules.length >= WORKSPACE_GITIGNORE_MAX_RULES) break
  }
  return rules
}

function matchesRule(relativePath: string, rule: GitignoreRule): boolean {
  const normalizedPath = normalizeRelativePath(relativePath)
  if (!normalizedPath) return false

  if (rule.directoryOnly) {
    if (rule.hasSlash) {
      if (rule.anchored) {
        return normalizedPath === rule.pattern || normalizedPath.startsWith(`${rule.pattern}/`)
      }
      return (
        normalizedPath === rule.pattern ||
        normalizedPath.startsWith(`${rule.pattern}/`) ||
        rule.matchAnywhere?.(normalizedPath) === true ||
        rule.matchDescendants?.(normalizedPath) === true
      )
    }
    return normalizedPath
      .split("/")
      .some((segment) => rule.matchPattern(segment))
  }

  if (rule.hasSlash) {
    if (rule.anchored) {
      return rule.matchPattern(normalizedPath)
    }
    return (
      rule.matchPattern(normalizedPath) || rule.matchAnywhere?.(normalizedPath) === true
    )
  }
  return normalizedPath
    .split("/")
    .some((segment) => rule.matchPattern(segment))
}

function isIgnoredDirectory(relativePath: string, rules: readonly GitignoreRule[]): boolean {
  let ignored = false
  for (const rule of rules) {
    if (!matchesRule(relativePath, rule)) continue
    ignored = !rule.negated
  }
  return ignored
}

function throwIfCancelled(scan: ScanState): void {
  if (Atomics.load(scan.cancellation, 0) !== 0) throw new WorkspaceFileScanCancelledError()
}

async function loadRules(scan: ScanState): Promise<GitignoreRule[]> {
  if (scan.rules) return scan.rules
  let handle: Awaited<ReturnType<typeof fs.open>> | null = null
  try {
    handle = await fs.open(path.join(scan.workspacePath, ".gitignore"), "r")
    const buffer = Buffer.allocUnsafe(WORKSPACE_GITIGNORE_MAX_BYTES)
    const { bytesRead } = await handle.read(buffer, 0, buffer.byteLength, 0)
    throwIfCancelled(scan)
    let contentEnd = bytesRead
    if (bytesRead === buffer.byteLength) {
      const lastLf = buffer.lastIndexOf(0x0a, bytesRead - 1)
      contentEnd = lastLf >= 0 ? lastLf + 1 : 0
    }
    scan.rules = parseGitignoreRules(buffer.subarray(0, contentEnd).toString("utf8"))
  } catch {
    scan.rules = []
  } finally {
    await handle?.close().catch(() => undefined)
  }
  return scan.rules
}

function entryBytes(entry: WorkspaceFileScanEntry): number {
  return Buffer.byteLength(JSON.stringify(entry), "utf8") + 1
}

async function ensureFrameDirectory(scan: ScanState, frame: DirectoryFrame): Promise<boolean> {
  if (frame.directory) return true
  if (scan.segmentDirectories >= WORKSPACE_FILE_SCAN_SEGMENT_MAX_DIRECTORIES) return false
  throwIfCancelled(scan)
  frame.directory = await fs.opendir(frame.fullPath, { bufferSize: 128 })
  scan.segmentDirectories += 1
  throwIfCancelled(scan)
  return true
}

function shouldSkipEntry(
  entry: Dirent,
  relativePath: string,
  rules: readonly GitignoreRule[]
): boolean {
  if (entry.name.startsWith(".")) return true
  if (entry.isDirectory() && entry.name === "node_modules") return true
  if (entry.isDirectory() && relativePath.replace(/\\/g, "/") === "resources/bin") return true
  return entry.isDirectory() && isIgnoredDirectory(relativePath, rules)
}

function segmentTimeExceeded(scan: ScanState, requestStartedAt: number): boolean {
  return (
    scan.segmentActiveMs + performance.now() - requestStartedAt >=
    WORKSPACE_FILE_SCAN_SEGMENT_MAX_ACTIVE_MS
  )
}

async function fillPending(
  scan: ScanState,
  maxCount: number,
  requestStartedAt: number
): Promise<boolean> {
  const rules = await loadRules(scan)
  const fileCandidates: Array<{ fullPath: string; relativePath: string }> = []
  let segmentLimited = false

  while (scan.frameIndex < scan.frames.length && scan.pending.length < maxCount) {
    throwIfCancelled(scan)
    if (segmentTimeExceeded(scan, requestStartedAt)) {
      segmentLimited = true
      break
    }
    const frame = scan.frames[scan.frameIndex]
    if (!(await ensureFrameDirectory(scan, frame))) {
      segmentLimited = true
      break
    }
    const entry = await frame.directory?.read()
    throwIfCancelled(scan)
    if (!entry) {
      await frame.directory?.close().catch(() => undefined)
      frame.directory = null
      scan.frameIndex += 1
      // Drop closed traversal frames with amortized compaction. A deep tree
      // should not retain every ancestor path until the final page, while a
      // wide tree still keeps the not-yet-visited queue intact.
      if (scan.frameIndex >= 1_024 && scan.frameIndex * 2 >= scan.frames.length) {
        scan.frames.splice(0, scan.frameIndex)
        scan.frameIndex = 0
      }
      continue
    }

    const relativePath = frame.relativePath ? `${frame.relativePath}/${entry.name}` : entry.name
    if (shouldSkipEntry(entry, relativePath, rules)) continue
    const fullPath = path.join(frame.fullPath, entry.name)
    if (entry.isDirectory()) {
      scan.pending.push({ path: `/${relativePath}`, is_dir: true })
      scan.frames.push({ fullPath, relativePath, directory: null })
      continue
    }
    fileCandidates.push({ fullPath, relativePath })
    if (fileCandidates.length >= 32 || scan.pending.length + fileCandidates.length >= maxCount) {
      break
    }
  }

  if (fileCandidates.length > 0) {
    const statResults = await Promise.all(
      fileCandidates.map(async ({ fullPath, relativePath }) => {
        const stat = await fs.stat(fullPath)
        return {
          path: `/${relativePath}`,
          is_dir: false,
          size: stat.size,
          modified_at: stat.mtime.toISOString()
        } satisfies WorkspaceFileScanEntry
      })
    )
    throwIfCancelled(scan)
    scan.pending.push(...statResults)
  }
  return segmentLimited
}

async function readNextPage(
  scan: ScanState,
  maxEntries: number,
  maxBytes: number,
  continuation?: string
): Promise<{
  files: WorkspaceFileScanEntry[]
  done: boolean
  truncated: boolean
  continuation?: string
}> {
  if (scan.requiredContinuation) {
    if (continuation !== scan.requiredContinuation) {
      throw new Error("Workspace file scan continuation token is required")
    }
    scan.requiredContinuation = null
    scan.segmentActiveMs = 0
    scan.segmentEntries = 0
    scan.segmentBytes = 0
    scan.segmentDirectories = 0
  } else if (continuation) {
    throw new Error("Workspace file scan continuation token is stale")
  }
  const requestStartedAt = performance.now()
  const files: WorkspaceFileScanEntry[] = []
  let bytes = 2
  let segmentLimited = false
  try {
    while (files.length < maxEntries) {
      throwIfCancelled(scan)
      if (
        scan.segmentEntries >= WORKSPACE_FILE_SCAN_SEGMENT_MAX_ENTRIES ||
        scan.segmentBytes >= WORKSPACE_FILE_SCAN_SEGMENT_MAX_BYTES ||
        segmentTimeExceeded(scan, requestStartedAt)
      ) {
        segmentLimited = true
        break
      }
      if (scan.pending.length === 0) {
        segmentLimited = await fillPending(
          scan,
          Math.min(32, maxEntries - files.length),
          requestStartedAt
        )
        if (scan.pending.length === 0) break
      }
      const next = scan.pending[0]
      const nextBytes = entryBytes(next)
      if (nextBytes > maxBytes - 2) {
        throw new Error(`Workspace file entry exceeds page byte budget: ${next.path}`)
      }
      if (
        scan.segmentEntries + 1 > WORKSPACE_FILE_SCAN_SEGMENT_MAX_ENTRIES ||
        scan.segmentBytes + nextBytes > WORKSPACE_FILE_SCAN_SEGMENT_MAX_BYTES
      ) {
        segmentLimited = true
        break
      }
      if (files.length > 0 && bytes + nextBytes > maxBytes) break
      scan.pending.shift()
      files.push(next)
      bytes += nextBytes
      scan.segmentEntries += 1
      scan.segmentBytes += nextBytes
    }
    const done = scan.pending.length === 0 && scan.frameIndex >= scan.frames.length
    if (!done && segmentLimited) {
      const nextContinuation = `${scan.scanId}:${++scan.continuationSequence}`
      scan.requiredContinuation = nextContinuation
      return { files, done: false, truncated: true, continuation: nextContinuation }
    }
    return { files, done, truncated: false }
  } finally {
    scan.segmentActiveMs += performance.now() - requestStartedAt
  }
}

async function closeScanState(scan: ScanState | null): Promise<void> {
  if (!scan) return
  await Promise.all(
    scan.frames.map(async (frame) => {
      await frame.directory?.close().catch(() => undefined)
      frame.directory = null
    })
  )
}

function failure(
  type: "open-result" | "next-result",
  requestId: number,
  error: unknown
): WorkspaceFileScanWorkerResponse {
  const normalized = error instanceof Error ? error : new Error(String(error))
  return {
    type,
    requestId,
    ok: false,
    error: {
      code:
        normalized instanceof WorkspaceFileScanCancelledError
          ? WORKSPACE_FILE_SCAN_CANCELLED
          : "WORKSPACE_FILE_SCAN_FAILED",
      message: normalized.message,
      ...(normalized.stack ? { stack: normalized.stack } : {})
    }
  }
}

async function handleRequest(request: WorkspaceFileScanWorkerRequest): Promise<void> {
  if (request.type === "shutdown") {
    await closeScanState(state)
    state = null
    workerPort.postMessage({ type: "shutdown-complete" } satisfies WorkspaceFileScanWorkerResponse)
    return
  }
  if (request.type === "cancel") {
    if (state?.scanId === request.scanId) Atomics.store(state.cancellation, 0, 1)
    await closeScanState(state)
    state = null
    return
  }
  if (request.type === "open") {
    try {
      const workspacePath = path.resolve(request.workspacePath)
      state = {
        scanId: request.scanId,
        workspacePath,
        cancellation: new Int32Array(request.cancellationBuffer),
        frames: [{ fullPath: workspacePath, relativePath: "", directory: null }],
        frameIndex: 0,
        pending: [],
        rules: null,
        segmentActiveMs: 0,
        segmentEntries: 0,
        segmentBytes: 0,
        segmentDirectories: 0,
        continuationSequence: 0,
        requiredContinuation: null
      }
      workerPort.postMessage({
        type: "open-result",
        requestId: request.requestId,
        ok: true
      } satisfies WorkspaceFileScanWorkerResponse)
    } catch (error) {
      workerPort.postMessage(failure("open-result", request.requestId, error))
    }
    return
  }

  try {
    if (!state || state.scanId !== request.scanId) {
      throw new WorkspaceFileScanCancelledError()
    }
    const result = await readNextPage(
      state,
      request.maxEntries,
      request.maxBytes,
      request.continuation
    )
    if (result.done) {
      await closeScanState(state)
      state = null
    }
    workerPort.postMessage({
      type: "next-result",
      requestId: request.requestId,
      ok: true,
      ...result
    } satisfies WorkspaceFileScanWorkerResponse)
  } catch (error) {
    await closeScanState(state)
    state = null
    workerPort.postMessage(failure("next-result", request.requestId, error))
  }
}

workerPort.on("message", (request: WorkspaceFileScanWorkerRequest) => {
  requestChain = requestChain.then(() => handleRequest(request)).catch(() => undefined)
})
