import type { McpInvocationResult } from "../mcp/capability-types"
import { hasImageContent, projectImageContent } from "./image-assets"

/** Register screenshots before MCP callbacks, traces, eager tools or code_exec see the result. */
export async function projectMcpImageResult(
  threadId: string,
  result: McpInvocationResult,
  source: string,
  project: typeof projectImageContent = projectImageContent
): Promise<McpInvocationResult> {
  if (!hasImageContent(result.contentBlocks)) return result
  const contentBlocks = (await project(threadId, result.contentBlocks, source)) as unknown[]
  const text = contentBlocks
    .flatMap((item) => {
      if (!item || typeof item !== "object") return []
      const block = item as { type?: unknown; text?: unknown }
      return block.type === "text" && typeof block.text === "string" ? [block.text] : []
    })
    .join("\n")
  // Some MCP adapters stringify their entire image payload in `text`, and some
  // return the same base64 twice in raw/structuredContent. Keep a single safe
  // projection so every consumer receives the reference rather than image bytes.
  return {
    capabilityId: result.capabilityId,
    ...(result.fallbackCapabilityId ? { fallbackCapabilityId: result.fallbackCapabilityId } : {}),
    isError: result.isError,
    contentBlocks,
    text,
    raw: { content: contentBlocks, isError: result.isError }
  }
}
