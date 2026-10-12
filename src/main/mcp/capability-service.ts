import { ManagedMcpCapabilityService } from "./capability-core"
import { readDesktopMcpSources } from "./desktop-sources"
import type { McpCapabilityService } from "./capability-types"
import { recordSuccessfulToolExample } from "./tool-example-store"
import { withRawModMcp, publishCurrentModResult } from "../mods/adapters"
import { getModCallContext } from "../mods/context"
import { authorizeCurrentModInput } from "../mods/manager"
import { invokeMcpToolWithRetry } from "./invocation-retry"
import { beforeModToolExecution } from "../mods/execution-error"
import { ModError } from "../mods/errors"

let globalCapabilityService: ManagedMcpCapabilityService | null = null

export function getGlobalMcpCapabilityService(): McpCapabilityService {
  if (!globalCapabilityService) {
    globalCapabilityService = new ManagedMcpCapabilityService({
      readSources: readDesktopMcpSources,
      connectionExpired: () => new ModError("MODS_MCP_CONTEXT_EXPIRED"),
      signal: () => getModCallContext()?.signal,
      callTransport: invokeMcpToolWithRetry,
      aroundInvoke: (tool, args, invoke) =>
        withRawModMcp(tool, args, async (effectiveArgs) => {
          await authorizeCurrentModInput(`mcp:${tool.capabilityId}`, effectiveArgs)
          await beforeModToolExecution(() => getModCallContext()?.assertMcpTool?.(tool))
          const result = await publishCurrentModResult(await invoke(effectiveArgs))
          try {
            if (!getModCallContext()) recordSuccessfulToolExample(tool, result)
          } catch (error) {
            console.warn(`[MCP] failed to persist tool example for "${tool.toolId}":`, error)
          }
          return result
        })
    })
  }
  return globalCapabilityService
}

export async function invalidateGlobalMcpCapabilityService(reason?: string): Promise<void> {
  if (!globalCapabilityService) return
  await globalCapabilityService.invalidate(reason)
}

export async function closeGlobalMcpCapabilityService(): Promise<void> {
  if (!globalCapabilityService) return
  await globalCapabilityService.close()
  globalCapabilityService = null
}
