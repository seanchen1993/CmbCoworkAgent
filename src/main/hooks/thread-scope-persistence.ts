import { getThreadCore, updateThread } from "../db"
import { createHookScope, type HookScopeController } from "./scope"

export const THREAD_HOOK_SCOPE_METADATA_KEY = "hookScope"

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value)
}

function parseMetadata(raw: string | null | undefined): Record<string, unknown> {
  if (!raw) return {}
  try {
    const parsed = JSON.parse(raw) as unknown
    return isRecord(parsed) ? parsed : {}
  } catch {
    return {}
  }
}

function normalizePersistentHookKeys(keys: readonly unknown[]): string[] {
  return [
    ...new Set(keys.filter((key): key is string => typeof key === "string" && key.length > 0))
  ].sort()
}

export function readPersistentHookKeysFromMetadata(metadata: unknown): string[] {
  if (!isRecord(metadata)) return []
  const hookScope = metadata[THREAD_HOOK_SCOPE_METADATA_KEY]
  if (!isRecord(hookScope) || !Array.isArray(hookScope.persistentHookKeys)) return []
  return normalizePersistentHookKeys(hookScope.persistentHookKeys)
}

export function loadPersistentHookKeysForThread(threadId: string): string[] {
  try {
    const thread = getThreadCore(threadId)
    if (!thread) return []
    return readPersistentHookKeysFromMetadata(parseMetadata(thread.metadata))
  } catch (error) {
    console.warn("[Hooks] failed to load persistent hook scope:", error)
    return []
  }
}

export function persistPersistentHookKeysForThread(
  threadId: string,
  keys: readonly string[]
): void {
  let thread: ReturnType<typeof getThreadCore>
  try {
    thread = getThreadCore(threadId)
  } catch (error) {
    console.warn("[Hooks] failed to read thread for hook scope persistence:", error)
    return
  }
  if (!thread) return

  const metadata = parseMetadata(thread.metadata)
  const currentKeys = readPersistentHookKeysFromMetadata(metadata)
  // Persistent keys are append-only for a thread. Disabled/deleted hooks are harmless:
  // scope filtering still requires an enabled hook with persistAfterInterrupt=true
  // and the same key to exist in current hook metadata.
  const nextKeys = normalizePersistentHookKeys([...currentKeys, ...keys])
  if (
    currentKeys.length === nextKeys.length &&
    currentKeys.every((key, index) => key === nextKeys[index])
  ) {
    return
  }

  const existingScope = metadata[THREAD_HOOK_SCOPE_METADATA_KEY]
  const nextScope = isRecord(existingScope) ? { ...existingScope } : {}
  if (nextKeys.length > 0) {
    nextScope.persistentHookKeys = nextKeys
    metadata[THREAD_HOOK_SCOPE_METADATA_KEY] = nextScope
  } else {
    delete nextScope.persistentHookKeys
    if (Object.keys(nextScope).length > 0) {
      metadata[THREAD_HOOK_SCOPE_METADATA_KEY] = nextScope
    } else {
      delete metadata[THREAD_HOOK_SCOPE_METADATA_KEY]
    }
  }

  updateThread(threadId, { metadata: JSON.stringify(metadata) })
}

export function createPersistentThreadHookScope(threadId: string): HookScopeController {
  const initialPersistentHookKeys = loadPersistentHookKeysForThread(threadId)
  const scope = createHookScope({
    initialPersistentHookKeys,
    onPersistentHookKeysChanged: (keys) => persistPersistentHookKeysForThread(threadId, keys)
  })
  return scope
}
