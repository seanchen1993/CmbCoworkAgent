import { Check, ChevronDown, Copy, Folder, FolderOpen } from "lucide-react"
import { useState } from "react"
import { toast } from "sonner"
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover"
import { botWorkspaceDisplay } from "@/lib/bot-workspace-display"
import type { BotWorkConversationResolution } from "../../../../shared/bots/conversation"

export function BotTaskWorkspaceButton({ link }: { link: BotWorkConversationResolution }) {
  const [copied, setCopied] = useState(false)
  const display = botWorkspaceDisplay(
    link.workspacePath,
    [],
    link.work.workspace,
    link.bot,
    link.imConversation
  )
  const fail = (error: unknown) =>
    toast.error(error instanceof Error ? error.message : "无法打开工作目录")
  return (
    <Popover onOpenChange={() => setCopied(false)}>
      <PopoverTrigger asChild>
        <button
          type="button"
          className="inline-flex min-w-0 max-w-full items-center gap-1.5 rounded-md px-2 py-1.5 text-xs text-muted-foreground transition-colors hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          aria-label={`工作目录：${display.name}`}
        >
          <Folder size={14} className="shrink-0" aria-hidden="true" />
          <span className="max-w-[220px] truncate">
            {display.isDefault ? "默认工作区" : display.name}
          </span>
          {!display.isDefault && (
            <span className="shrink-0 text-[10px] opacity-70">{display.kindLabel}</span>
          )}
          <ChevronDown size={12} className="shrink-0 opacity-60" aria-hidden="true" />
        </button>
      </PopoverTrigger>
      <PopoverContent align="start" className="w-80 max-w-[calc(100vw-32px)] p-4">
        <p className="text-sm font-medium">{display.name}</p>
        <p className="mt-1 text-xs leading-relaxed text-muted-foreground">
          {display.isDefault
            ? "由 Bot 自动管理，任务文件保存在这里。"
            : "本任务使用此目录，后续修改沿用原位置。"}
        </p>
        <p className="my-3 break-all rounded-md bg-muted/50 px-3 py-2 font-mono text-[11px] leading-relaxed select-text">
          {link.workspacePath}
        </p>
        <div className="flex items-center justify-between gap-2 text-xs">
          <button
            className="inline-flex items-center gap-1.5 rounded-md px-2 py-1.5 hover:bg-muted"
            onClick={() => {
              void navigator.clipboard
                .writeText(link.workspacePath)
                .then(() => setCopied(true))
                .catch(fail)
            }}
          >
            {copied ? <Check size={14} /> : <Copy size={14} />} {copied ? "已复制" : "复制路径"}
          </button>
          <button
            className="inline-flex items-center gap-1.5 rounded-md px-2 py-1.5 hover:bg-muted"
            onClick={() => {
              void window.electron.ipcRenderer.invoke("open-folder", link.workspacePath).catch(fail)
            }}
          >
            <FolderOpen size={14} /> 打开文件夹
          </button>
        </div>
      </PopoverContent>
    </Popover>
  )
}
