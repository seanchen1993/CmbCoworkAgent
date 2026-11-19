import { useEffect, useState } from "react"
import { Terminal } from "lucide-react"
import { toast } from "sonner"

export function BackgroundShellStopButton({
  threadId
}: {
  threadId: string
}): React.JSX.Element | null {
  const [active, setActive] = useState(false)
  const [stopping, setStopping] = useState(false)

  useEffect(() => {
    const { hasBackgroundShell, onBackgroundShellChanged } = window.api.agent
    if (!hasBackgroundShell || !onBackgroundShellChanged) return

    let disposed = false
    let observedChange = false
    const update = (active: boolean): void => {
      if (disposed) return
      setActive(active)
    }
    // Subscribe first so a task can start or settle while the initial IPC is in flight.
    const unsubscribe = onBackgroundShellChanged(threadId, (active) => {
      observedChange = true
      update(active)
    })
    void hasBackgroundShell(threadId)
      .then((active) => {
        if (!observedChange) update(active)
      })
      .catch((error) => console.error("[Chat] Failed to read background shell state:", error))
    return () => {
      disposed = true
      unsubscribe()
    }
  }, [threadId])

  if (!active) return null

  const stop = async (): Promise<void> => {
    setStopping(true)
    try {
      await window.api.agent.cancelBackgroundShell(threadId)
    } catch (error) {
      console.error("[Chat] Failed to stop background shell:", error)
      toast.error("停止后台 Bash 失败，请重试")
    } finally {
      setStopping(false)
    }
  }

  return (
    <button
      type="button"
      onClick={() => void stop()}
      disabled={stopping}
      aria-label="停止后台 Bash"
      title="停止后台 Bash"
      className="flex size-7 items-center justify-center rounded-md border border-destructive/40 text-destructive shadow-sm transition-colors hover:bg-destructive/10 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-destructive/50 disabled:opacity-50"
    >
      <Terminal className="size-3.5" />
    </button>
  )
}
