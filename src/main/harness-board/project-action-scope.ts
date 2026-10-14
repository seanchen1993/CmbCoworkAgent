import { AsyncLocalStorage } from "node:async_hooks"

const scope = new AsyncLocalStorage<{
  threadId: string
  binding: string
  assertCurrent: () => void
  active: boolean
}>()

/** Host orchestration only: never accept this scope through IPC or model arguments. */
export async function withProjectActionScope<T>(
  threadId: string,
  binding: unknown,
  assertCurrent: () => void,
  run: () => Promise<T>
): Promise<T> {
  assertCurrent()
  const entry = { threadId, binding: JSON.stringify(binding), assertCurrent, active: true }
  try {
    return await scope.run(entry, run)
  } finally {
    entry.active = false
  }
}

/** Project conversations remain read-only outside their own admitted action execution. */
export function projectActionFlowMetadata(threadId: string, value: unknown): unknown {
  if (!value || typeof value !== "object" || Array.isArray(value)) return value
  const metadata = value as Record<string, unknown>
  if (!metadata.hostProjectRuntime) return value
  const current = scope.getStore()
  if (
    !current?.active ||
    current.threadId !== threadId ||
    current.binding !== JSON.stringify(metadata.hostProjectRuntime)
  )
    return value
  current.assertCurrent()
  const ordinary = { ...metadata }
  delete ordinary.hostProjectRuntime
  return ordinary
}
