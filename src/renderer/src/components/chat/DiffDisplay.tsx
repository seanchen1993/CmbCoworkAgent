import { GitCommit, Maximize2, Minimize2, Eye, Minus, Plus } from "lucide-react"
import { memo, useEffect, useState } from "react"
import { cn } from "@/lib/utils"

type DiffViewerModule = typeof import("react-diff-viewer-continued")

let diffViewerModulePromise: Promise<DiffViewerModule> | null = null

function loadDiffViewerModule(): Promise<DiffViewerModule> {
  if (!diffViewerModulePromise) {
    diffViewerModulePromise = import("react-diff-viewer-continued")
  }
  return diffViewerModulePromise
}

export interface DiffDisplayProps {
  diff?: string
  oldValue?: string
  newValue?: string
  filePath?: string
}

export const DiffDisplay = memo(({ diff, oldValue, newValue, filePath }: DiffDisplayProps) => {
  const [isFullscreen, setIsFullscreen] = useState(false)
  const [diffViewerModule, setDiffViewerModule] = useState<DiffViewerModule | null>(null)
  const [diffViewerLoadError, setDiffViewerLoadError] = useState<string | null>(null)

  useEffect(() => {
    if (diffViewerModule) return
    let cancelled = false

    loadDiffViewerModule()
      .then((module) => {
        if (!cancelled) {
          setDiffViewerModule(module)
        }
      })
      .catch((error) => {
        if (!cancelled) {
          setDiffViewerLoadError(error instanceof Error ? error.message : String(error))
        }
      })

    return () => {
      cancelled = true
    }
  }, [diffViewerModule])

  const diffToUse = diff || ""

  // Parse git diff to extract old and new content
  const parseGitDiff = (diffText: string) => {
    const lines = diffText.split("\n")
    let oldContent = ""
    let newContent = ""
    let inHunk = false
    let totalLines = 0
    let addedLines = 0
    let removedLines = 0

    for (const line of lines) {
      if (line.startsWith("@@")) {
        inHunk = true
        continue
      }
      if (inHunk) {
        totalLines++
        if (line.startsWith("-")) {
          oldContent += line.substring(1) + "\n"
          removedLines++
        } else if (line.startsWith("+")) {
          newContent += line.substring(1) + "\n"
          addedLines++
        } else if (line.startsWith(" ")) {
          oldContent += line.substring(1) + "\n"
          newContent += line.substring(1) + "\n"
        }
      }
    }

    return {
      oldContent: oldContent.trim(),
      newContent: newContent.trim(),
      totalLines,
      addedLines,
      removedLines
    }
  }

  const { oldContent, newContent, totalLines, addedLines, removedLines } = parseGitDiff(diffToUse)
  const sourceOldContent = oldValue ?? oldContent
  const sourceNewContent = newValue ?? newContent

  const isLargeDiff = totalLines > 100
  const maxPreviewLines = 20

  const getPreviewContent = (content: string, maxLines: number) => {
    const lines = content.split("\n")
    if (lines.length <= maxLines) return content
    return lines.slice(0, maxLines).join("\n")
  }

  const shouldUsePreview = isLargeDiff
  const displayOldContent = shouldUsePreview
    ? getPreviewContent(sourceOldContent, maxPreviewLines)
    : sourceOldContent
  const displayNewContent = shouldUsePreview
    ? getPreviewContent(sourceNewContent, maxPreviewLines)
    : sourceNewContent

  const DiffViewerComponent = diffViewerModule?.default
  const DiffMethod = diffViewerModule?.DiffMethod

  const makeDiffViewer = (fullscreen: boolean) => {
    const viewerUsesPreview = !fullscreen && shouldUsePreview
    const viewerOldValue = fullscreen ? sourceOldContent : displayOldContent
    const viewerNewValue = fullscreen ? sourceNewContent : displayNewContent

    return !DiffViewerComponent || !DiffMethod ? (
      <div className="flex min-h-[120px] items-center justify-center px-4 py-6 text-xs text-muted-foreground">
        {diffViewerLoadError
          ? `Diff 组件加载失败：${diffViewerLoadError}`
          : "正在加载 Diff 组件..."}
      </div>
    ) : (
      <DiffViewerComponent
        oldValue={viewerOldValue}
        newValue={viewerNewValue}
        splitView={fullscreen}
        hideLineNumbers={!fullscreen}
        renderGutter={
          !fullscreen
            ? (data) => {
                const { lineNumber, additionalLineNumber, type, styles } = data
                const displayLineNumber = lineNumber ?? additionalLineNumber
                const added = type === 1
                const removed = type === 2
                const changed = type === 3

                return (
                  <td
                    className={cn(
                      styles.gutter,
                      !displayLineNumber && styles.emptyGutter,
                      added && styles.diffAdded,
                      removed && styles.diffRemoved,
                      changed && styles.diffChanged
                    )}
                  >
                    <pre className={styles.lineNumber}>{displayLineNumber ?? ""}</pre>
                  </td>
                )
              }
            : undefined
        }
        useDarkTheme={false}
        loadingElement={() => (
          <div className="flex items-center justify-center gap-2 py-6 text-sm text-muted-foreground">
            <div className="size-3 rounded-full bg-primary/40 animate-pulse" />
            加载中…
          </div>
        )}
        disableWordDiff={viewerUsesPreview}
        compareMethod={viewerUsesPreview ? DiffMethod.LINES : DiffMethod.WORDS}
        styles={{
          variables: {
            light: {
              diffViewerBackground: "#ffffff",
              diffViewerColor: "#292524",
              addedBackground: "#dcfce7",
              addedColor: "#166534",
              removedBackground: "#fee2e2",
              removedColor: "#991b1b",
              wordAddedBackground: "#bbf7d0",
              wordRemovedBackground: "#fecaca",
              addedGutterBackground: "#bbf7d0",
              removedGutterBackground: "#fecaca",
              gutterBackground: "#FAF9F6",
              gutterBackgroundDark: "#F0EEE9",
              highlightBackground: "#fef9c3",
              highlightGutterBackground: "#fef08a",
              codeFoldGutterBackground: "#F5F3EF",
              codeFoldBackground: "#F5F3EF",
              emptyLineBackground: "#F5F3EF",
              gutterColor: "#A8A29E",
              addedGutterColor: "#16a34a",
              removedGutterColor: "#dc2626",
              codeFoldContentColor: "#A8A29E",
              diffViewerTitleBackground: "#F0EEE9",
              diffViewerTitleColor: "#44403C",
              diffViewerTitleBorderColor: "#EEECE7"
            }
          },
          diffContainer: {
            width: "100%",
            minWidth: "100%",
            maxWidth: "100%",
            maxHeight: fullscreen ? "100%" : "22rem",
            minHeight: fullscreen ? "100%" : "80px",
            overflow: "auto",
            overflowX: "hidden",
            height: fullscreen ? "100%" : undefined,
            borderRadius: "0",
            pre: {
              width: "100%",
              whiteSpace: "pre-wrap",
              overflowWrap: "anywhere",
              wordBreak: "break-word"
            }
          },
          content: {
            width: "100%",
            maxWidth: "100%"
          },
          line: {
            lineHeight: "1.65",
            fontSize: "0.75rem"
          },
          contentText: {
            fontFamily: "'Consolas', 'JetBrains Mono', 'Fira Code', monospace"
            // fontSize: "0.75rem",
          },
          gutter: {
            minWidth: "2.5rem",
            padding: "0 0.5rem"
          }
        }}
      />
    )
  }

  return (
    <>
      {/* Header toolbar */}
      <div className="flex items-center justify-between gap-2 px-3 py-2 bg-muted/60 border-b border-border">
        {/* Left: icon + title + stats */}
        <div className="flex items-center gap-2 min-w-0">
          <GitCommit className="size-3.5 text-muted-foreground shrink-0" />
          <span className="text-[11px] font-semibold text-foreground tracking-wide truncate">
            变更预览
          </span>
          {(addedLines > 0 || removedLines > 0) && (
            <div className="flex items-center gap-1">
              {addedLines > 0 && (
                <span className="inline-flex items-center gap-0.5 text-[10px] font-medium px-1.5 py-0.5 rounded-full bg-green-100 text-green-700 dark:bg-green-950 dark:text-green-400">
                  <Plus className="size-2.5" />
                  {addedLines}
                </span>
              )}
              {removedLines > 0 && (
                <span className="inline-flex items-center gap-0.5 text-[10px] font-medium px-1.5 py-0.5 rounded-full bg-red-100 text-red-700 dark:bg-red-950 dark:text-red-400">
                  <Minus className="size-2.5" />
                  {removedLines}
                </span>
              )}
              {isLargeDiff && (
                <span className="text-[10px] text-muted-foreground">共 {totalLines} 行</span>
              )}
            </div>
          )}
        </div>

        {/* Right: controls */}
        <div className="flex items-center gap-1 shrink-0">
          <button
            onClick={() => setIsFullscreen(true)}
            className="inline-flex items-center justify-center text-[10px] font-medium cursor-pointer px-1.5 py-1 rounded bg-background hover:bg-accent/20 border border-border text-muted-foreground hover:text-foreground transition-colors"
            title="全屏查看"
            aria-label="全屏查看"
          >
            <Maximize2 className="size-2.5" />
          </button>
        </div>
      </div>

      {shouldUsePreview && (
        <div className="flex items-center justify-between gap-2 border-b border-amber-200 bg-amber-50 px-3 py-1.5 text-xs text-amber-700 dark:border-amber-800 dark:bg-amber-950/60 dark:text-amber-300">
          <span>
            当前仅展示前 {maxPreviewLines} 行，共 {totalLines} 行
          </span>
          <button
            type="button"
            onClick={() => setIsFullscreen(true)}
            className="inline-flex items-center gap-1 rounded border border-amber-300/80 bg-background px-2 py-1 text-[11px] font-medium text-amber-700 transition-colors hover:bg-amber-100/60 dark:border-amber-700 dark:text-amber-200 dark:hover:bg-amber-900/50"
          >
            <Eye className="size-3" />
            查看全部
          </button>
        </div>
      )}

      {/* Diff content */}
      <div
        className="relative font-mono bg-white overflow-auto w-full"
        style={{ maxHeight: "22rem", minHeight: "5rem" }}
      >
        {makeDiffViewer(false)}
      </div>

      {/* Fullscreen modal */}
      {isFullscreen && (
        <div
          className="fixed inset-0 z-50 flex flex-col bg-background/98 backdrop-blur-sm"
          style={{ marginTop: "40px" }}
        >
          {/* Modal header */}
          <div className="flex items-center justify-between px-4 py-3 border-b border-border bg-muted/40 shrink-0">
            <div className="flex items-center gap-3">
              <div className="min-w-0 flex items-center gap-2">
                {filePath && (
                  <div
                    className="mt-1 max-w-[60vw] truncate font-mono text-sm font-semibold"
                    title={filePath}
                  >
                    {filePath}
                  </div>
                )}
              </div>
              <div className="flex items-center gap-1.5">
                {addedLines > 0 && (
                  <span className="inline-flex items-center gap-0.5 text-[11px] font-medium px-2 py-0.5 rounded-full bg-green-100 text-green-700 dark:bg-green-950 dark:text-green-400">
                    <Plus className="size-3" />
                    {addedLines} 行新增
                  </span>
                )}
                {removedLines > 0 && (
                  <span className="inline-flex items-center gap-0.5 text-[11px] font-medium px-2 py-0.5 rounded-full bg-red-100 text-red-700 dark:bg-red-950 dark:text-red-400">
                    <Minus className="size-3" />
                    {removedLines} 行删除
                  </span>
                )}
                <span className="text-xs text-muted-foreground">共 {totalLines} 行</span>
              </div>
            </div>
            <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={() => {
                  setIsFullscreen(false)
                }}
                className="inline-flex items-center gap-1.5 cursor-pointer px-3 py-1.5 text-xs font-medium hover:bg-muted border border-border rounded transition-colors"
                title="退出全屏"
              >
                <Minimize2 className="size-3" />
                退出全屏
              </button>
            </div>
          </div>

          {/* Modal content */}
          <div className="flex-1 overflow-hidden p-4">
            <div className="h-full rounded-md border border-border overflow-auto bg-white font-mono text-xs">
              {makeDiffViewer(true)}
            </div>
          </div>
        </div>
      )}
    </>
  )
})

DiffDisplay.displayName = "DiffDisplay"
