import { useEffect, useMemo, useRef, useState } from "react"
import { AlertTriangle, ChevronDown, ChevronRight, FileText, Folder, Loader2, Undo2 } from "lucide-react"
import { Dialog, DialogContent } from "@/components/ui/dialog"
import { Button } from "@/components/ui/button"
import { cn } from "@/lib/utils"

type GitPanelFileStatus = "added" | "modified" | "deleted" | "renamed" | "copied" | "untracked"

export interface GitRejectFile {
  path: string
  previousPath?: string
  status?: GitPanelFileStatus
  additions: number
  deletions: number
}

interface GitRejectDialogProps {
  open: boolean
  running: boolean
  loading?: boolean
  selectionSeed?: number
  files: GitRejectFile[]
  omittedFileCount?: number
  onOpenChange: (open: boolean) => void
  onSubmit: (filePaths: string[]) => void
}

function getPathParentDir(filePath: string): string {
  const normalized = filePath.replace(/\\/g, "/")
  const index = normalized.lastIndexOf("/")
  return index >= 0 ? normalized.slice(0, index) : ""
}

function getPathBaseName(filePath: string): string {
  const normalized = filePath.replace(/\\/g, "/")
  const index = normalized.lastIndexOf("/")
  return index >= 0 ? normalized.slice(index + 1) : normalized
}

function getStatusLabel(
  status?: GitPanelFileStatus,
  filePath?: string,
  previousPath?: string
): string {
  switch (status) {
    case "added":
    case "untracked":
      return "新增"
    case "deleted":
      return "删除"
    case "renamed":
      return getPathParentDir(filePath || "") === getPathParentDir(previousPath || "")
        ? "改名"
        : "移动"
    case "copied":
      return "复制"
    case "modified":
    default:
      return "修改"
  }
}

function getStatusClassName(status?: GitPanelFileStatus): string {
  switch (status) {
    case "added":
    case "untracked":
      return "border-emerald-500/35 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300"
    case "deleted":
      return "border-rose-500/35 bg-rose-500/10 text-rose-700 dark:text-rose-300"
    case "renamed":
      return "border-blue-500/35 bg-blue-500/10 text-blue-700 dark:text-blue-300"
    case "copied":
      return "border-cyan-500/35 bg-cyan-500/10 text-cyan-700 dark:text-cyan-300"
    case "modified":
    default:
      return "border-border bg-background text-muted-foreground"
  }
}

