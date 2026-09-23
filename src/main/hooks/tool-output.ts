import { isCommand } from "@langchain/langgraph"
import { projectModResult, replaceModProjection } from "../mods/publication"
import type { HookResult } from "./types"

/** Classic output effects change presentation only; execution status and routing stay host-owned. */
export function applyClassicToolOutput<T>(
  original: T,
  result: HookResult | null,
  options: { mcp?: boolean; toolCallId?: string } = {}
): T {
  if (!result) return original
  const replacement =
    options.mcp && result.updatedMCPToolOutput !== undefined
      ? result.updatedMCPToolOutput
      : result.updatedToolOutput
  if (replacement === undefined || (isCommand(original) && !options.toolCallId)) return original
  return replaceModProjection(original, projectModResult(replacement), options.toolCallId)
}
