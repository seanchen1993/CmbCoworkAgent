/** Facts from the host read that produced a page. Never a membership or execution proof. */
export interface ThreadTranscriptSourceScope {
  readonly threadId: string
  readonly incarnation: { readonly token: string | null; readonly legacyCreatedAt: number }
  readonly workspacePath?: string
}

/** Separate from the existing message-body budget; includes all JSON escaping and UTF-8 bytes. */
export const MAX_THREAD_TRANSCRIPT_SOURCE_SCOPE_HEADER_BYTES = 256 * 1024

function fields(
  value: unknown,
  required: readonly string[],
  optional: readonly string[] = []
): Record<string, unknown> | undefined {
  if (
    !value ||
    typeof value !== "object" ||
    ![Object.prototype, null].includes(Object.getPrototypeOf(value))
  )
    return undefined
  const descriptors = Object.getOwnPropertyDescriptors(value)
  if (
    Reflect.ownKeys(descriptors).some(
      (key) => typeof key !== "string" || (!required.includes(key) && !optional.includes(key))
    )
  )
    return undefined
  const result: Record<string, unknown> = {}
  for (const key of [...required, ...optional]) {
    const descriptor = descriptors[key]
    if (!descriptor) {
      if (required.includes(key)) return undefined
      continue
    }
    if (!("value" in descriptor)) return undefined
    result[key] = descriptor.value
  }
  return result
}

/** Missing/invalid scope is a legacy read; callers must not merge it into another resident scope. */
export function parseThreadTranscriptSourceScope(
  value: unknown
): ThreadTranscriptSourceScope | undefined {
  try {
    const source = fields(value, ["threadId", "incarnation"], ["workspacePath"])
    if (
      !source ||
      typeof source.threadId !== "string" ||
      !source.threadId ||
      source.threadId.length > 512 ||
      source.threadId.includes("\0")
    )
      return undefined
    const incarnation = fields(source.incarnation, ["token", "legacyCreatedAt"])
    if (
      !incarnation ||
      (incarnation.token !== null &&
        (typeof incarnation.token !== "string" ||
          !incarnation.token ||
          incarnation.token.length > 512)) ||
      typeof incarnation.legacyCreatedAt !== "number" ||
      !Number.isFinite(incarnation.legacyCreatedAt) ||
      incarnation.legacyCreatedAt < 0
    )
      return undefined
    const workspace = source.workspacePath
    if (
      workspace !== undefined &&
      (typeof workspace !== "string" ||
        !workspace.trim() ||
        workspace.length > 32768 ||
        workspace.includes("\0"))
    )
      return undefined
    const scope: ThreadTranscriptSourceScope = {
      threadId: source.threadId,
      incarnation: Object.freeze({
        token: incarnation.token as string | null,
        legacyCreatedAt: incarnation.legacyCreatedAt
      }),
      ...(typeof workspace === "string" ? { workspacePath: workspace } : {})
    }
    if (
      new TextEncoder().encode(JSON.stringify({ sourceScope: scope })).byteLength >
      MAX_THREAD_TRANSCRIPT_SOURCE_SCOPE_HEADER_BYTES
    )
      return undefined
    return Object.freeze(scope)
  } catch {
    return undefined
  }
}
