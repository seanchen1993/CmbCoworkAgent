import { useCallback, useMemo, useState } from "react"

import {
  loadActiveRequirementDesignEntry,
  storeActiveRequirementDesignEntry
} from "@/lib/requirement-design-entry"
import type { ActiveRequirementDesignEntry } from "./use-requirement-design-entry"

export function usePersistentRequirementDesignEntry(
  sessionId: string | null
): readonly [
  ActiveRequirementDesignEntry | null,
  (entry: ActiveRequirementDesignEntry | null) => void,
  (sessionId: string) => void
] {
  // transientEntry 承载跨模式跳转期间尚未绑定会话的临时状态，持久化关联仍按 sessionId 读取。
  const [revision, setRevision] = useState(0)
  const [transientEntry, setTransientEntry] = useState<{
    sessionId: string | null
    entry: ActiveRequirementDesignEntry
  } | null>(null)
  const persistedEntry = useMemo(() => {
    void revision
    const restored = loadActiveRequirementDesignEntry(sessionId)
    return restored ? { ...restored, bindingReady: true } : null
  }, [revision, sessionId])
  const entry = transientEntry?.sessionId === sessionId ? transientEntry.entry : persistedEntry

  const setEntry = useCallback(
    (nextEntry: ActiveRequirementDesignEntry | null) => {
      if (!nextEntry) {
        // 跳转失败只清除临时上下文，不能误删当前设计会话已经持久化的需求关联。
        setTransientEntry(null)
        return
      }
      const targetSessionId = nextEntry.htmlId || sessionId
      setTransientEntry({ sessionId: targetSessionId, entry: nextEntry })
      if (nextEntry.htmlId) {
        storeActiveRequirementDesignEntry(nextEntry, nextEntry.htmlId)
        setRevision((current) => current + 1)
      }
    },
    [sessionId]
  )

  const removeEntry = useCallback((removedSessionId: string) => {
    // 设计会话被删除时同步移除对应映射，其他会话的关联保持不变。
    storeActiveRequirementDesignEntry(null, removedSessionId)
    setTransientEntry((current) => (current?.sessionId === removedSessionId ? null : current))
    setRevision((current) => current + 1)
  }, [])

  return [entry, setEntry, removeEntry] as const
}
