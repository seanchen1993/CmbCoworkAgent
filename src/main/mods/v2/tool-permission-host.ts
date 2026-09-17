import { LocalSandbox } from "../../agent/local-sandbox"
import { getWindowsSandboxMode } from "../../storage"
import { getGlobalMcpCapabilityService } from "../../mcp/capability-service"
import { scopedMcpTools } from "../../mcp/scoped-tools"
import type { ModsManager } from "../manager"
import type { ModGrant } from "../control-store"
import type { ModObject } from "../../../shared/mods/types"
import type { RegisteredFunctionTool } from "../../../shared/mods/v2/tools"
import type { ToolPermissionResult } from "../../../shared/tool-permission"
import { functionToolTarget, isNativeFunctionTool } from "./tool-sdk"
import { functionToolCheckInput } from "./tool-check"
import { isModObject } from "../../../shared/mods/v2/contracts"
import { modErrorCode } from "../errors"

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
  signal.throwIfAborted()
  const input = functionToolCheckInput(raw)
  if (!isModObject(input.input)) return { decision: "deny", reason: "MODS_TOOL_ARGUMENTS" }
  const name = String(input.tool)
  let target: string
  let toolNames: string[] = []
  let args = input.input
  if (registered) target = `function:${registered.name}`
  else if (isNativeFunctionTool(name)) {
    try {
      const native = functionToolTarget({ ...args, tool: name })
      target = native.target
      args = native.args
    } catch (error) {
      return { decision: "deny", reason: modErrorCode(error) }
    }
  } else {
    let tools
    try {
      tools = manager.peekFunctionMcpTools(workspace, threadId)
      if (tools === undefined) {
        assertPlainThread(threadId)
        const cached = getGlobalMcpCapabilityService().peekTools?.()
        tools = cached ? scopedMcpTools(cached, new Set()) : null
      }
    } catch (error) {
      return { decision: "deny", reason: modErrorCode(error) }
    }
    if (!tools) return { decision: "deny", reason: "MODS_TOOL_CONTEXT_REQUIRED" }
    const matches = tools.filter((tool) => tool.toolId === name || tool.canonicalToolId === name)
    if (matches.length !== 1)
      return {
        decision: "deny",
        reason: matches.length ? "MODS_TOOL_AMBIGUOUS" : "MODS_TOOL_UNAVAILABLE"
      }
    target = `mcp:${matches[0].capabilityId}`
    toolNames = [matches[0].toolId, matches[0].canonicalToolId ?? matches[0].toolId]
  }
  return manager.queryFunctionTool(
    workspace,
    threadId,
    grant,
    target,
    args,
    signal,
    async (tool, value) => {
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
    },
    toolNames
  )
}
