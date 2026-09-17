import { getGlobalMcpCapabilityService } from "../../mcp/capability-service"
import { createHookScope, resolveEnabledHooksForRun } from "../../hooks/scope"
import { withFunctionCommandBinding } from "./command-binding"

/** Writes share the thread lease, but concurrent SDK calls must not replace each other's adapter. */
export async function withFunctionMcpCommand<T>(
  workspace: string,
  threadId: string,
  turnId: string,
  signal: AbortSignal,
  run: () => Promise<T>
): Promise<T> {
  return withFunctionCommandBinding(
    "mcp",
    workspace,
    threadId,
    signal,
    () => bindFunctionMcpCommand(workspace, threadId, turnId, signal),
    run
  )
}

/** Reuse the production scoped MCP adapter; discovery never invokes a model or tool. */
async function bindFunctionMcpCommand(
  workspace: string,
  threadId: string,
  turnId: string,
  signal: AbortSignal
): Promise<() => void> {
  const { createScopedMcpCapabilityService } = await import("../../agent/runtime")
  signal.throwIfAborted()
  const scope = createHookScope()
  let release = () => {}
  createScopedMcpCapabilityService(
    getGlobalMcpCapabilityService(),
    scope,
    (event, context) => resolveEnabledHooksForRun(workspace, event, context, scope),
    undefined,
    undefined,
    {
      workspacePath: workspace,
      threadId,
      turnId,
      signal,
      readOnly: false,
      onModBinding: (dispose) => {
        release = dispose
      }
    }
  )
  // The application owns the shared transport; releasing a command only removes its binding.
  return () => release()
}
