import type { McpInvocationResult } from "../mcp/capability-types"
import { getUsefulMcpResultData, projectMcpResultData } from "../mcp/result-utils"
import type { BotRuntimeRequest } from "./host"
import type { BotArtifacts } from "./artifacts"

/** Keep Hook feedback outside the provider's structured data. SDK callers receive
 * the original MCP content blocks and status, plus a separate text block. */
export function appendBotMcpHookFeedback(serialized: string, feedback: string): string {
  if (!feedback) return serialized
  const rejected = `${serialized}\n\n${feedback}`
  try {
    const value: unknown = JSON.parse(serialized)
    if (!value || typeof value !== "object" || Array.isArray(value)) return rejected
    const result = value as Record<string, unknown>
    if (
      typeof result.capabilityId !== "string" ||
      typeof result.isError !== "boolean" ||
      typeof result.text !== "string" ||
      !result.raw ||
      typeof result.raw !== "object" ||
      Array.isArray(result.raw)
    )
      return rejected
    const raw = result.raw as Record<string, unknown>
    if (raw.content !== undefined && !Array.isArray(raw.content)) return rejected
    const block = { type: "text", text: feedback }
    return JSON.stringify({
      ...result,
      text: [result.text, feedback].filter(Boolean).join("\n\n"),
      ...(Array.isArray(result.contentBlocks)
        ? { contentBlocks: [...result.contentBlocks, block] }
        : {}),
      raw: { ...raw, content: [...(Array.isArray(raw.content) ? raw.content : []), block] }
    })
  } catch {
    // A rejected/replaced result must stay on the SDK's explicit failure path.
    return rejected
  }
}

/** Results must have passed publication policy before entering this function. */
export async function serializeBotMcpResult(
  result: McpInvocationResult,
  context: {
    request: BotRuntimeRequest
    invocation: string
    name: string
    channel: "model" | "sdk" | "resource"
    files?: BotArtifacts
  }
): Promise<string> {
  const {
    request: { run, lease },
    channel,
    invocation,
    name,
    files
  } = context
  const full = JSON.stringify({ isError: result.isError, data: getUsefulMcpResultData(result) })
  const serialized = channel === "sdk" ? JSON.stringify(result) : full
  if (serialized.length <= 32_000) return serialized
  const artifact = files
    ? await files.publish(
        {
          id: `${channel === "sdk" ? "sdk-mcp-result" : channel === "resource" ? "mcp-resource-result" : "mcp-result"}:${run.id}:${invocation}`,
          conversationId: run.conversationId,
          runId: run.id,
          name: `${name.replace(/[^\w.-]/g, "_").slice(0, 100) || "resource"}-result.json`,
          mime: "application/json",
          origin: "connector"
        },
        Buffer.from(full),
        lease
      )
    : undefined
  const preview = JSON.stringify({
    isError: result.isError,
    preview: projectMcpResultData(result, { maxChars: 24_000, maxArrayItems: 100 }),
    truncated: true,
    artifactId: artifact?.id
  })
  return channel !== "sdk"
    ? preview
    : JSON.stringify({
        capabilityId: result.capabilityId,
        isError: result.isError,
        text: preview,
        raw: { content: [{ type: "text", text: preview }], isError: result.isError }
      })
}
