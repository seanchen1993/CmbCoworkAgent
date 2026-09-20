import { randomUUID } from "node:crypto"
import type { ModObject } from "../../../shared/mods/types"
import { ModFunctionError } from "../../../shared/mods/v2/contracts"
import { functionSdkToolInput, validateFunctionToolResult } from "./tool-sdk"
import { functionMcpInput, FunctionMcpToolResults, type FunctionMcpToolDispatch } from "./mcp-sdk"

interface McpRoutingHost {
  resolve(input: ModObject, signal: AbortSignal): Promise<ModObject>
  invoke(input: ModObject, signal: AbortSignal, fingerprint: string): Promise<ModObject>
}

/** Resolve first, then release the temporary adapter before entering any guest hook. */
export async function routeFunctionMcp(
  raw: ModObject,
  signal: AbortSignal,
  dispatch: FunctionMcpToolDispatch,
  host: McpRoutingHost
): Promise<ModObject> {
  const input = functionMcpInput(raw)
  signal.throwIfAborted()
  const selected = await host.resolve(input, signal)
  signal.throwIfAborted()
  if (typeof selected.name !== "string" || typeof selected.fingerprint !== "string")
    throw new ModFunctionError("MODS_MCP_TOOL_UNAVAILABLE")
  const results = new FunctionMcpToolResults()
  const answer = await dispatch(
    { ...(input.args as ModObject), tool: selected.name, tool_use_id: randomUUID() },
    signal,
    async (event, childSignal) => {
      childSignal.throwIfAborted()
      if (event.tool !== selected.name) throw new ModFunctionError("MODS_MCP_TOOL_CHANGED")
      const { args } = functionSdkToolInput(event)
      return results.add(
        await host.invoke({ ...input, args }, childSignal, selected.fingerprint as string)
      )
    }
  )
  signal.throwIfAborted()
  validateFunctionToolResult(answer)
  return results.resolve(answer)
}
