import { ArrowLeft, Boxes, FileText, PanelsTopLeft } from "lucide-react"
import { useAppStore } from "@/lib/store"
import { getRequirementDevelopmentMetadata } from "@/lib/requirement-development"
import { returnToRequirementConversation } from "@/lib/requirement-design-entry"

export function RequirementDevelopmentBar({
  threadId
}: {
  threadId: string
}): React.JSX.Element | null {
  const thread = useAppStore(
    (state) => state.threads.find((item) => item.thread_id === threadId) ?? null
  )
  const metadata = getRequirementDevelopmentMetadata(thread)
  if (!metadata) return null

  return (
    <div className="mb-3 shrink-0 rounded-xl border border-border/70 bg-background-elevated/95 p-3 shadow-sm">
      <div className="flex min-w-0 items-center gap-2.5">
        <span className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-primary/10 text-primary">
          <FileText className="size-4" />
        </span>
        <div
          className="min-w-0 flex-1 truncate text-sm font-semibold text-foreground"
          title={metadata.requirementTitle}
        >
          {metadata.requirementTitle || "当前需求"}
        </div>
      </div>
      <div className="mt-2.5 flex min-w-0 items-center justify-between gap-2 border-t border-border/60 pt-2.5">
        <div className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1 text-[11px] text-muted-foreground">
          <span className="inline-flex items-center gap-1">
            <Boxes className="size-3" />
            {metadata.functionCount} 个功能
          </span>
          <span className="inline-flex items-center gap-1">
            <PanelsTopLeft className="size-3" />
            {metadata.hasPrototype ? "已有原型" : "暂无原型"}
          </span>
        </div>
        <button
          type="button"
          onClick={() => returnToRequirementConversation(metadata.requirementId)}
          className="inline-flex h-7 shrink-0 items-center gap-1.5 rounded-md border border-border bg-background px-2.5 text-xs font-medium text-foreground transition-colors hover:border-primary/40 hover:bg-primary/5 hover:text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40"
        >
          <ArrowLeft className="size-3.5" />
          返回需求
        </button>
      </div>
    </div>
  )
}
