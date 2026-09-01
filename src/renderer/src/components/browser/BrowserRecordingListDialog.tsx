import { useCallback, useEffect, useRef, useState } from "react"
import { flushSync } from "react-dom"
import { Check, Copy, Loader2, Play, RotateCcw, Save, Trash2 } from "lucide-react"
import { toast } from "sonner"
import { Button } from "@/components/ui/button"
import { IconPopoverButton } from "@/components/ui/icon-popover-button"
import { Input } from "@/components/ui/input"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle
} from "@/components/ui/dialog"
import { MAX_BROWSER_SCRIPT_LIBRARY_ENTRIES } from "../../../../shared/browser-types"
import type { BrowserScriptLibraryEntry } from "../../../../shared/browser-types"
import { BrowserScriptEditor } from "./BrowserScriptEditor"

export interface BrowserRecordingListDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  isPlaybackRunning: boolean
  isLoading: boolean
  error: string | null
  entries: BrowserScriptLibraryEntry[]
  loadingFileName: string | null
  loadingAction: "detail" | "execution" | "save" | "saveAs" | "continue" | "delete" | null
  onRefresh: () => void
  onReadScript: (entry: BrowserScriptLibraryEntry) => Promise<string>
  onSaveScript: (
    entry: BrowserScriptLibraryEntry,
    script: string,
    displayName: string
  ) => Promise<void>
  onSaveAsScript: (
    entry: BrowserScriptLibraryEntry,
    script: string,
    displayName: string
  ) => Promise<BrowserScriptLibraryEntry>
  onContinueRecording: (entry: BrowserScriptLibraryEntry, script: string) => Promise<void>
  onExecuteScript: (entry: BrowserScriptLibraryEntry, script: string) => Promise<void>
  onDelete: (entry: BrowserScriptLibraryEntry) => void
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
  initialDisplayName: string
  displayName: string
}

