import type {
  ThreadGroupIdsOptions,
  ThreadGroupIdsResult,
  ThreadGroupSelectionEntry,
  ThreadGroupSelector
} from "../../../main/types"

export type { ThreadGroupSelectionEntry } from "../../../main/types"

export const THREAD_GROUP_SELECTION_MAX_IDS = 10_000

export type ThreadGroupIdsReader = (options: ThreadGroupIdsOptions) => Promise<ThreadGroupIdsResult>

function haveSameIncarnation(
  left: ThreadGroupSelectionEntry["incarnation"],
  right: ThreadGroupSelectionEntry["incarnation"]
): boolean {
  return left.token === right.token && left.legacyCreatedAt === right.legacyCreatedAt
}

export async function readCompleteThreadGroupSelection(
  selector: ThreadGroupSelector,
  readGroupIds: ThreadGroupIdsReader
): Promise<ThreadGroupSelectionEntry[]> {
  const result = await readGroupIds({ selector })
  const entries: ThreadGroupSelectionEntry[] = []
  const seenEntries = new Map<string, ThreadGroupSelectionEntry>()
  for (const entry of result.entries) {
    if (
      !entry ||
      typeof entry !== "object" ||
      typeof entry.threadId !== "string" ||
      !entry.threadId
    ) {
      throw new Error("批量删除查询返回了无效会话")
    }
    const incarnation = entry.incarnation
    if (
      !incarnation ||
      typeof incarnation !== "object" ||
      (incarnation.token !== null &&
        (typeof incarnation.token !== "string" ||
          !incarnation.token ||
          incarnation.token.length > 4_096)) ||
      !Number.isFinite(incarnation.legacyCreatedAt)
    ) {
      throw new Error("批量删除查询返回了无效会话实例")
    }
    const previous = seenEntries.get(entry.threadId)
    if (previous) {
      if (!haveSameIncarnation(previous.incarnation, incarnation)) {
        throw new Error("批量删除查询返回了冲突的会话实例")
      }
      continue
    }
    const selected = {
      threadId: entry.threadId,
      incarnation: {
        token: incarnation.token,
        legacyCreatedAt: incarnation.legacyCreatedAt
      }
    }
    seenEntries.set(entry.threadId, selected)
    entries.push(selected)
    if (entries.length > THREAD_GROUP_SELECTION_MAX_IDS) {
      throw new Error(`该分组超过 ${THREAD_GROUP_SELECTION_MAX_IDS} 个会话，为避免误删已停止操作`)
    }
  }
  return entries
}

export function listCompleteThreadGroupSelection(
  selector: ThreadGroupSelector
): Promise<ThreadGroupSelectionEntry[]> {
  return readCompleteThreadGroupSelection(selector, (options) =>
    window.api.threads.listGroupIds(options)
  )
}

export function haveSameThreadGroupSelection(
  left: Iterable<ThreadGroupSelectionEntry>,
  right: Iterable<ThreadGroupSelectionEntry>
): boolean {
  const leftEntries = Array.from(left)
  const leftById = new Map(leftEntries.map((entry) => [entry.threadId, entry] as const))
  const rightEntries = Array.from(right)
  const rightById = new Map(rightEntries.map((entry) => [entry.threadId, entry] as const))
  if (
    leftById.size !== leftEntries.length ||
    rightById.size !== rightEntries.length ||
    leftById.size !== rightById.size
  ) {
    return false
  }
  for (const [threadId, leftEntry] of leftById) {
    const rightEntry = rightById.get(threadId)
    if (!rightEntry || !haveSameIncarnation(leftEntry.incarnation, rightEntry.incarnation)) {
      return false
    }
  }
  return true
}
