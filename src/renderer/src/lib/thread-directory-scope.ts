import { parseThreadDirectoryChange, type ThreadDirectoryChange } from "../../../shared/thread-directory-change"

type DirectoryHintScope = Pick<ThreadDirectoryChange, "threadId" | "workspacePath" | "incarnation">
export type ThreadDirectoryScope = DirectoryHintScope & { readonly workspacePath: string }

/** Native row facts used only to decide which cached view to revoke, never for admission. */
export function rendererThreadDirectoryScope(thread: {
  thread_id: string; created_at: Date; metadata?: Record<string, unknown>
} | null | undefined): ThreadDirectoryScope | undefined {
  if (!thread) return undefined
  const token = thread.metadata?.cmb_thread_incarnation
  const scope = parseThreadDirectoryChange({ threadId: thread.thread_id, kind: "metadata",
    workspacePath: thread.metadata?.workspacePath,
    incarnation: { token: typeof token === "string" && token ? token : null,
      legacyCreatedAt: thread.created_at instanceof Date ? thread.created_at.getTime() : NaN } })
  return scope && typeof scope.workspacePath === "string" ? scope as ThreadDirectoryScope : undefined
}

export function sameThreadDirectoryScope(first: DirectoryHintScope | undefined,
  second: DirectoryHintScope | undefined): boolean {
  if (!first || !second || typeof first.workspacePath !== "string" ||
    typeof second.workspacePath !== "string") return false
  const pathKey = (path: string) => /^(?:[a-z]:[\\/]|\\\\)/i.test(path)
    ? path.replace(/\\/g, "/").toLowerCase() : path
  return first.threadId === second.threadId && pathKey(first.workspacePath) === pathKey(second.workspacePath) &&
    first.incarnation.token === second.incarnation.token &&
    first.incarnation.legacyCreatedAt === second.incarnation.legacyCreatedAt
}
