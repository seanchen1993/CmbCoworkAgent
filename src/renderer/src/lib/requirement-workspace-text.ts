import { assembleBoundedTextPreview } from "./text-preview-pages"
import type { WorkspaceFilePreviewReadResult } from "../../../shared/workspace-file-preview"

const REQUIREMENT_WORKSPACE_PREVIEW_MAX_BYTES = 8 * 1024 * 1024
const REQUIREMENT_WORKSPACE_PREVIEW_MAX_PAGES = 64

export async function readRequirementWorkspaceTextFile(
  threadId: string,
  filePath: string,
  options: {
    lanePrefix: string
    workspacePathKind?: "absolute" | "relative" | "auto"
  }
): Promise<{ success: boolean; content?: string; notFound?: boolean; error?: string }> {
  const requestToken = globalThis.crypto.randomUUID()
  const lane = `${options.lanePrefix}:${threadId}:${requestToken}`
  const workspacePathKind =
    options.workspacePathKind === "auto"
      ? /^(?:[a-zA-Z]:[\\/]|[/\\]{2}|\/)/.test(filePath)
        ? "absolute"
        : "relative"
      : (options.workspacePathKind ?? "relative")
  const readPage = (offset: number): Promise<WorkspaceFilePreviewReadResult> =>
    window.api.workspace.readFilePreview({
      source: { threadId, filePath, workspacePathKind },
      offset,
      lane,
      requestToken
    })

  const first = await readPage(0)
  if (!first.success) {
    return { success: false, error: first.error, notFound: first.errorCode === "not-found" }
  }
  const assembled = await assembleBoundedTextPreview(
    first,
    async (offset) => {
      const page = await readPage(offset)
      return page.success ? page : null
    },
    {
      maxBytes: REQUIREMENT_WORKSPACE_PREVIEW_MAX_BYTES,
      maxPages: REQUIREMENT_WORKSPACE_PREVIEW_MAX_PAGES
    }
  )
  return { success: true, content: assembled.content }
}
