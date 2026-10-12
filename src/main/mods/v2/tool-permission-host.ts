import { LocalSandbox } from "../../agent/local-sandbox"
import { getWindowsSandboxMode } from "../../storage"
import { getGlobalMcpCapabilityService } from "../../mcp/capability-service"
import { scopedMcpTools } from "../../mcp/scoped-tools"
import type { ModsManager } from "../manager"
import type { ModGrant } from "../control-store"
import type { ModObject } from "../../../shared/mods/types"
import type { RegisteredFunctionTool } from "../../../shared/mods/v2/tools"
import type { ToolPermissionResult } from "../../../shared/tool-permission"
import { queryFunctionToolPermissionWith } from "./tool-permission-core"

/** Queries reuse an active adapter or an inert plain-project probe. No tool discovery is run. */
export async function queryFunctionToolPermission(
  manager: ModsManager,
  assertPlainThread: (threadId: string) => void,
  workspace: string,
  threadId: string,
  grant: ModGrant,
  raw: ModObject,
  signal: AbortSignal,
  registered?: RegisteredFunctionTool
): Promise<ToolPermissionResult> {
  return queryFunctionToolPermissionWith(
    manager,
    {
      peekMcpTools: () => {
        const scoped = manager.peekFunctionMcpTools(workspace, threadId)
        if (scoped !== undefined) return scoped
        assertPlainThread(threadId)
        const cached = getGlobalMcpCapabilityService().peekTools?.()
        return cached ? scopedMcpTools(cached, new Set()) : null
      },
      query: async (tool, value) => {
        if (!tool.startsWith("host:")) return { decision: "allow" }
        assertPlainThread(threadId)
        const query = LocalSandbox.createPermissionProbe({
          rootDir: workspace,
          runId: threadId,
          virtualMode: false,
          windowsSandbox: process.platform === "win32" ? getWindowsSandboxMode() : "none",
          abortSignal: signal
        })
        return query(tool.slice(5), value)
      }
    },
    workspace,
    threadId,
    grant,
    raw,
    signal,
    registered
  )
}