export function GitRejectDialog({
  open,
  running,
  loading = false,
  selectionSeed = 0,
  files,
  omittedFileCount = 0,
  onOpenChange,
  onSubmit
}: GitRejectDialogProps): React.JSX.Element {
  const [selectedPaths, setSelectedPaths] = useState<Set<string>>(new Set())
  const [collapsedFolders, setCollapsedFolders] = useState<Set<string>>(new Set())
  const wasOpenRef = useRef(false)
  const lastSelectionSeedRef = useRef(selectionSeed)

  useEffect(() => {
    const timer = window.setTimeout(() => {
      const filePathSet = new Set(files.map((file) => file.path))
      if (!open) {
        wasOpenRef.current = false
        lastSelectionSeedRef.current = selectionSeed
        return
      }
      if (!wasOpenRef.current || lastSelectionSeedRef.current !== selectionSeed) {
        setSelectedPaths(filePathSet)
        setCollapsedFolders(new Set())
      } else {
        setSelectedPaths((prev) => new Set([...prev].filter((filePath) => filePathSet.has(filePath))))
        setCollapsedFolders((prev) => {
          const next = new Set(prev)
          const folders = new Set(files.map((file) => getPathParentDir(file.path)))
          for (const folder of next) {
            if (!folders.has(folder)) next.delete(folder)
          }
          return next
        })
      }
      lastSelectionSeedRef.current = selectionSeed
      wasOpenRef.current = true
    }, 0)
    return () => {
      window.clearTimeout(timer)
    }
  }, [open, files, selectionSeed])

  const groupedFiles = useMemo(() => {
    const map = new Map<string, GitRejectFile[]>()
    for (const file of files) {
      const folder = getPathParentDir(file.path)
      const list = map.get(folder) ?? []
      list.push(file)
      map.set(folder, list)
    }

    return Array.from(map.entries())
      .map(([folder, groupFiles]) => ({
        folder,
        files: groupFiles.slice().sort((a, b) => getPathBaseName(a.path).localeCompare(getPathBaseName(b.path)))
      }))
      .sort((a, b) => {
        if (!a.folder && b.folder) return -1
        if (a.folder && !b.folder) return 1
        return a.folder.localeCompare(b.folder)
      })
  }, [files])

  const selectedFiles = useMemo(
    () => files.filter((file) => selectedPaths.has(file.path)),
    [files, selectedPaths]
  )
  const selectedTotals = selectedFiles.reduce(
    (acc, file) => {
      acc.additions += file.additions
      acc.deletions += file.deletions
      return acc
    },
    { additions: 0, deletions: 0 }
  )
  const allSelected = files.length > 0 && selectedPaths.size === files.length
  const noSelection = selectedFiles.length === 0
  const hasOmittedFiles = omittedFileCount > 0

  const toggleAll = (): void => {
    setSelectedPaths(allSelected ? new Set() : new Set(files.map((file) => file.path)))
  }

  const toggleGroup = (groupFiles: GitRejectFile[]): void => {
    setSelectedPaths((prev) => {
      const next = new Set(prev)
      const groupFullySelected = groupFiles.every((file) => next.has(file.path))
      for (const file of groupFiles) {
        if (groupFullySelected) {
          next.delete(file.path)
        } else {
          next.add(file.path)
        }
      }
      return next
    })
  }

  const toggleFile = (filePath: string): void => {
    setSelectedPaths((prev) => {
      const next = new Set(prev)
      if (next.has(filePath)) {
        next.delete(filePath)
      } else {
        next.add(filePath)
      }
      return next
    })
  }

  const toggleFolderCollapsed = (folder: string): void => {
    setCollapsedFolders((prev) => {
      const next = new Set(prev)
      if (next.has(folder)) {
        next.delete(folder)
      } else {
        next.add(folder)
      }
      return next
    })
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(nextOpen) => {
        if (!running) onOpenChange(nextOpen)
      }}
    >
      <DialogContent className="sm:max-w-2xl rounded-2xl border border-border bg-background p-0 shadow-xl">
        <div className="px-5 py-4 border-b border-border/70">
          <div className="flex items-center gap-2 text-[16px] font-semibold">
            <Undo2 className="size-4 text-destructive" />
            选择要回退的文件
          </div>
        </div>

        <div className="px-5 pt-4">
          <div className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-border/70 bg-muted/20 px-3 py-2">
            <label className="inline-flex min-w-0 items-center gap-2 text-xs font-medium">
              <input
                type="checkbox"
                checked={allSelected}
                disabled={running || loading || files.length === 0}
                onChange={toggleAll}
                className="size-3.5 shrink-0 accent-blue-600"
              />
              <span>全选</span>
            </label>
            <div className="text-xs text-muted-foreground">
              {loading ? (
                <span className="inline-flex items-center gap-1.5">
                  <Loader2 className="size-3 animate-spin" />
                  加载完整列表...
                </span>
              ) : (
                <>
                  已选择{" "}
                  <span className="font-semibold text-foreground">{selectedFiles.length}</span> /{" "}
                  {files.length} 个文件
                </>
              )}
              <span className="ml-2 text-emerald-600 dark:text-emerald-400">
                +{selectedTotals.additions}
              </span>
              <span className="ml-1 text-rose-600 dark:text-rose-400">
                -{selectedTotals.deletions}
              </span>
            </div>
          </div>

          {hasOmittedFiles && (
            <div className="mt-3 flex items-start gap-2 rounded-md border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-xs text-amber-800 dark:text-amber-200">
              <AlertTriangle className="mt-0.5 size-3.5 shrink-0" />
              <span>当前只列出已加载的文件，另有 {omittedFileCount} 个文件未显示，暂不能执行全部回退。</span>
            </div>
          )}
        </div>

        <div className="max-h-[52vh] overflow-y-auto px-5 py-4">
          <div className="space-y-3">
            {groupedFiles.map((group) => {
              const selectedInGroup = group.files.filter((file) => selectedPaths.has(file.path)).length
              const groupSelected = selectedInGroup === group.files.length
              const groupCollapsed = collapsedFolders.has(group.folder)
              return (
                <section
                  key={group.folder || "__root__"}
                  className="overflow-hidden rounded-md border border-border/80 bg-background shadow-sm"
                >
                  <div className="flex items-center justify-between gap-3 border-b border-border/80 bg-muted/45 px-3 py-2.5">
                    <label className="inline-flex min-w-0 flex-1 items-center gap-2 text-xs font-semibold">
                      <input
                        type="checkbox"
                        checked={groupSelected}
                        disabled={running || loading}
                        onChange={() => toggleGroup(group.files)}
                        className="size-3.5 shrink-0 accent-blue-600"
                      />
                      <button
                        type="button"
                        className="flex size-5 shrink-0 items-center justify-center rounded text-muted-foreground transition-colors hover:bg-background/80 hover:text-foreground"
                        aria-label={groupCollapsed ? "展开目录" : "折叠目录"}
                        aria-expanded={!groupCollapsed}
                        onClick={(event) => {
                          event.preventDefault()
                          event.stopPropagation()
                          toggleFolderCollapsed(group.folder)
                        }}
                      >
                        {groupCollapsed ? (
                          <ChevronRight className="size-3.5" />
                        ) : (
                          <ChevronDown className="size-3.5" />
                        )}
                      </button>
                      <span className="flex size-6 shrink-0 items-center justify-center rounded-md border border-blue-500/25 bg-blue-500/10">
                        <Folder className="size-3.5 text-blue-700 dark:text-blue-300" />
                      </span>
                      <span className="shrink-0 rounded border border-border/70 bg-background/80 px-1.5 py-0.5 text-[10px] font-medium leading-none text-muted-foreground">
                        目录
                      </span>
                      <span className="truncate font-mono text-foreground" title={group.folder || "根目录"}>
                        {group.folder || "./"}
                      </span>
                    </label>
                    <span className="shrink-0 rounded-full border border-border/70 bg-background/80 px-2 py-0.5 text-[11px] font-medium text-muted-foreground">
                      {selectedInGroup}/{group.files.length}
                    </span>
                  </div>
                  <div className={cn("divide-y divide-border/60 bg-background", groupCollapsed && "hidden")}>
                    {group.files.map((file) => {
                      const selected = selectedPaths.has(file.path)
                      return (
                        <label
                          key={file.path}
                          className={cn(
                            "relative flex min-w-0 items-center gap-2 py-2 pl-8 pr-3 text-xs transition-colors",
                            "before:absolute before:left-[22px] before:top-0 before:h-full before:w-px before:bg-border/70",
                            !running && "cursor-pointer hover:bg-muted/20",
                            selected ? "bg-background" : "bg-muted/10 text-muted-foreground"
                          )}
                        >
                          <input
                            type="checkbox"
                            checked={selected}
                            disabled={running || loading}
                            onChange={() => toggleFile(file.path)}
                            className="size-3.5 shrink-0 accent-blue-600"
                          />
                          <span className="relative z-10 flex size-5 shrink-0 items-center justify-center rounded border border-border bg-background">
                            <FileText className="size-3 text-muted-foreground" />
                          </span>
                          <span
                            className={cn(
                              "shrink-0 rounded border px-1.5 py-0.5 text-[10px] font-medium leading-none",
                              getStatusClassName(file.status)
                            )}
                          >
                            {getStatusLabel(file.status, file.path, file.previousPath)}
                          </span>
                          <span className="min-w-0 flex-1">
                            <span className="block truncate font-mono text-foreground" title={file.path}>
                              {getPathBaseName(file.path)}
                            </span>
                            {file.previousPath && (
                              <span className="block truncate font-mono text-[11px] text-muted-foreground" title={file.previousPath}>
                                {file.previousPath}
                              </span>
                            )}
                          </span>
                          <span className="shrink-0 font-semibold">
                            <span className="text-emerald-600 dark:text-emerald-400">+{file.additions}</span>
                            <span className="mx-1 text-muted-foreground">/</span>
                            <span className="text-rose-600 dark:text-rose-400">-{file.deletions}</span>
                          </span>
                        </label>
                      )
                    })}
                  </div>
                </section>
              )
            })}
          </div>
        </div>

        <div className="border-t border-border/70 px-5 py-4">
          <div className="mb-3 flex items-start gap-2 rounded-md border border-destructive/30 bg-destructive/5 px-3 py-2 text-xs text-destructive">
            <AlertTriangle className="mt-0.5 size-3.5 shrink-0" />
            <span>
              回退会回退全部变更，不会回退到大模型的上一次修改，请确认是否回退。此操作不可撤销。
            </span>
          </div>
          <div className="flex flex-col gap-2 sm:flex-row sm:justify-end">
            <Button
              type="button"
              variant="ghost"
              disabled={running}
              onClick={() => onOpenChange(false)}
            >
              取消
            </Button>
            <Button
              type="button"
              variant="destructive"
              disabled={running || loading || noSelection || hasOmittedFiles}
              onClick={() => {
                onSubmit(
                  selectedFiles.flatMap((file) =>
                    file.previousPath ? [file.previousPath, file.path] : [file.path]
                  )
                )
              }
              }
            >
              {running ? (
                <>
                  <Loader2 className="size-4 animate-spin" />
                  回退中...
                </>
              ) : (
                <>
                  <Undo2 className="size-4" />
                  确认回退
                </>
              )}
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  )
}
