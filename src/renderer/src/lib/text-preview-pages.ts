import type { WorkspaceFilePreviewTextResult } from "../../../shared/workspace-file-preview"

export const WEB_SOURCE_PREVIEW_MAX_BYTES = 512 * 1024
export const WEB_SOURCE_PREVIEW_MAX_PAGES = 16
const WEB_SOURCE_EXTENSIONS = new Set(["html", "htm", "js", "jsx", "mjs", "cjs"])

interface AssembleTextPreviewOptions {
  maxBytes: number
  maxPages: number
}

type ReadTextPreviewPage = (offset: number) => Promise<WorkspaceFilePreviewTextResult | null>

export function shouldAssembleWebSourcePreview(fileName: string): boolean {
  const normalizedName = fileName.toLowerCase()
  const dotIndex = normalizedName.lastIndexOf(".")
  return dotIndex >= 0 && WEB_SOURCE_EXTENSIONS.has(normalizedName.slice(dotIndex + 1))
}

function countTextLines(content: string): number {
  if (content.length === 0) return 0
  let lineBreaks = 0
  for (let index = 0; index < content.length; index += 1) {
    if (content.charCodeAt(index) === 10) lineBreaks += 1
  }
  return lineBreaks + (content.endsWith("\n") ? 0 : 1)
}

function assertSameFile(
  first: WorkspaceFilePreviewTextResult,
  next: WorkspaceFilePreviewTextResult,
  expectedOffset: number
): void {
  if (
    next.offset !== expectedOffset ||
    next.size !== first.size ||
    next.modified_at !== first.modified_at
  ) {
    throw new Error("文件在预览加载期间发生变化，请刷新后重试")
  }
}

/**
 * Assemble several bounded IPC pages without removing the per-request safety limit.
 * The returned cursor always points after the last page actually included.
 */
export async function assembleBoundedTextPreview(
  first: WorkspaceFilePreviewTextResult,
  readPage: ReadTextPreviewPage,
  options: AssembleTextPreviewOptions
): Promise<WorkspaceFilePreviewTextResult> {
  const maxBytes = Math.max(first.contentBytes, options.maxBytes)
  const maxPages = Math.max(1, options.maxPages)
  const pages = [first]
  let last = first

  while (last.hasMore && last.nextOffset !== null && pages.length < maxPages) {
    const nextOffset = last.nextOffset
    if (nextOffset <= last.offset) throw new Error("文件预览分页游标未推进")

    const next = await readPage(nextOffset)
    if (!next) break
    assertSameFile(first, next, nextOffset)

    const nextEndOffset = next.nextOffset ?? next.size
    if (nextEndOffset - first.offset > maxBytes) break
    pages.push(next)
    last = next
  }

  if (pages.length === 1) return first

  const content = pages.map((page) => page.content).join("")
  return {
    ...first,
    content,
    contentBytes: pages.reduce((total, page) => total + page.contentBytes, 0),
    nextOffset: last.nextOffset,
    hasMore: last.hasMore,
    hasPrevious: first.offset > 0,
    truncated: first.offset > 0 || last.hasMore,
    lineCount: countTextLines(content)
  }
}
