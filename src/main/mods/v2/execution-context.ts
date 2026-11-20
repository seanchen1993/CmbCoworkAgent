import { AsyncLocalStorage } from "node:async_hooks"
import type { ModCommandQueue } from "../command-queue"
import { classifyModTool } from "../engine"
import { ModFunctionError } from "../../../shared/mods/v2/contracts"
import type { ModObject } from "../../../shared/mods/types"

interface FunctionExecution {
  workspace: string
  threadId: string
  agentId?: string
  turnId?: string
  userInitiated: boolean
  leased: boolean
  immediate: boolean
  active: boolean
}

const context = new AsyncLocalStorage<FunctionExecution>()

export function functionExecutionAgent(): string {
  const scope = context.getStore()
  return scope?.active ? (scope.agentId ?? "main") : "main"
}

export function functionExecutionTurn(workspace: string, threadId: string): string | undefined {
  const scope = context.getStore()
  return scope?.active && scope.workspace === workspace && scope.threadId === threadId
    ? scope.turnId
    : undefined
}

export function isFunctionUserAction(workspace: string, threadId: string): boolean {
  const current = context.getStore()
  return (
    current?.active === true &&
    current.workspace === workspace &&
    current.threadId === threadId &&
    current.userInitiated &&
    !current.immediate
  )
}

/** Authority belongs to one host entry and expires when that entry settles. */
export async function withFunctionExecution<T>(
  input: Omit<FunctionExecution, "active">,
  run: () => Promise<T>
): Promise<T> {
  const scope = { ...input, active: true }
  try {
    return await context.run(scope, run)
  } finally {
    scope.active = false
  }
}

export async function scheduleFunctionTool(
  queue: ModCommandQueue,
  workspace: string,
  threadId: string,
  toolId: string,
  signal: AbortSignal,
  run: (signal: AbortSignal, readOnly: boolean, userInitiated: boolean) => Promise<ModObject>
): Promise<ModObject> {
  signal.throwIfAborted()
  const inherited = context.getStore()
  const scope = inherited?.active ? inherited : undefined
  if (scope && (scope.workspace !== workspace || scope.threadId !== threadId))
    throw new ModFunctionError("MODS_CALL_SCOPE_CHANGED")
  const read = classifyModTool(toolId) === "read"
  const userInitiated = scope?.userInitiated === true
  if (!read && (!userInitiated || scope?.immediate))
    throw new ModFunctionError("MODS_WRITE_REQUIRES_USER_ACTION")
  if (scope?.leased || (scope?.immediate && read))
    return run(signal, scope.immediate, userInitiated)
  let result!: ModObject
  await queue.enqueue(
    workspace,
    threadId,
    toolId,
    async (jobSignal) => {
      result = await withFunctionExecution(
        { workspace, threadId, leased: true, immediate: false, userInitiated },
        () => run(jobSignal, false, userInitiated)
      )
      return { text: typeof result.text === "string" ? result.text : "" }
    },
    { signal }
  ).completion
  return result
}
