import { ModError } from "../mods/errors"

/** A workspace-free display decision only applies to an existing unbound transcript. */
export function assertUnboundModsChatHistory(
  threadId: string,
  read: (threadId: string) => { metadata: unknown } | null
): void {
  if (typeof threadId !== "string" || !threadId.trim() || threadId.length > 200)
    throw new ModError("MODS_THREAD_INVALID")
  const thread = read(threadId)
  if (!thread) throw new ModError("MODS_THREAD_MISSING")
  if (thread.metadata === null) return
  if (typeof thread.metadata !== "string") throw new ModError("MODS_SCOPE_CHANGED")
  const metadata: unknown = JSON.parse(thread.metadata)
  if (!metadata || typeof metadata !== "object" || Array.isArray(metadata) ||
    ("workspacePath" in metadata && metadata.workspacePath !== null))
    throw new ModError("MODS_SCOPE_CHANGED")
}

/** A synchronous host decision, never a renderer estimate or a runtime/session initializer. */
export function readModsChatDisplayCapability(
  manager: { isEnabled(workspace: string): boolean; protects(workspace: string): boolean },
  access: { workspace: string; assertCurrent(): void }
): boolean {
  access.assertCurrent()
  const enabled = manager.isEnabled(access.workspace)
  const protectedOutput = manager.protects(access.workspace)
  access.assertCurrent()
  if (typeof enabled !== "boolean" || typeof protectedOutput !== "boolean")
    throw new ModError("MODS_UI_SITE_PROTECTION_REQUIRED")
  return enabled || protectedOutput
}
