import { getGlobalMcpCapabilityService } from "../../mcp/capability-service"
import { createHookScope, resolveEnabledHooksForRun } from "../../hooks/scope"
import { functionExecutionScope } from "./execution-context"
import { ModFunctionError } from "../../../shared/mods/v2/contracts"

const commands = new Map<string, { pending: number; tail: Promise<void> }>()

/** Writes share the thread lease, but concurrent SDK calls must not replace each other's adapter. */
export async function withFunctionMcpCommand<T>(
  workspace: string,
  threadId: string,
  turnId: string,
  signal: AbortSignal,
  run: () => Promise<T>
): Promise<T> {
  const key = JSON.stringify([workspace, threadId])
  const queue = commands.get(key) ?? { pending: 0, tail: Promise.resolve() }
  if (queue.pending >= 16) throw new ModFunctionError("MODS_MCP_COMMAND_LIMIT")
  const previous = queue.tail
  let done!: () => void
  queue.tail = new Promise<void>((resolve) => {
    done = resolve
  })
  queue.pending++
  commands.set(key, queue)
  try {
    await previous
    signal.throwIfAborted()
    functionExecutionScope(workspace, threadId)
    const release = await bindFunctionMcpCommand(workspace, threadId, turnId, signal)
    try {
      return await run()
    } finally {
      release()
    }
  } finally {
    queue.pending--
    if (!queue.pending) commands.delete(key)
    done()
  }
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
