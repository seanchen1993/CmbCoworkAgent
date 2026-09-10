import path from "node:path"
import {
  WORKSPACE_FILE_PREVIEW_CANCELLED,
  WORKSPACE_FILE_PREVIEW_MAX_TEXT_BYTES,
  WORKSPACE_FILE_PREVIEW_MAX_TEXT_LINES,
  type WorkspaceFilePreviewWorkspacePathKind,
  type WorkspaceFilePreviewTextResult
} from "../../shared/workspace-file-preview"
import type { WorkspaceFilePreviewWorkerSource } from "./protocol"
import { openStableFileHandle, type StableFileHandle } from "../services/stable-file-handle"

export interface ResolvedPreviewFile {
  resolvedPath: string
  size: number
  modified_at: string
}

function cancellationError(): Error {
  const error = new Error("Workspace file preview was cancelled")
  error.name = WORKSPACE_FILE_PREVIEW_CANCELLED
  return error
}

function throwIfCancelled(cancellation: Int32Array): void {
  if (Atomics.load(cancellation, 0) !== 0) throw cancellationError()
}

export interface WorkspacePreviewPathResolver {
  resolve(...paths: string[]): string
  relative(from: string, to: string): string
  isAbsolute(filePath: string): boolean
}

function isPathInside(
  parent: string,
  child: string,
  pathResolver: WorkspacePreviewPathResolver = path
): boolean {
  const relative = pathResolver.relative(parent, child)
  return relative === "" || (!relative.startsWith("..") && !pathResolver.isAbsolute(relative))
}

/**
 * Resolve a renderer workspace path using the authoritative main-process root.
 * `auto` first accepts a genuine in-root absolute path; otherwise a leading
 * slash is treated as the file-tree's workspace-relative convention. The final
 * boundary check applies to every branch, including paths containing `..`.
 */
export function resolveWorkspacePreviewCandidate(
  filePath: string,
  workspacePath: string,
  workspacePathKind: WorkspaceFilePreviewWorkspacePathKind,
  pathResolver: WorkspacePreviewPathResolver = path
): { root: string; candidate: string } {
  const root = pathResolver.resolve(workspacePath)
  const relativePath = filePath.replace(/^[/\\]+/, "")
  const relativeCandidate = (): string => pathResolver.resolve(root, relativePath)
  let candidate: string

  if (workspacePathKind === "absolute") {
    if (!pathResolver.isAbsolute(filePath)) {
      throw new Error("Access denied: absolute workspace preview path required")
    }
    candidate = pathResolver.resolve(filePath)
  } else if (workspacePathKind === "auto" && pathResolver.isAbsolute(filePath)) {
    const absoluteCandidate = pathResolver.resolve(filePath)
    candidate = isPathInside(root, absoluteCandidate, pathResolver)
      ? absoluteCandidate
      : relativeCandidate()
  } else {
    candidate = relativeCandidate()
  }

  if (!isPathInside(root, candidate, pathResolver)) {
    throw new Error("Access denied: path outside workspace")
  }
  return { root, candidate }
}

const SENSITIVE_EXTERNAL_PATHS = [
  /[/\\]\.ssh(?:[/\\]|$)/i,
  /[/\\]\.aws(?:[/\\]|$)/i,
  /[/\\]\.gnupg(?:[/\\]|$)/i,
  /[/\\]\.kube[/\\]config$/i,
  /[/\\]\.docker[/\\]config\.json$/i,
  /[/\\]\.env(?:\..+)?$/i,
  /[/\\](?:id_rsa|id_ed25519|id_ecdsa|\.git-credentials|\.netrc|\.pgpass|\.pypirc)$/i,
  /[/\\](?:\.bash_history|\.zsh_history|\.zhistory|\.mysql_history|\.psql_history)$/i,
  /^[/\\]etc[/\\](?:passwd|shadow|sudoers|crontab)$/i,
  /[/\\]Library[/\\]Keychains[/\\]/i
]

function assertExternalPathAllowed(filePath: string): void {
  if (!path.isAbsolute(filePath)) throw new Error("External preview path must be absolute")
  if (SENSITIVE_EXTERNAL_PATHS.some((pattern) => pattern.test(filePath))) {
    throw new Error("Access denied: path is protected")
  }
}

export async function resolvePreviewFile(
  source: WorkspaceFilePreviewWorkerSource,
  workspacePath: string | undefined,
  cancellation: Int32Array
): Promise<ResolvedPreviewFile> {
  const file = await openPreviewFile(source, workspacePath, cancellation)
  try {
    return {
      resolvedPath: file.filePath,
      size: file.size,
      modified_at: file.modified_at
    }
  } finally {
    await file.handle.close().catch(() => undefined)
  }
}

