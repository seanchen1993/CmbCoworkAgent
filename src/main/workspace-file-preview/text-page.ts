import {
  WORKSPACE_FILE_PREVIEW_MAX_TEXT_BYTES,
  WORKSPACE_FILE_PREVIEW_MAX_TEXT_LINES,
  type WorkspaceFilePreviewTextResult
} from "../../shared/workspace-file-preview"

export type WorkspacePreviewTextPage = Pick<
  WorkspaceFilePreviewTextResult,
  "content" | "contentBytes" | "lineCount" | "nextOffset" | "hasMore" | "hasPrevious" | "truncated"
> & { consumedBytes: number }

function utf8SafePrefixLength(buffer: Buffer, length: number): number {
  if (length === 0) return 0
  let leadIndex = length - 1
  while (leadIndex >= 0 && (buffer[leadIndex] & 0xc0) === 0x80) leadIndex -= 1
  // Consume an all-continuation page so malformed input cannot stall its cursor.
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
): {
  end: number
  lineCount: number
} {
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
    end = safeEnd > 0 ? safeEnd : Math.min(1, bytesRead)
  }
  const lineCount = end === 0 ? 0 : lineBreaks + (buffer[end - 1] === 0x0a ? 0 : 1)
  return { end, lineCount }
}

function decodeBoundedUtf8(buffer: Buffer): { content: string; contentBytes: number } {
  const decoded = buffer.toString("utf8")
  const decodedBytes = Buffer.byteLength(decoded, "utf8")
  if (decodedBytes <= WORKSPACE_FILE_PREVIEW_MAX_TEXT_BYTES)
    return { content: decoded, contentBytes: decodedBytes }

  const encoded = Buffer.from(decoded, "utf8")
  const boundedEnd = utf8SafePrefixLength(encoded, WORKSPACE_FILE_PREVIEW_MAX_TEXT_BYTES)
  const content = encoded.subarray(0, boundedEnd).toString("utf8")
  return { content, contentBytes: Buffer.byteLength(content, "utf8") }
}

/** Project already-read bytes. Opening, permission, cancellation and closing belong to the caller. */
export function projectWorkspacePreviewTextPage(
  buffer: Buffer,
  bytesRead: number,
  offset: number,
  size: number
): WorkspacePreviewTextPage {
  const { end, lineCount } = boundedTextEnd(buffer, bytesRead, offset + bytesRead < size)
  const nextOffset = offset + end
  const hasMore = nextOffset < size
  const { content, contentBytes } = decodeBoundedUtf8(buffer.subarray(0, end))
  return {
    content,
    contentBytes,
    consumedBytes: end,
    lineCount,
    nextOffset: hasMore ? nextOffset : null,
    hasMore,
    hasPrevious: offset > 0,
    truncated: offset > 0 || hasMore
  }
}
