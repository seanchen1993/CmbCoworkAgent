import { useCallback, useEffect, useRef, useState } from "react"
import {
  Check,
  Copy,
  FileCode2,
  FolderOpen,
  Loader2,
  Play,
  RotateCcw,
  Save,
  Trash2
} from "lucide-react"
import { toast } from "sonner"
import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle
} from "@/components/ui/dialog"
import type {
  BrowserRecordingSource,
  BrowserScriptLibraryEntry
} from "../../../../shared/browser-types"

interface BrowserRecordingListDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  hasWorkspace: boolean
  isLoading: boolean
  error: string | null
  entries: BrowserScriptLibraryEntry[]
  currentThreadId?: string | null
  loadingFileName: string | null
  loadingAction: "detail" | "execution" | "save" | "continue" | "delete" | null
  onRefresh: () => void
  onReadScript: (entry: BrowserScriptLibraryEntry) => Promise<string>
  onSaveScript: (entry: BrowserScriptLibraryEntry, script: string) => Promise<void>
  onContinueRecording: (entry: BrowserScriptLibraryEntry, script: string) => Promise<void>
  onCopyExecution: (entry: BrowserScriptLibraryEntry) => void
  onDelete: (entry: BrowserScriptLibraryEntry) => void
}

function formatRecordingSource(source: BrowserRecordingSource): string {
  return source === "manual" ? "人工录制" : "AI录制"
}

function formatRecordingTime(createdAt: string): string {
  const date = new Date(createdAt)
  if (Number.isNaN(date.getTime())) return createdAt
  return new Intl.DateTimeFormat("zh-CN", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false
  })
    .format(date)
    .replace(/\//g, "-")
}

const PAGE_SIZE = 10

