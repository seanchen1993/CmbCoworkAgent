import type { Thread } from "@/types"

export function sortBuiltinRobotThreadsByRemoteAccess(
  threads: Thread[],
  activeThreadIds: ReadonlySet<string>
): Thread[] {
  return [...threads].sort((left, right) => {
    const accessOrder =
      Number(activeThreadIds.has(right.thread_id)) - Number(activeThreadIds.has(left.thread_id))
    if (accessOrder !== 0) return accessOrder
    return right.updated_at.getTime() - left.updated_at.getTime()
  })
}
