import { Check, Copy, FolderOpen, Loader2, RotateCcw, Trash2 } from "lucide-react"
import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle
} from "@/components/ui/dialog"
import type { BrowserScriptLibraryEntry } from "../../../../shared/browser-types"

interface BrowserRecordingListDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  hasWorkspace: boolean
  isLoading: boolean
  error: string | null
  entries: BrowserScriptLibraryEntry[]
  currentThreadId?: string | null
  loadingFileName: string | null
  loadingAction: "copy" | "execution" | "delete" | null
  onRefresh: () => void
  onCopyScript: (entry: BrowserScriptLibraryEntry) => void
  onCopyExecution: (entry: BrowserScriptLibraryEntry) => void
  onDelete: (entry: BrowserScriptLibraryEntry) => void
}

export function BrowserRecordingListDialog({
  open,
  onOpenChange,
  hasWorkspace,
  isLoading,
  error,
  entries,
  currentThreadId,
  loadingFileName,
  loadingAction,
  onRefresh,
  onCopyScript,
  onCopyExecution,
  onDelete
}: BrowserRecordingListDialogProps): React.JSX.Element {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[82vh] max-w-5xl gap-0 overflow-hidden border-border/70 p-0 shadow-2xl">
        <DialogHeader className="border-b border-border/70 bg-[linear-gradient(180deg,color-mix(in_srgb,var(--primary)_7%,transparent),transparent)] px-5 py-4">
          <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
            <div>
              <div className="flex items-center gap-3">
                <div className="flex size-9 shrink-0 items-center justify-center rounded-lg border border-primary/20 bg-primary/10 text-primary">
                  <FolderOpen className="size-4" strokeWidth={1.9} />
                </div>
                <div>
                  <DialogTitle className="text-base">录制列表</DialogTitle>
                  <DialogDescription className="mt-1 text-[12px] leading-5">
                    当前工作区已保存的录制脚本。
                  </DialogDescription>
                </div>
              </div>
            </div>
            <Button
              type="button"
              size="sm"
              variant="outline"
              className="h-8 shrink-0 rounded-lg mr-10"
              disabled={isLoading}
              onClick={onRefresh}
            >
              {isLoading ? (
                <Loader2 className="size-3.5 animate-spin" strokeWidth={1.8} />
              ) : (
                <RotateCcw className="size-3.5" strokeWidth={1.8} />
              )}
              刷新
            </Button>
          </div>
        </DialogHeader>

        <div className="min-h-0 overflow-auto p-5">
          {!hasWorkspace ? (
            <div className="rounded-xl border border-dashed border-border/80 bg-muted/20 px-4 py-8 text-center text-sm text-muted-foreground">
              当前会话还没有选择工作区，暂时无法筛选脚本文件。
            </div>
          ) : error ? (
            <div className="rounded-xl border border-status-warning/30 bg-status-warning/10 px-4 py-5 text-sm text-status-warning">
              {error}
            </div>
          ) : isLoading ? (
            <div className="flex items-center justify-center gap-2 py-12 text-sm text-muted-foreground">
              <Loader2 className="size-4 animate-spin" strokeWidth={1.8} />
              正在读取脚本文件...
            </div>
          ) : entries.length === 0 ? (
            <div className="rounded-xl border border-dashed border-border/80 bg-muted/20 px-4 py-8 text-center text-sm text-muted-foreground">
              当前工作区还没有保存过浏览器脚本。
            </div>
          ) : (
            <div className="overflow-x-auto rounded-xl border border-border/70">
              <table className="w-full min-w-[920px] border-collapse text-left text-[12px]">
                <thead className="bg-muted/45 text-[11px] font-medium text-muted-foreground">
                  <tr>
                    <th className="border-b border-border/70 px-3 py-2.5">是否本会话</th>
                    <th className="border-b border-border/70 px-3 py-2.5">文件名</th>
                    <th className="border-b border-border/70 px-3 py-2.5">中文</th>
                    <th className="border-b border-border/70 px-3 py-2.5 text-right">操作</th>
                  </tr>
                </thead>
                <tbody>
                  {entries.map((entry) => {
                    const isCurrentThread = Boolean(
                      currentThreadId && entry.threadId === currentThreadId
                    )
                    const isEntryLoading = loadingFileName === entry.fileName
                    const isCopyLoading = isEntryLoading && loadingAction === "copy"
                    const isExecutionLoading = isEntryLoading && loadingAction === "execution"
                    const isDeleteLoading = isEntryLoading && loadingAction === "delete"

                    return (
                      <tr
                        key={entry.fileName}
                        className="border-b border-border/60 last:border-0 hover:bg-muted/25"
                      >
                        <td className="px-3 py-3">
                          {isCurrentThread ? (
                            <span className="flex">
                              是 <Check className="ml-2 size-4 text-green-500" />
                            </span>
                          ) : (
                            <span>否</span>
                          )}
                        </td>
                        <td
                          className="max-w-72 px-3 py-3 font-mono text-[11px] text-foreground"
                          title={entry.fileName}
                        >
                          <span className="block truncate">{entry.fileName}</span>
                        </td>
                        <td
                          className="max-w-72 px-3 py-3 font-medium text-foreground"
                          title={entry.displayName}
                        >
                          <span className="block truncate">{entry.displayName}</span>
                        </td>
                        <td className="px-3 py-3">
                          <div className="flex justify-end gap-2">
                            <Button
                              type="button"
                              size="sm"
                              variant="outline"
                              className="h-8 rounded-lg text-[11px]"
                              disabled={isEntryLoading}
                              onClick={() => onCopyScript(entry)}
                            >
                              {isCopyLoading ? (
                                <Loader2 className="size-3.5 animate-spin" strokeWidth={1.8} />
                              ) : (
                                <Copy className="size-3.5" strokeWidth={1.8} />
                              )}
                              复制脚本
                            </Button>
                            <Button
                              type="button"
                              size="sm"
                              variant="outline"
                              className="h-8 rounded-lg text-[11px]"
                              disabled={isEntryLoading}
                              onClick={() => onCopyExecution(entry)}
                            >
                              {isExecutionLoading ? (
                                <Loader2 className="size-3.5 animate-spin" strokeWidth={1.8} />
                              ) : (
                                <Copy className="size-3.5" strokeWidth={1.8} />
                              )}
                              内置浏览器执行
                            </Button>
                            <Button
                              type="button"
                              size="sm"
                              variant="outline"
                              className="h-8 rounded-lg text-[11px]"
                              disabled={isEntryLoading}
                              onClick={() => onDelete(entry)}
                            >
                              {isDeleteLoading ? (
                                <Loader2 className="size-3.5 animate-spin" strokeWidth={1.8} />
                              ) : (
                                <Trash2 className="size-3.5" strokeWidth={1.8} />
                              )}
                              删除
                            </Button>
                          </div>
                        </td>
                      </tr>
                    )
                  })}
                </tbody>
              </table>
            </div>
          )}
        </div>
      </DialogContent>
    </Dialog>
  )
}
