import { getModCallContext } from "../mods/context"

type McpRequest = { name: string; arguments: Record<string, unknown> }

/** Preserve legacy retries while avoiding a second side effect in a Mods operation. */
export async function invokeMcpToolWithRetry(
  callTool: (request: McpRequest) => Promise<unknown>,
  request: McpRequest,
  retries = getModCallContext() ? 0 : 1
): Promise<unknown> {
  try {
    return await callTool(request)
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    const retryable = ["terminated", "disconnected", "ECONN"].some((text) => message.includes(text))
    if (retries <= 0 || !retryable) throw error
    await new Promise((resolve) => setTimeout(resolve, 500))
    return invokeMcpToolWithRetry(callTool, request, retries - 1)
  }
}