export function BrowserRecordingListDialog({
  open,
  onOpenChange,
  isPlaybackRunning,
  isLoading,
  error,
  entries,
  loadingFileName,
  loadingAction,
  onRefresh,
  onReadScript,
  onSaveScript,
  onSaveAsScript,
  onContinueRecording,
  onExecuteScript,
  onDelete
}: BrowserRecordingListDialogProps): React.JSX.Element {
  const [selectedFileName, setSelectedFileName] = useState<string | null>(null)
  const [detailScript, setDetailScript] = useState("")
  const [detailInitialScript, setDetailInitialScript] = useState("")
  const [detailDisplayName, setDetailDisplayName] = useState("")
  const [detailInitialDisplayName, setDetailInitialDisplayName] = useState("")
  const [detailCopied, setDetailCopied] = useState(false)
  const [detailLoading, setDetailLoading] = useState(false)
  const [currentPage, setCurrentPage] = useState(1)
  const [displayNameFilter, setDisplayNameFilter] = useState("")
  const detailDraftsRef = useRef<Record<string, DetailDraftState>>({})

  const saveDetailDraft = useCallback(
    (
      fileName: string,
      script: string,
      initialScript: string,
      displayName: string,
      initialDisplayName: string
    ): void => {
      detailDraftsRef.current = {
        ...detailDraftsRef.current,
        [fileName]: {
          initialScript,
          script,
          initialDisplayName,
          displayName
        }
      }
    },
    []
  )

  const normalizedDisplayNameFilter = displayNameFilter.trim().toLocaleLowerCase()
  const filteredEntries = entries.filter(
    (entry) =>
      !normalizedDisplayNameFilter ||
      entry.displayName.toLocaleLowerCase().includes(normalizedDisplayNameFilter)
  )
  const totalPages = Math.max(1, Math.ceil(filteredEntries.length / PAGE_SIZE))
  const currentPageSafe = Math.max(1, Math.min(currentPage, totalPages))
  const pageStart = (currentPageSafe - 1) * PAGE_SIZE
  const currentEntries = filteredEntries.slice(pageStart, pageStart + PAGE_SIZE)
  const selectedEntry =
    currentEntries.find((entry) => entry.fileName === selectedFileName) ?? currentEntries[0] ?? null

  useEffect(() => {
    // A continued recording can update the same file while this component stays mounted.
    // Scope drafts to the current list snapshot and open dialog session.
    detailDraftsRef.current = {}
  }, [entries, open])

  useEffect(() => {
    if (!open || !selectedEntry || error || isLoading) return

    const cachedDraft = detailDraftsRef.current[selectedEntry.fileName]
    let cancelled = false

    if (cachedDraft) {
      const cachedDraftTimer = window.setTimeout(() => {
        if (cancelled) return
        setDetailScript(cachedDraft.script)
        setDetailInitialScript(cachedDraft.initialScript)
        setDetailDisplayName(cachedDraft.displayName)
        setDetailInitialDisplayName(cachedDraft.initialDisplayName)
        setDetailCopied(false)
        setDetailLoading(false)
      }, 0)
      return () => {
        cancelled = true
        window.clearTimeout(cachedDraftTimer)
      }
    }

    const loadingTimer = window.setTimeout(() => {
      if (!cancelled) {
        setDetailCopied(false)
        setDetailLoading(true)
      }
    }, 0)

    void onReadScript(selectedEntry)
      .then((script) => {
        if (cancelled) return
        setDetailScript(script)
        setDetailInitialScript(script)
        setDetailDisplayName(selectedEntry.displayName)
        setDetailInitialDisplayName(selectedEntry.displayName)
        saveDetailDraft(
          selectedEntry.fileName,
          script,
          script,
          selectedEntry.displayName,
          selectedEntry.displayName
        )
      })
      .catch(() => {
        // parent callback already reports the failure
      })
      .finally(() => {
        if (!cancelled) setDetailLoading(false)
      })

    return () => {
      cancelled = true
      window.clearTimeout(loadingTimer)
    }
  }, [error, entries, isLoading, onReadScript, open, saveDetailDraft, selectedEntry])

  const handleCopyDetailScript = async (): Promise<void> => {
    if (!detailScriptValue.trim()) return
    try {
      await navigator.clipboard.writeText(detailScriptValue)
      setDetailCopied(true)
      window.setTimeout(() => setDetailCopied(false), 1500)
      toast.success("脚本内容已复制")
    } catch {
      toast.error("复制脚本内容失败")
    }
  }

  const detailViewActive = Boolean(selectedEntry && !error && !isLoading)
  const detailScriptValue = detailViewActive ? detailScript : ""
  const detailDisplayNameValue = detailViewActive ? detailDisplayName : ""
  const detailScriptLineCount =
    detailScriptValue.trim().length > 0 ? detailScriptValue.split(/\r?\n/u).length : 0
  const detailDirty =
    detailViewActive &&
    (detailScript !== detailInitialScript || detailDisplayName !== detailInitialDisplayName)
  const isSaveLoading =
    Boolean(selectedEntry) &&
    loadingFileName === selectedEntry?.fileName &&
    loadingAction === "save"
  const isContinueLoading =
    Boolean(selectedEntry) &&
    loadingFileName === selectedEntry?.fileName &&
    loadingAction === "continue"
  const isSaveAsLoading =
    Boolean(selectedEntry) &&
    loadingFileName === selectedEntry?.fileName &&
    loadingAction === "saveAs"
  const isLibraryFull = entries.length >= MAX_BROWSER_SCRIPT_LIBRARY_ENTRIES

  const handleSaveDetailScript = async (): Promise<void> => {
    const displayName = detailDisplayNameValue.trim()
    if (!selectedEntry || !detailDirty || !detailScriptValue.trim() || !displayName) return
    await onSaveScript(selectedEntry, detailScriptValue, displayName)
    setDetailInitialScript(detailScriptValue)
    setDetailDisplayName(displayName)
    setDetailInitialDisplayName(displayName)
    saveDetailDraft(
      selectedEntry.fileName,
      detailScriptValue,
      detailScriptValue,
      displayName,
      displayName
    )
  }

  const handleSaveAsScript = async (): Promise<void> => {
    const displayName = detailDisplayNameValue.trim()
    if (!selectedEntry || !detailScriptValue.trim() || !displayName) return
    const savedEntry = await onSaveAsScript(selectedEntry, detailScriptValue, displayName)
    setSelectedFileName(savedEntry.fileName)
    setDetailScript(detailScriptValue)
    setDetailInitialScript(detailScriptValue)
    setDetailDisplayName(savedEntry.displayName)
    setDetailInitialDisplayName(savedEntry.displayName)
    saveDetailDraft(
      savedEntry.fileName,
      detailScriptValue,
      detailScriptValue,
      savedEntry.displayName,
      savedEntry.displayName
    )
  }

  const handleContinueRecording = async (): Promise<void> => {
    if (!selectedEntry || !detailScriptValue.trim()) return
    await onContinueRecording(selectedEntry, detailScriptValue)
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[88vh] max-w-[1300px] gap-0 overflow-hidden border-border/70 p-0 shadow-2xl">
        <DialogHeader className="border-b border-border/70 bg-[linear-gradient(180deg,color-mix(in_srgb,var(--primary)_7%,transparent),transparent)] px-5 pt-2 pb-1">
          <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
            <div>
              <DialogTitle className="text-base">录制列表</DialogTitle>
              <p className="mt-0.5 text-[11px] text-muted-foreground">
                已保存 {entries.length}/{MAX_BROWSER_SCRIPT_LIBRARY_ENTRIES} 个录制文件
              </p>
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
          <div className="flex min-h-0 w-full min-w-0 flex-col border-b border-border/70 lg:w-1/2 lg:flex-none lg:border-b-0 lg:border-r">
            <div className="flex min-h-0 flex-1 flex-col overflow-hidden p-5">
              {error ? (
                <div className="rounded-xl border border-status-warning/30 bg-status-warning/10 px-4 py-5 text-sm text-status-warning">
                  {error}
                </div>
              ) : isLoading ? (
                <div className="flex items-center justify-center gap-2 py-12 text-sm text-muted-foreground">
                  <Loader2 className="size-4 animate-spin" strokeWidth={1.8} />
                  正在读取脚本文件...
                </div>
              ) : (
                <div className="flex min-h-0 flex-1 flex-col gap-3">
                  <Input
                    value={displayNameFilter}
                    onChange={(event) => {
                      setDisplayNameFilter(event.target.value)
                      setCurrentPage(1)
                    }}
                    placeholder="输入文件中文名筛选"
                    className="h-9 rounded-lg border-border/80 bg-background text-sm shadow-none"
                  />
                  {isLibraryFull && (
                    <div
                      className="rounded-lg border border-status-warning/30 bg-status-warning/10 px-3 py-2 text-[11px] text-status-warning"
                      role="status"
                    >
                      已达到 {MAX_BROWSER_SCRIPT_LIBRARY_ENTRIES}{" "}
                      个录制文件上限。请删除不需要的文件后再新增。
                    </div>
                  )}
                  {filteredEntries.length === 0 ? (
                    <div className="rounded-xl border border-dashed border-border/80 bg-muted/20 px-4 py-8 text-center text-sm text-muted-foreground">
                      没有匹配当前中文名筛选的脚本。
                    </div>
                  ) : (
                    <>
                      <div className="min-h-0 flex-1 overflow-x-hidden overflow-y-auto rounded-xl border border-border/70">
                        <table className="w-full table-fixed border-collapse text-left text-[12px]">
                          <colgroup>
                            <col />
                            <col className="w-[76px]" />
                            <col className="w-[72px]" />
                            <col className="w-[72px]" />
                            <col className="w-[120px]" />
                          </colgroup>
                          <thead className="sticky top-0 z-10 bg-muted/95 text-[11px] font-medium text-muted-foreground backdrop-blur supports-[backdrop-filter]:bg-muted/85">
                            <tr>
                              <th className="border-b border-border/70 px-2 py-2.5">中文名称</th>
                              <th className="border-b border-border/70 px-2 py-2.5 text-center">
                                存在变量
                              </th>
                              <th className="border-b border-border/70 px-2 py-2.5 text-center">
                                是否编辑
                              </th>
                              <th className="border-b border-border/70 px-2 py-2.5">时间</th>
                              <th className="border-b border-border/70 px-2 py-2.5 text-right">
                                操作
                              </th>
                            </tr>
                          </thead>
                          <tbody>
                            {currentEntries.map((entry) => {
                              const isEntryLoading = loadingFileName === entry.fileName
                              const isExecutionLoading =
                                isEntryLoading && loadingAction === "execution"
                              const isDeleteLoading = isEntryLoading && loadingAction === "delete"
                              const isSelected = selectedFileName === entry.fileName
                              const isEdited =
                                entry.isEdited === true || entry.hasVariables === true

                              return (
                                <tr
                                  key={entry.fileName}
                                  className={[
                                    "cursor-pointer border-b border-border/60 transition-colors last:border-0 hover:bg-primary/5",
                                    isSelected ? "bg-primary/5" : ""
                                  ].join(" ")}
                                  onClick={() => setSelectedFileName(entry.fileName)}
                                >
                                  <td
                                    className="overflow-hidden px-2 py-3 align-middle font-medium text-foreground"
                                    title={entry.displayName}
                                  >
                                    <span className="block truncate">{entry.displayName}</span>
                                  </td>
                                  <td
                                    className="px-2 py-3 text-center align-middle text-[11px]"
                                    title={
                                      entry.hasVariables === undefined
                                        ? "无法读取脚本内容"
                                        : entry.hasVariables
                                          ? "存在变量"
                                          : "不存在变量"
                                    }
                                  >
                                    {entry.hasVariables === undefined ? (
                                      <span className="text-muted-foreground">未知</span>
                                    ) : entry.hasVariables ? (
                                      <span className="text-emerald-500">有</span>
                                    ) : (
                                      <span className="text-muted-foreground">无</span>
                                    )}
                                  </td>
                                  <td
                                    className="px-2 py-3 text-center align-middle text-[11px]"
                                    title={isEdited ? "用户编辑过脚本或设置过变量" : "未编辑"}
                                  >
                                    {isEdited ? (
                                      <span className="text-emerald-500">是</span>
                                    ) : (
                                      <span className="text-muted-foreground">否</span>
                                    )}
                                  </td>
                                  <td
                                    className="truncate px-2 py-3 align-middle text-[11px] text-muted-foreground"
                                    title={entry.createdAt}
                                  >
                                    {formatRecordingTime(entry.createdAt)}
                                  </td>
                                  <td className="px-2 py-3 align-middle">
                                    <div className="flex justify-end gap-1">
                                      <IconPopoverButton
                                        icon={
                                          isExecutionLoading ? (
                                            <Loader2
                                              className="size-3.5 animate-spin"
                                              strokeWidth={1.8}
                                            />
                                          ) : (
                                            <Play className="size-3.5" strokeWidth={1.8} />
                                          )
                                        }
                                        popoverContent="内置浏览器执行"
                                        disabled={isEntryLoading || isPlaybackRunning}
                                        stopPropagation
                                        className="size-7 rounded-md"
                                        onClick={async () => {
                                          flushSync(() => onOpenChange(false))
                                          try {
                                            const script =
                                              selectedEntry?.fileName === entry.fileName &&
                                              !detailLoading
                                                ? detailScriptValue
                                                : await onReadScript(entry)
                                            await onExecuteScript(entry, script)
                                          } catch {
                                            // Parent handlers already surface the error.
                                          }
                                        }}
                                      />
                                      <IconPopoverButton
                                        icon={
                                          isDeleteLoading ? (
                                            <Loader2
                                              className="size-3.5 animate-spin"
                                              strokeWidth={1.8}
                                            />
                                          ) : (
                                            <Trash2 className="size-3.5" strokeWidth={1.8} />
                                          )
                                        }
                                        popoverContent="删除脚本"
                                        disabled={isEntryLoading}
                                        stopPropagation
                                        className="size-7 rounded-md"
                                        onClick={() => {
                                          onDelete(entry)
                                        }}
                                      />
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
                          共 {filteredEntries.length}/{entries.length} 条，当前第 {currentPageSafe}/
                          {totalPages} 页
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
                    </>
                  )}
                </div>
              )}
            </div>
          </div>

          <div className="flex min-h-0 w-full min-w-0 flex-col lg:w-1/2 lg:flex-none">
            <div className="border-b border-border/70 px-5 py-4">
              <div className="flex flex-col gap-3">
                <div className="flex-1 min-w-0">
                  <DialogTitle className="text-base">编辑录制脚本</DialogTitle>
                  <DialogDescription className="mt-1 text-[12px] leading-5">
                    {selectedEntry
                      ? "可编辑脚本内容和文件中文名；保存修改会更新当前文件，另存为会创建新的脚本文件。"
                      : "请选择一条录制查看脚本。"}
                  </DialogDescription>
                </div>
                {selectedEntry ? (
                  <div className="flex flex-wrap items-center gap-2">
                    <label
                      htmlFor="browser-script-library-display-name"
                      className="shrink-0 text-xs font-medium text-foreground"
                    >
                      文件中文名
                    </label>
                    <Input
                      id="browser-script-library-display-name"
                      value={detailDisplayNameValue}
                      disabled={
                        !detailViewActive ||
                        detailLoading ||
                        isSaveLoading ||
                        isSaveAsLoading ||
                        isContinueLoading
                      }
                      onChange={(event) => {
                        const nextDisplayName = event.target.value
                        setDetailDisplayName(nextDisplayName)
                        saveDetailDraft(
                          selectedEntry.fileName,
                          detailScript,
                          detailInitialScript,
                          nextDisplayName,
                          detailInitialDisplayName
                        )
                      }}
                      placeholder="请输入文件中文名"
                      className="h-8 w-[240px] rounded-lg border-border/80 bg-background text-xs shadow-none"
                    />
                    <Button
                      type="button"
                      size="sm"
                      variant="outline"
                      className="h-8 rounded-lg text-[11px]"
                      disabled={
                        !selectedEntry ||
                        !detailDirty ||
                        !detailScriptValue.trim() ||
                        !detailDisplayNameValue.trim() ||
                        detailLoading ||
                        isSaveAsLoading ||
                        isContinueLoading
                      }
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
                      variant="outline"
                      className="h-8 rounded-lg text-[11px]"
                      disabled={
                        !selectedEntry ||
                        !detailScriptValue.trim() ||
                        !detailDisplayNameValue.trim() ||
                        detailLoading ||
                        isSaveLoading ||
                        isSaveAsLoading ||
                        isContinueLoading ||
                        isLibraryFull
                      }
                      onClick={() => void handleSaveAsScript()}
                    >
                      {isSaveAsLoading ? (
                        <Loader2 className="size-3.5 animate-spin" strokeWidth={1.8} />
                      ) : (
                        <Copy className="size-3.5" strokeWidth={1.8} />
                      )}
                      另存为
                    </Button>
                    <Button
                      type="button"
                      size="sm"
                      className="h-8 rounded-lg text-[11px]"
                      disabled={
                        !selectedEntry ||
                        !detailScriptValue.trim() ||
                        detailLoading ||
                        isSaveLoading ||
                        isSaveAsLoading
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
                ) : null}
              </div>
            </div>
            <div className="min-h-0 flex-1 p-4">
              <BrowserScriptEditor
                className="h-[60vh] min-h-[420px]"
                textareaClassName="disabled:cursor-wait"
                title={
                  <div className="flex min-w-0 items-center gap-2">
                    <span className="truncate font-mono">
                      {selectedEntry?.fileName ?? "playwright.spec.ts"}
                    </span>
                    {detailDirty ? (
                      <span className="rounded-full border border-status-warning/30 bg-status-warning/10 px-2 py-0.5 text-[10px] text-status-warning-foreground">
                        未保存
                      </span>
                    ) : null}
                  </div>
                }
                headerRight={
                  detailLoading || isSaveLoading || isSaveAsLoading || isContinueLoading ? (
                    <Loader2 className="size-3.5 animate-spin" strokeWidth={1.8} />
                  ) : (
                    <div className="flex shrink-0 items-center gap-2">
                      <span className="font-mono tabular-nums text-[11px] text-muted-foreground">
                        {detailScriptLineCount > 0 ? `${detailScriptLineCount} lines` : "waiting"}
                      </span>
                      <Button
                        type="button"
                        size="icon"
                        variant="ghost"
                        className="size-6 rounded-md text-muted-foreground hover:bg-foreground/5 hover:text-foreground"
                        disabled={!detailViewActive || !detailScriptValue.trim()}
                        onClick={() => void handleCopyDetailScript()}
                      >
                        {detailCopied ? (
                          <Check className="size-3.5" strokeWidth={1.8} />
                        ) : (
                          <Copy className="size-3.5" strokeWidth={1.8} />
                        )}
                      </Button>
                    </div>
                  )
                }
                value={detailScriptValue}
                disabled={!detailViewActive || detailLoading}
                onChange={(nextScript) => {
                  setDetailScript(nextScript)
                  if (selectedEntry) {
                    saveDetailDraft(
                      selectedEntry.fileName,
                      nextScript,
                      detailInitialScript,
                      detailDisplayName,
                      detailInitialDisplayName
                    )
                  }
                }}
                ariaLabel="录制脚本编辑器"
                placeholder={detailLoading ? "正在读取脚本内容..." : "// Script content"}
              />
            </div>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  )
}
