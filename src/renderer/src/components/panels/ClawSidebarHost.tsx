import { useCallback } from "react"
import { attachClawSidebarHost } from "@/lib/claw-sidebar"

/** Keep drawings mounted while sharing the native panel's width and collapse state. */
export function ClawSidebarShell({ threadId, hidden }: { threadId: string; hidden: boolean }) {
  return (
    <div
      hidden={hidden}
      inert={hidden}
      data-claw-sidebar-shell
      className="h-full min-h-0 w-full overflow-hidden border-l border-border bg-background"
      style={hidden ? { display: "none" } : undefined}
    >
      <ClawSidebarHost key={threadId} threadId={threadId} />
    </div>
  )
}

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
