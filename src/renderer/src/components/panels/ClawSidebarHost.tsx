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
        请在本地普通对话或 Plugin 项目会话中开启 Mods，再配置 Claw。受控运行和远程会话暂不支持。
      </p>
    </div>
  )
}
