import { useEffect, useState } from "react"
import { useAppStore } from "@/lib/store"
import { normalizeWorkspacePathKey } from "../../../shared/workspace-path"

/** Native mode for the exact settings target. Events invalidate first; no timer or DOM inference. */
export function useDevelopmentCreatorMode(threadId: string | null, workspace: string | null) {
  const account = useAppStore((state) => state.accountRevision)
  const key = JSON.stringify([account, threadId, normalizeWorkspacePathKey(workspace)])
  const [observed, setObserved] = useState<{ key: string; creator: boolean }>()
  useEffect(() => {
    if (!threadId || !workspace) return
    const api = window.api.mods?.development
    if (!api?.status || !api.onChanged) return
    let alive = true,
      pending = false,
      queued = false,
      revision = 0
    const current = () => alive && account === useAppStore.getState().accountRevision
    const read = async () => {
      if (!current()) return
      if (pending) {
        queued = true
        return
      }
      pending = true
      const captured = revision
      try {
        const status = await api.status({ threadId })
        if (current() && captured === revision)
          setObserved({
            key,
            creator:
              status.threadId === threadId &&
              normalizeWorkspacePathKey(status.workspace) ===
                normalizeWorkspacePathKey(workspace) &&
              status.mode === "creator"
          })
      } catch {
        if (current() && captured === revision) setObserved({ key, creator: false })
      } finally {
        pending = false
        if (queued && current()) {
          queued = false
          void read()
        }
      }
    }
    const stop = api.onChanged((event) => {
      if (event.threadId !== threadId || !current()) return
      revision++
      setObserved(undefined)
      void read()
    })
    void read()
    return () => {
      alive = false
      stop()
    }
  }, [account, key, threadId, workspace])
  return observed?.key === key && observed.creator
}
