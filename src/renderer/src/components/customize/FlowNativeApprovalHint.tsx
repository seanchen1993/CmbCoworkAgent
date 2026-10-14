import { useEffect, useRef, useState } from "react"
import { Button } from "@/components/ui/button"
import { useAppStore } from "@/lib/store"
import { useThreadStateSelector, type ThreadState } from "@/lib/thread-context"

const hasNativeQuestion = (state: ThreadState) =>
  Boolean(state.pendingApproval || state.pendingUserInput)

/** Navigation to the existing native approval UI; never duplicates its authority or decisions. */
export function FlowNativeApprovalHint({
  threadId,
  active
}: {
  threadId: string
  active: boolean
}) {
  const waiting = useThreadStateSelector(threadId, hasNativeQuestion)
  const [error, setError] = useState("")
  const [opening, setOpening] = useState(false)
  const alive = useRef(true)
  useEffect(() => {
    alive.current = true
    return () => {
      alive.current = false
    }
  }, [])
  // Initialize the existing thread approval listener before the user can start a flow.
  // Rendering the hint only after start could miss the first fast permission request.
  if (!active) return null
  return (
    <aside
      className={`space-y-2 rounded border p-3 text-sm ${waiting ? "border-amber-500/50 bg-amber-500/5" : "bg-muted/20"}`}
      aria-label="原生权限与工具提问"
    >
      <p>
        {waiting
          ? "当前任务有原生权限审批或工具提问等待处理。流程会等待你的决定。"
          : "执行工具或修改文件时，可能需要在任务中处理原生权限审批或工具提问。"}
      </p>
      <p className="text-xs text-muted-foreground">
        处理后，从聊天中的「按步骤执行 · 管理步骤与记录」返回。此入口不会批准任何操作。
      </p>
      <Button
        size="sm"
        variant="outline"
        disabled={opening}
        onClick={() => {
          setOpening(true)
          setError("")
          void useAppStore
            .getState()
            .selectThread(threadId)
            .catch((reason: unknown) => {
              if (alive.current) setError(reason instanceof Error ? reason.message : String(reason))
            })
            .finally(() => {
              if (alive.current) setOpening(false)
            })
        }}
      >
        返回当前任务处理
      </Button>
      {error && <p role="alert">{error}</p>}
    </aside>
  )
}
