import { botTaskGroupId, type BotMemory, type BotTask } from "./contracts"

export type BotMemoryScope = { kind: "private" | "shared" } | { kind: "group"; groupId: string }

/** Supplied by the host from the conversation, never selected by a model. */
export interface BotMemoryContext {
  groupId?: string
}

export function botMemoryContext(task: BotTask): BotMemoryContext {
  const source = task.mockSource
  if (source && (!source.personal || task.threadId.startsWith("im-peer-")))
    return { groupId: source.transport === "im" ? source.bindingId : `mock-${source.bindingId}` }
  const groupId = botTaskGroupId(task)
  return groupId ? { groupId } : {}
}

export function botMemoryVisible(
  memory: Pick<BotMemory, "scope">,
  context: BotMemoryContext
): boolean {
  const scope = memory.scope ?? { kind: "private" }
  return (
    scope.kind === "shared" ||
    (context.groupId
      ? scope.kind === "group" && scope.groupId === context.groupId
      : scope.kind === "private")
  )
}

export function botMemoryScopeLabel(scope?: BotMemoryScope): string {
  return scope?.kind === "shared" ? "Bot 共享" : scope?.kind === "group" ? "群内" : "仅私聊"
}
