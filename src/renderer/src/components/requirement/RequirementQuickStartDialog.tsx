import { FileText, Link, Plus, Sparkles, Upload } from "lucide-react"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle
} from "@/components/ui/dialog"
import { cn } from "@/lib/utils"

export type RequirementQuickStartSelection = {
  source: "text" | "space" | "file" | "link"
  target: "conversation" | "design" | "development" | "space"
}
export const REQUIREMENT_QUICK_START_EVENT = "requirement:quick-start"

const quickStartItems: Array<{
  source: RequirementQuickStartSelection["source"]
  title: string
  description: string
  actions: Array<{ label: string; target: RequirementQuickStartSelection["target"] }>
  icon: typeof Plus
}> = [
  {
    source: "text",
    title: "从 0 到 1 新建需求",
    description: "白纸起步，边聊边把需求梳理清楚",
    actions: [{ label: "新建", target: "conversation" }],
    icon: Plus
  },
  {
    source: "space",
    title: "使用需求 3.0 的需求",
    description: "切到需求 3.0，直接选择一条已沉淀的需求",
    actions: [{ label: "去 Tab", target: "space" }],
    icon: FileText
  },
  {
    source: "file",
    title: "上传业务发起的需求文件",
    description: "docx / md / txt，读取全文后开始",
    actions: [
      { label: "设计原型", target: "design" },
      { label: "直接开发", target: "development" }
    ],
    icon: Upload
  },
  {
    source: "link",
    title: "粘贴业务发起的需求链接",
    description: "内置浏览器整篇读取，不做摘要",
    actions: [
      { label: "设计原型", target: "design" },
      { label: "直接开发", target: "development" }
    ],
    icon: Link
  }
]

export function RequirementQuickStartDialog({
  open,
  onOpenChange,
  onSelect
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  onSelect: (selection: RequirementQuickStartSelection) => void
}): React.JSX.Element {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="gap-0 overflow-hidden p-0 sm:max-w-[520px]">
        <DialogHeader className="border-b border-border/70 px-5 pb-4 pt-5 text-left">
          <div className="flex items-center gap-2">
            <span className="flex size-8 items-center justify-center rounded-lg bg-[#f8eee4] text-[#c48654]">
              <Sparkles className="size-4" />
            </span>
            <div>
              <DialogTitle className="text-base">快速开始</DialogTitle>
              <DialogDescription className="mt-1 text-xs">
                选择需求来源，后续流程将沿用当前已实现的能力
              </DialogDescription>
            </div>
          </div>
        </DialogHeader>

        <div className="space-y-1.5 p-3">
          {quickStartItems.map((item) => {
            const Icon = item.icon
            return (
              <div
                key={item.source}
                className={cn(
                  "group flex w-full items-center gap-3 rounded-xl border border-transparent px-3 py-3 text-left",
                  "transition-colors hover:border-[#ead7c5] hover:bg-[#fdf8f3]"
                )}
              >
                <span className="flex size-10 shrink-0 items-center justify-center rounded-xl bg-[#f8eee4] text-[#c48654] transition-colors group-hover:bg-[#f4e3d3]">
                  <Icon className="size-[18px]" strokeWidth={1.8} />
                </span>
                <span className="min-w-0 flex-1">
                  <span className="block text-sm font-semibold text-foreground">{item.title}</span>
                  <span className="mt-0.5 block text-xs leading-5 text-muted-foreground">
                    {item.description}
                  </span>
                </span>
                <span className="flex shrink-0 items-center gap-1.5">
                  {item.actions.map((action) => (
                    <button
                      key={action.target}
                      type="button"
                      onClick={() => {
                        onOpenChange(false)
                        onSelect({ source: item.source, target: action.target })
                      }}
                      className={cn(
                        "rounded-md border px-2.5 py-1.5 text-[11px] font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
                        action.target === "development"
                          ? "border-border bg-white text-foreground hover:border-[#c99366] hover:text-[#a96736]"
                          : "border-[#ead7c5] bg-[#f8eee4] text-[#a96736] hover:bg-[#c99366] hover:text-white"
                      )}
                    >
                      {action.label}
                    </button>
                  ))}
                </span>
              </div>
            )
          })}
        </div>

        <p className="border-t border-border/70 px-5 py-3 text-[11px] text-muted-foreground">
          选择来源后进入对应的现有流程，已实现的提示词、归档与会话能力保持不变。
        </p>
      </DialogContent>
    </Dialog>
  )
}
