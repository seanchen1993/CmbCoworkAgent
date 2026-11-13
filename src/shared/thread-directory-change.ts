/** Host-issued invalidation hint only. Never use this data as a source or execution proof. */
export type ThreadDirectoryChangeKind = "created" | "transcript" | "metadata" | "deleted"
export interface ThreadDirectoryChange {
  readonly threadId: string
  readonly kind: ThreadDirectoryChangeKind
  readonly workspacePath: string | undefined
  readonly incarnation: { readonly token: string | null; readonly legacyCreatedAt: number }
}

function dataFields(value: unknown, keys: readonly string[]): Record<string, unknown> | undefined {
  if (
    !value ||
    typeof value !== "object" ||
    ![Object.prototype, null].includes(Object.getPrototypeOf(value))
  )
    return undefined
  const descriptors = Object.getOwnPropertyDescriptors(value)
  if (Reflect.ownKeys(descriptors).length !== keys.length) return undefined
  const result: Record<string, unknown> = {}
  for (const key of keys) {
    const descriptor = descriptors[key]
    if (!descriptor || !("value" in descriptor)) return undefined
    result[key] = descriptor.value
  }
  return result
}

/** Legacy/unknown/partial hints conservatively invalidate the whole directory/cache. */
export function parseThreadDirectoryChange(value: unknown): ThreadDirectoryChange | undefined {
  try {
    const fields = dataFields(value, ["threadId", "kind", "workspacePath", "incarnation"])
    if (!fields) return undefined
    const { threadId, kind, workspacePath } = fields
    const incarnation = dataFields(fields.incarnation, ["token", "legacyCreatedAt"])
    if (
      !incarnation ||
      typeof threadId !== "string" ||
      !threadId ||
      threadId.length > 512 ||
      threadId.includes("\0") ||
      (workspacePath !== undefined &&
        (typeof workspacePath !== "string" ||
          !workspacePath.trim() ||
          workspacePath.length > 32768 ||
          workspacePath.includes("\0"))) ||
      typeof kind !== "string" ||
      !["created", "transcript", "metadata", "deleted"].includes(kind) ||
      (incarnation.token !== null &&
        (typeof incarnation.token !== "string" ||
          !incarnation.token ||
          incarnation.token.length > 512)) ||
      typeof incarnation.legacyCreatedAt !== "number" ||
      !Number.isFinite(incarnation.legacyCreatedAt) ||
      incarnation.legacyCreatedAt < 0
    )
      return undefined
    return Object.freeze({
      threadId,
      kind: kind as ThreadDirectoryChangeKind,
      workspacePath,
      incarnation: Object.freeze({
        token: incarnation.token as string | null,
        legacyCreatedAt: incarnation.legacyCreatedAt
      })
    })
  } catch {
    return undefined
  }
}