interface DetailDraftState {
  initialScript: string
  script: string
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
  onReadScript,
  onSaveScript,
  onContinueRecording,
  onCopyExecution,
  onDelete
}: BrowserRecordingListDialogProps): React.JSX.Element {
  const [selectedFileName, setSelectedFileName] = useState<string | null>(null)
  const [detailScript, setDetailScript] = useState("")
  const [detailInitialScript, setDetailInitialScript] = useState("")
  const [detailCopied, setDetailCopied] = useState(false)
  const [detailLoading, setDetailLoading] = useState(false)
  const [currentPage, setCurrentPage] = useState(1)
  const detailDraftsRef = useRef<Record<string, DetailDraftState>>({})

  const saveDetailDraft = useCallback(
    (fileName: string, script: string, initialScript: string): void => {
      detailDraftsRef.current = {
        ...detailDraftsRef.current,
        [fileName]: {
          initialScript,
          script
        }
      }
    },
    []
  )

  const totalPages = Math.max(1, Math.ceil(entries.length / PAGE_SIZE))
  const currentPageSafe = Math.min(currentPage, totalPages)
  const pageStart = (currentPageSafe - 1) * PAGE_SIZE
  const currentEntries = entries.slice(pageStart, pageStart + PAGE_SIZE)

  useEffect(() => {
    setCurrentPage(1)
  }, [open, hasWorkspace, error, isLoading])

  useEffect(() => {
    if (currentPage > totalPages) {
      setCurrentPage(totalPages)
    }
  }, [currentPage, totalPages])

  useEffect(() => {
    if (!open || !hasWorkspace || error || isLoading || entries.length === 0) {
      setSelectedFileName(null)
      setDetailScript("")
      setDetailInitialScript("")
      setDetailCopied(false)
      setDetailLoading(false)
      return
    }

    const pageEntries = entries.slice(pageStart, pageStart + PAGE_SIZE)
    setSelectedFileName((current) => {
      if (current && pageEntries.some((entry) => entry.fileName === current)) {
        return current
      }
      return pageEntries[0]?.fileName ?? null
    })
  }, [open, hasWorkspace, error, isLoading, entries, pageStart])

  useEffect(() => {
    const selectedEntry = entries.find((entry) => entry.fileName === selectedFileName) ?? null
    if (!selectedEntry) {
      setDetailScript("")
      setDetailInitialScript("")
      setDetailCopied(false)
      setDetailLoading(false)
      return
    }

    const cachedDraft = detailDraftsRef.current[selectedEntry.fileName]
    if (cachedDraft) {
      setDetailScript(cachedDraft.script)
      setDetailInitialScript(cachedDraft.initialScript)
      setDetailCopied(false)
      setDetailLoading(false)
      return
    }

    let cancelled = false
    setDetailLoading(true)
    setDetailCopied(false)
    void onReadScript(selectedEntry)
      .then((script) => {
        if (cancelled) return
        setDetailScript(script)
        setDetailInitialScript(script)
        saveDetailDraft(selectedEntry.fileName, script, script)
      })
      .catch(() => {
        // parent callback already reports the failure
      })
      .finally(() => {
        if (!cancelled) setDetailLoading(false)
      })

    return () => {
      cancelled = true
    }
  }, [entries, onReadScript, saveDetailDraft, selectedFileName])

  const handleCopyDetailScript = async (): Promise<void> => {
    if (!detailScript.trim()) return
    try {
      await navigator.clipboard.writeText(detailScript)
      setDetailCopied(true)
      window.setTimeout(() => setDetailCopied(false), 1500)
      toast.success("脚本内容已复制")
    } catch {
      toast.error("复制脚本内容失败")
    }
  }

  const selectedEntry = entries.find((entry) => entry.fileName === selectedFileName) ?? null
  const detailDirty = detailScript !== detailInitialScript
  const isSaveLoading =
    Boolean(selectedEntry) &&
    loadingFileName === selectedEntry?.fileName &&
    loadingAction === "save"
  const isContinueLoading =
    Boolean(selectedEntry) &&
    loadingFileName === selectedEntry?.fileName &&
    loadingAction === "continue"

  const handleSaveDetailScript = async (): Promise<void> => {
    if (!selectedEntry || !detailDirty) return
    await onSaveScript(selectedEntry, detailScript)
    setDetailInitialScript(detailScript)
    saveDetailDraft(selectedEntry.fileName, detailScript, detailScript)
  }

  const handleContinueRecording = async (): Promise<void> => {
    if (!selectedEntry || !detailScript.trim()) return
    await onContinueRecording(selectedEntry, detailScript)
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[88vh] max-w-[96vw] gap-0 overflow-hidden border-border/70 p-0 shadow-2xl">
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
              className="mr-10 h-8 shrink-0 rounded-lg"
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

        <div className="flex min-h-0 flex-1 flex-col lg:flex-row">
          <div className="flex-1 flex min-h-0 flex-1 flex-col border-b border-border/70 lg:border-b-0 lg:border-r">
            <div className="min-h-0 flex-1 overflow-auto p-5">
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
                <div className="space-y-3">
                  <div className="overflow-x-auto rounded-xl border border-border/70">
                    <table className="w-full  border-collapse text-left text-[12px]">
                      <thead className="bg-muted/45 text-[11px] font-medium text-muted-foreground">
                        <tr>
                          <th className="border-b border-border/70 px-3 py-2.5">是否本会话</th>
                          <th className="border-b border-border/70 px-3 py-2.5">中文</th>
                          <th className="w-[92px] min-w-[92px] max-w-[92px] border-b border-border/70 px-3 py-2.5">
                            录制类型
                          </th>
                          <th className="w-[170px] min-w-[170px] max-w-[170px] border-b border-border/70 px-3 py-2.5">
                            时间
                          </th>
                          <th className="border-b border-border/70 px-3 py-2.5 text-right">操作</th>
                        </tr>
                      </thead>
                      <tbody>
                        {currentEntries.map((entry) => {
                          const isCurrentThread = Boolean(
                            currentThreadId && entry.threadId === currentThreadId
                          )
                          const isEntryLoading = loadingFileName === entry.fileName
                          const isDetailLoading =
                            detailLoading && selectedFileName === entry.fileName
                          const isExecutionLoading = isEntryLoading && loadingAction === "execution"
                          const isDeleteLoading = isEntryLoading && loadingAction === "delete"
                          const isSelected = selectedFileName === entry.fileName

                          return (
                            <tr
                              key={entry.fileName}
                              className={[
                                "border-b border-border/60 last:border-0 hover:bg-muted/25",
                                isSelected ? "bg-primary/5" : ""
                              ].join(" ")}
                              onClick={() => setSelectedFileName(entry.fileName)}
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
                                className="max-w-40 px-3 py-3 font-medium text-foreground"
                                title={entry.displayName}
                              >
                                <span className="block truncate">{entry.displayName}</span>
                              </td>
                              <td
                                className="w-[92px] min-w-[92px] max-w-[92px] truncate px-3 py-3 text-[11px] text-foreground"
                                title={formatRecordingSource(entry.recordingSource)}
                              >
                                {formatRecordingSource(entry.recordingSource)}
                              </td>
                              <td
                                className="px-3 py-3 text-[11px] text-muted-foreground"
                                title={entry.createdAt}
                              >
                                {formatRecordingTime(entry.createdAt)}
                              </td>
                              <td className="px-3 py-3">
                                <div className="flex justify-end gap-2">
                                  <Button
                                    type="button"
                                    size="sm"
                                    variant="outline"
                                    className="h-8 rounded-lg text-[11px]"
                                    disabled={isEntryLoading}
                                    onClick={(event) => {
                                      event.stopPropagation()
                                      setSelectedFileName(entry.fileName)
                                    }}
                                  >
                                    {isDetailLoading ? (
                                      <Loader2
                                        className="size-3.5 animate-spin"
                                        strokeWidth={1.8}
                                      />
                                    ) : (
                                      <FileCode2 className="size-3.5" strokeWidth={1.8} />
                                    )}
                                    查看详情
                                  </Button>
                                  <Button
                                    type="button"
                                    size="sm"
                                    variant="outline"
                                    className="h-8 rounded-lg text-[11px]"
                                    disabled={isEntryLoading}
                                    onClick={(event) => {
                                      event.stopPropagation()
                                      onCopyExecution(entry)
                                    }}
                                  >
                                    {isExecutionLoading ? (
                                      <Loader2
                                        className="size-3.5 animate-spin"
                                        strokeWidth={1.8}
                                      />
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
                                    onClick={(event) => {
                                      event.stopPropagation()
                                      onDelete(entry)
                                    }}
                                  >
                                    {isDeleteLoading ? (
                                      <Loader2
                                        className="size-3.5 animate-spin"
                                        strokeWidth={1.8}
                                      />
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
                  <div className="flex items-center justify-between gap-3 rounded-lg border border-border/70 bg-muted/20 px-3 py-2 text-[11px] text-muted-foreground">
                    <span>
                      共 {entries.length} 条，当前第 {currentPageSafe}/{totalPages} 页
                    </span>
                    <div className="flex items-center gap-2">
                      <Button
                        type="button"
                        size="sm"
                        variant="outline"
                        className="h-7 rounded-md px-2 text-[11px]"
                        disabled={currentPageSafe <= 1}
                        onClick={() => setCurrentPage((page) => Math.max(1, page - 1))}
                      >
                        上一页
                      </Button>
                      <Button
                        type="button"
                        size="sm"
                        variant="outline"
                        className="h-7 rounded-md px-2 text-[11px]"
                        disabled={currentPageSafe >= totalPages}
                        onClick={() => setCurrentPage((page) => Math.min(totalPages, page + 1))}
                      >
                        下一页
                      </Button>
                    </div>
                  </div>
                </div>
              )}
            </div>
          </div>

          <div className="flex-1 flex min-h-0 w-full flex-col">
            <div className="border-b border-border/70 px-5 py-4">
              <div className="flex items-center justify-between gap-3">
                <div className="flex-1 min-w-0">
                  <DialogTitle className="text-base">{selectedEntry?.displayName}</DialogTitle>
                  <DialogDescription className="mt-1 text-[12px] leading-5">
                    {selectedEntry
                      ? "左侧列表选中项的脚本内容，可直接编辑、保存或基于当前版本继续录制。"
                      : "请选择一条录制查看脚本。"}
                  </DialogDescription>
                </div>
                <div className="gap-2">
                  <Button
                    type="button"
                    size="sm"
                    variant="outline"
                    className="h-8 rounded-lg text-[11px]"
                    disabled={
                      !detailScript.trim() || detailLoading || isSaveLoading || isContinueLoading
                    }
                    onClick={() => void handleCopyDetailScript()}
                  >
                    {detailCopied ? (
                      <Check className="size-3.5" strokeWidth={1.8} />
                    ) : (
                      <Copy className="size-3.5" strokeWidth={1.8} />
                    )}
                    {detailCopied ? "已复制" : "复制内容"}
                  </Button>
                  <Button
                    type="button"
                    size="sm"
                    variant="outline"
                    className="h-8 rounded-lg text-[11px]"
                    disabled={!selectedEntry || !detailDirty || detailLoading || isContinueLoading}
                    onClick={() => void handleSaveDetailScript()}
                  >
                    {isSaveLoading ? (
                      <Loader2 className="size-3.5 animate-spin" strokeWidth={1.8} />
                    ) : (
                      <Save className="size-3.5" strokeWidth={1.8} />
                    )}
                    保存修改
                  </Button>
                  <Button
                    type="button"
                    size="sm"
                    className="h-8 rounded-lg text-[11px]"
                    disabled={
                      !selectedEntry || !detailScript.trim() || detailLoading || isSaveLoading
                    }
                    onClick={() => void handleContinueRecording()}
                  >
                    {isContinueLoading ? (
                      <Loader2 className="size-3.5 animate-spin" strokeWidth={1.8} />
                    ) : (
                      <Play className="size-3.5" strokeWidth={1.8} />
                    )}
                    继续录制
                  </Button>
                </div>
              </div>
            </div>
            <div className="min-h-0 flex-1 p-4">
              <div className="flex h-[60vh] min-h-0 flex-col overflow-hidden rounded-xl border border-slate-900/80 bg-[#0b0f14] shadow-[inset_0_1px_0_rgba(255,255,255,0.03)]">
                <div className="flex items-center justify-between border-b border-white/10 bg-[#11161d] px-4 py-2 text-[11px] text-slate-400">
                  <div className="flex min-w-0 items-center gap-2">
                    <span className="truncate font-mono">
                      {selectedEntry?.fileName ?? "playwright.spec.ts"}
                    </span>
                    {detailDirty ? (
                      <span className="rounded-full border border-amber-400/30 bg-amber-400/10 px-2 py-0.5 text-[10px] text-amber-200">
                        未保存
                      </span>
                    ) : null}
                  </div>
                  {detailLoading || isSaveLoading || isContinueLoading ? (
                    <Loader2 className="size-3.5 animate-spin" strokeWidth={1.8} />
                  ) : null}
                </div>
                <div className="h-full  px-4 py-4 font-mono text-[12px] leading-6 text-slate-100">
                  <textarea
                    aria-label="录制脚本编辑器"
                    spellCheck={false}
                    value={detailScript}
                    disabled={detailLoading}
                    onChange={(event) => {
                      const nextScript = event.target.value
                      setDetailScript(nextScript)
                      if (selectedEntry) {
                        saveDetailDraft(selectedEntry.fileName, nextScript, detailInitialScript)
                      }
                    }}
                    className="h-full min-h-[52vh] w-full resize-none border-0 bg-transparent p-0 font-mono text-[12px] leading-6 text-slate-100 outline-none placeholder:text-slate-500 disabled:cursor-wait"
                    placeholder={detailLoading ? "正在读取脚本内容..." : "// Script content"}
                  />
                </div>
              </div>
            </div>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  )
}
