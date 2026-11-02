import { useCallback } from "react"
import { attachClawSidebarHost } from "@/lib/claw-sidebar"

/** Stable destination: collapsing the sidebar never remounts a plugin drawing. */
export function ClawSidebarHost({ threadId }: { threadId: string }) {
  const ref = useCallback(
    (element: HTMLDivElement | null) => attachClawSidebarHost(threadId, element),
    [threadId]
  )
  return (
    <div
      ref={ref}
      data-claw-sidebar-host={threadId}
      className="h-full min-h-0 [&:has(aside)>p]:hidden"
    >
      <p className="p-5 text-sm leading-6 text-muted-foreground">
        任务进展用于普通对话。项目任务请在原项目页面查看阶段、会话和成果。
      </p>
    </div>
  )
}
