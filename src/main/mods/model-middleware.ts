import { createMiddleware } from "langchain"
import { collectRuntimeToolCatalog } from "../agent/runtime-tool-catalog"
import { getHookAgentIdFromRequest } from "../hooks/execution-context"
import { getModsManager } from "./manager-context"
import { currentFunctionExecution, withFunctionExecution } from "./v2/execution-context"
import { functionToolContexts } from "./v2/tool-result"
import type { ModRuntimeAuthority } from "./runtime-instance"

/** Shared model preparation from Cmb's tool-hook middleware, with host-owned scope. */
export function createModModelMiddleware(options: {
  workspacePath: string
  threadId: string
  hookTurnId?: string
  agentId?: string
  runtimeAuthority?: ModRuntimeAuthority
  activePluginIds?: ReadonlySet<string>
}) {
  return createMiddleware({
    name: "modModelPreparation",
    wrapModelCall: async (request, handler) => {
      const manager = getModsManager()
      if (!manager?.isActive(options.workspacePath)) return handler(request)
      const execution = currentFunctionExecution()
      const runtimeAuthority = execution ? execution.runtimeAuthority : options.runtimeAuthority
      const turnId = execution?.turnId ?? options.hookTurnId ?? options.threadId
      const agentId =
        getHookAgentIdFromRequest(request) ?? execution?.agentId ?? options.agentId ?? "main"
      const nativeTools = collectRuntimeToolCatalog(request.tools)
      manager.bindFunctionToolCatalog(
        {
          runtimeAuthority,
          workspace: options.workspacePath,
          threadId: options.threadId,
          turnId,
          agentId
        },
        nativeTools
      )
      // Only known host-bound subagents may receive guest tools under their role policy.
      const registered = await withFunctionExecution(
        {
          workspace: manager.workspaceKey(options.workspacePath),
          runtimeAuthority,
          threadId: options.threadId,
          agentId,
          userInitiated: false,
          turnId,
          leased: true,
          immediate: false
        },
        () =>
          agentId === "main" || runtimeAuthority
            ? manager.registeredFunctionTools(options.workspacePath, options.threadId)
            : Promise.resolve([])
      )
      if (registered.some((tool) => nativeTools.some((native) => native.name === tool.name)))
        throw new Error("MODS_TOOL_NAME_COLLISION")
      const tools = registered.length
        ? [
            ...request.tools,
            // Dynamic client Runnable instances are rejected by AgentNode. Advertise schemas;
            // wrapToolCall serves them through the same grant-checked FunctionSession.
            ...registered.map((tool) => ({
              type: "function" as const,
              function: {
                name: tool.name,
                description: tool.description,
                parameters: tool.inputSchema
              }
            }))
          ]
        : request.tools
      const blocks = [
        ...(await manager.context({
          runtimeAuthority,
          workspace: options.workspacePath,
          threadId: options.threadId,
          turnId,
          agentId,
          activePluginIds: options.activePluginIds
        })),
        ...functionToolContexts(request.messages)
      ]
      return handler({
        ...request,
        tools,
        ...(blocks.length
          ? { systemMessage: request.systemMessage.concat("\n\n" + blocks.join("\n\n")) }
          : {})
      })
    }
  })
}
