import { functionExecutionScope } from "./execution-context"
import { ModFunctionError } from "../../../shared/mods/v2/contracts"

const commands = new Map<string, { pending: number; tail: Promise<void> }>()

/** A thread lease permits concurrent SDK requests; each temporary adapter still has one owner. */
export async function withFunctionCommandBinding<T>(
  kind: "native" | "mcp",
  workspace: string,
  threadId: string,
  signal: AbortSignal,
  bind: () => Promise<() => void | Promise<void>>,
  run: () => Promise<T>
): Promise<T> {
  const key = JSON.stringify([kind, workspace, threadId])
  const queue = commands.get(key) ?? { pending: 0, tail: Promise.resolve() }
  if (queue.pending >= 16)
    throw new ModFunctionError(kind === "mcp" ? "MODS_MCP_COMMAND_LIMIT" : "MODS_COMMAND_LIMIT")
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
    const release = await bind()
    try {
      signal.throwIfAborted()
      functionExecutionScope(workspace, threadId)
      return await run()
    } finally {
      await release()
    }
  } finally {
    queue.pending--
    if (!queue.pending) commands.delete(key)
    done()
  }
}