async function openPreviewFile(
  source: WorkspaceFilePreviewWorkerSource,
  workspacePath: string | undefined,
  cancellation: Int32Array
): Promise<StableFileHandle> {
  throwIfCancelled(cancellation)
  let candidate: string
  let trustedRootPath: string

  if ("externalFullPath" in source) {
    assertExternalPathAllowed(source.externalFullPath)
    assertExternalPathAllowed(source.trustedRootPath)
    candidate = path.resolve(source.externalFullPath)
    trustedRootPath = path.resolve(source.trustedRootPath)
  } else {
    if (!workspacePath) throw new Error("No workspace folder linked")
    const resolved = resolveWorkspacePreviewCandidate(
      source.filePath,
      workspacePath,
      source.workspacePathKind
    )
    candidate = resolved.candidate
    trustedRootPath = resolved.root
  }

  const file = await openStableFileHandle(trustedRootPath, candidate)
  try {
    throwIfCancelled(cancellation)
    if ("externalFullPath" in source) assertExternalPathAllowed(file.filePath)
    return file
  } catch (error) {
    await file.handle.close().catch(() => undefined)
    throw error
  }
}

async function closeStableFile(file: StableFileHandle): Promise<void> {
  await file.handle.close().catch(() => undefined)
}

function ensurePreviewOffset(offset: number, size: number): void {
  if (!Number.isSafeInteger(offset) || offset < 0 || offset > size) {
    throw new Error("Invalid file preview offset")
  }
}

function utf8SafePrefixLength(buffer: Buffer, length: number): number {
  if (length === 0) return 0
  let leadIndex = length - 1
  while (leadIndex >= 0 && (buffer[leadIndex] & 0xc0) === 0x80) leadIndex -= 1
  // A page made entirely of malformed continuation bytes has no valid codepoint
  // boundary to preserve. Consume it as a bounded replacement-decoded page so
  // the cursor still advances by the full I/O budget.
  if (leadIndex < 0) return length

  const lead = buffer[leadIndex]
  let expectedLength = 1
  if ((lead & 0xe0) === 0xc0) expectedLength = 2
  else if ((lead & 0xf0) === 0xe0) expectedLength = 3
  else if ((lead & 0xf8) === 0xf0) expectedLength = 4

  return length - leadIndex < expectedLength ? leadIndex : length
}

function boundedTextEnd(
  buffer: Buffer,
  bytesRead: number,
  trimIncompleteUtf8: boolean
): { end: number; lineCount: number } {
  let lineBreaks = 0
  let end = bytesRead
  for (let index = 0; index < bytesRead; index += 1) {
    if (buffer[index] !== 0x0a) continue
    lineBreaks += 1
    if (lineBreaks >= WORKSPACE_FILE_PREVIEW_MAX_TEXT_LINES) {
      end = index + 1
      break
    }
  }
  if (end === bytesRead && trimIncompleteUtf8) {
    const safeEnd = utf8SafePrefixLength(buffer, end)
    // Malformed data must still advance the cursor; otherwise an all-continuation
    // page could expose an infinite "next page" loop.
    end = safeEnd > 0 ? safeEnd : Math.min(1, bytesRead)
  }
  const lineCount = end === 0 ? 0 : lineBreaks + (buffer[end - 1] === 0x0a ? 0 : 1)
  return { end, lineCount }
}

function decodeBoundedUtf8(buffer: Buffer): { content: string; contentBytes: number } {
  const decoded = buffer.toString("utf8")
  const decodedBytes = Buffer.byteLength(decoded, "utf8")
  if (decodedBytes <= WORKSPACE_FILE_PREVIEW_MAX_TEXT_BYTES) {
    return { content: decoded, contentBytes: decodedBytes }
  }
  const encoded = Buffer.from(decoded, "utf8")
  const boundedEnd = utf8SafePrefixLength(encoded, WORKSPACE_FILE_PREVIEW_MAX_TEXT_BYTES)
  const content = encoded.subarray(0, boundedEnd).toString("utf8")
  return { content, contentBytes: Buffer.byteLength(content, "utf8") }
}

export async function readPreviewTextPage(
  source: WorkspaceFilePreviewWorkerSource,
  workspacePath: string | undefined,
  offset: number,
  cancellation: Int32Array
): Promise<{ result: WorkspaceFilePreviewTextResult; resolvedPath: string }> {
  const file = await openPreviewFile(source, workspacePath, cancellation)
  try {
    ensurePreviewOffset(offset, file.size)
    throwIfCancelled(cancellation)
    const remaining = Math.max(0, file.size - offset)
    const readBudget = Math.min(WORKSPACE_FILE_PREVIEW_MAX_TEXT_BYTES, remaining)
    const buffer = Buffer.allocUnsafe(readBudget)
    const { bytesRead } =
      readBudget === 0 ? { bytesRead: 0 } : await file.handle.read(buffer, 0, readBudget, offset)
    throwIfCancelled(cancellation)

    const { end, lineCount } = boundedTextEnd(buffer, bytesRead, offset + bytesRead < file.size)
    const consumedBytes = end
    const nextOffset = offset + consumedBytes
    const hasMore = nextOffset < file.size
    const { content, contentBytes } = decodeBoundedUtf8(buffer.subarray(0, end))

    return {
      resolvedPath: file.filePath,
      result: {
        success: true,
        content,
        contentBytes,
        size: file.size,
        modified_at: file.modified_at,
        offset,
        nextOffset: hasMore ? nextOffset : null,
        hasMore,
        hasPrevious: offset > 0,
        truncated: offset > 0 || hasMore,
        lineCount
      }
    }
  } finally {
    await closeStableFile(file)
  }
}
