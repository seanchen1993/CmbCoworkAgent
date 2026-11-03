import { useContext, type ReactNode } from "react"
import { Button } from "@/components/ui/button"
import {
  NativeProjectChatGuideContext,
  NativeProjectChatPresence
} from "./native-project-chat-context"

/** Only this small welcome block subscribes to changing project status. No model/IPC calls. */
export function NativeProjectChatGuide({
  threadId,
  renderMarkdown,
  children
}: {
  threadId: string
  renderMarkdown: (content: string) => ReactNode
  children: ReactNode
}) {
  const native = useContext(NativeProjectChatPresence)
  const value = useContext(NativeProjectChatGuideContext)
  if (!native) return children
  if (!value || value.threadId !== threadId) return null
  const { guide } = value
  return (
    <section aria-label="项目插件使用指引" className="mb-6 max-w-3xl space-y-3 text-sm">
      <p className="font-medium">当前阶段：{guide.stage}</p>
      <p className="text-xs text-muted-foreground">
        项目插件：{guide.plugin}
        {guide.version && ` · ${guide.version}`}
      </p>
      <details className="text-xs text-muted-foreground">
        <summary className="cursor-pointer">查看项目流程</summary>
        <p className="mt-2 leading-5">{guide.route}</p>
      </details>
      {guide.userGuide && renderMarkdown(guide.userGuide)}
      <p className="text-muted-foreground">
        发送消息时会自动带入当前阶段说明，无需手动输入斜杠命令。正式执行请使用下方入口。
      </p>
      <p className="text-muted-foreground">{guide.message}</p>
      <Button variant="outline" size="sm" disabled={value.disabled} onClick={value.onAction}>
        {value.actionLabel}
      </Button>
    </section>
  )
}
