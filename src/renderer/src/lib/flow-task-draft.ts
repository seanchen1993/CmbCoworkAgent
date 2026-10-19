import { useSyncExternalStore } from "react"

const drafts = new Map<string, string>()
const listeners = new Set<() => void>()
const key = (threadId: string, workspace?: string | null) => JSON.stringify([threadId, workspace])
export function readFlowTaskDraft(threadId: string, workspace?: string | null): string {
  return drafts.get(key(threadId, workspace)) ?? ""
}
export function setFlowTaskDraft(
  threadId: string,
  workspace: string | null | undefined,
  text: string
) {
  const id = key(threadId, workspace)
  if (text) {
    drafts.delete(id)
    drafts.set(id, text)
    if (drafts.size > 128) drafts.delete(drafts.keys().next().value!)
  } else drafts.delete(id)
  for (const listener of listeners) listener()
}
export function useFlowTaskDraft(threadId: string, workspace?: string | null) {
  return useSyncExternalStore(
    (callback) => {
      listeners.add(callback)
      return () => {
        listeners.delete(callback)
      }
    },
    () => readFlowTaskDraft(threadId, workspace)
  )
}
