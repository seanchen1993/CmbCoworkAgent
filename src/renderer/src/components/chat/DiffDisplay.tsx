import { GitCommit, Maximize2, Minimize2, Eye, Minus, Plus } from "lucide-react"
import { memo, useEffect, useMemo, useState, useSyncExternalStore } from "react"
import { VirtualList } from "@/components/ui/virtual-list"
import { cn } from "@/lib/utils"
import { buildLineDiffRows, type DiffRow } from "@/lib/diff-utils"
import { DEFAULT_THEME_ID, getThemeDefinition } from "@/lib/theme-registry"
import { getThemePreference, subscribeThemePreference } from "@/lib/theme-preference"

type DiffViewerModule = typeof import("react-diff-viewer-continued")

let diffViewerModulePromise: Promise<DiffViewerModule> | null = null

/** Fixed row height for virtualized diff (matched to leading-5 = 20px). */
const DIFF_ROW_HEIGHT = 20
/** Diff lines exceeding this threshold switch to virtualized rendering in fullscreen. */
const VIRTUALIZED_DIFF_LINE_THRESHOLD = 200

const DIFF_VIEWER_THEME_VARIABLES = {
  diffViewerBackground: "var(--background-elevated)",
  diffViewerColor: "var(--foreground)",
  addedBackground:
    "light-dark(color-mix(in lab, var(--background-elevated) 88%, var(--status-nominal)), color-mix(in lab, var(--background-elevated) 80%, var(--status-nominal)))",
  addedColor: "var(--foreground)",
  removedBackground:
    "light-dark(color-mix(in lab, var(--background-elevated) 88%, var(--status-critical)), color-mix(in lab, var(--background-elevated) 80%, var(--status-critical)))",
  removedColor: "var(--foreground)",
  changedBackground:
    "light-dark(color-mix(in lab, var(--background-elevated) 88%, var(--status-warning)), color-mix(in lab, var(--background-elevated) 80%, var(--status-warning)))",
  wordAddedBackground:
    "light-dark(color-mix(in lab, var(--background-elevated) 72%, var(--status-nominal)), color-mix(in lab, var(--background-elevated) 64%, var(--status-nominal)))",
  wordRemovedBackground:
    "light-dark(color-mix(in lab, var(--background-elevated) 72%, var(--status-critical)), color-mix(in lab, var(--background-elevated) 64%, var(--status-critical)))",
  addedGutterBackground:
    "light-dark(color-mix(in lab, var(--background) 82%, var(--status-nominal)), color-mix(in lab, var(--background) 70%, var(--status-nominal)))",
  removedGutterBackground:
    "light-dark(color-mix(in lab, var(--background) 82%, var(--status-critical)), color-mix(in lab, var(--background) 70%, var(--status-critical)))",
  gutterBackground: "var(--background)",
  gutterBackgroundDark: "var(--background-interactive)",
  highlightBackground:
    "light-dark(color-mix(in lab, var(--background-elevated) 82%, var(--status-warning)), color-mix(in lab, var(--background-elevated) 72%, var(--status-warning)))",
  highlightGutterBackground:
    "light-dark(color-mix(in lab, var(--background) 74%, var(--status-warning)), color-mix(in lab, var(--background) 64%, var(--status-warning)))",
  codeFoldGutterBackground: "var(--background-interactive)",
  codeFoldBackground: "var(--background-interactive)",
  emptyLineBackground: "var(--background)",
  gutterColor: "var(--tertiary-foreground)",
  addedGutterColor: "var(--status-nominal-foreground)",
  removedGutterColor: "var(--status-critical-foreground)",
  codeFoldContentColor: "var(--muted-foreground)",
  diffViewerTitleBackground: "var(--background-interactive)",
  diffViewerTitleColor: "var(--foreground)",
  diffViewerTitleBorderColor: "var(--border)"
} as const

function renderDiffListItem(row: DiffRow): React.ReactNode {
  if (row.type === "file") {
    return (
      <div className="h-5 leading-5 truncate border-t border-border/60 bg-muted/60 px-2 font-medium text-foreground first:border-t-0">
        {row.text}
      </div>
    )
  }
  if (row.type === "hunk") {
    return (
      <div className="h-5 leading-5 truncate bg-muted/30 px-2 text-muted-foreground">
        {row.text}
      </div>
    )
  }
  const sign = row.type === "add" ? "+" : row.type === "del" ? "-" : " "
  return (
    <div
      className={cn(
        "flex h-5 gap-2 px-2",
        row.type === "add" && "bg-emerald-500/10",
        row.type === "del" && "bg-rose-500/10"
      )}
    >
      <span
        className={cn(
          "w-3 shrink-0 select-none text-right leading-5",
          row.type === "add"
            ? "text-emerald-600 dark:text-emerald-400"
            : row.type === "del"
              ? "text-rose-600 dark:text-rose-400"
              : "text-muted-foreground/40"
        )}
      >
        {sign}
      </span>
      <span className="min-w-0 flex-1 truncate leading-5">
        {row.text || "\u00a0"}
      </span>
    </div>
  )
}

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

interface ParsedDiffFile {
  id: string
  oldPath: string
  newPath: string
  displayPath: string
  oldContent: string
  newContent: string
  totalLines: number
  addedLines: number
  removedLines: number
  isNewFile: boolean
  isDeletedFile: boolean
}

function stripDiffPath(path: string): string {
  const normalized = path.trim().replace(/^"|"$/g, "")
  if (!normalized || normalized === "/dev/null") return normalized
  return normalized.replace(/^[ab]\//, "")
}

function getDisplayPath(oldPath: string, newPath: string, fallback: string): string {
  if (newPath && newPath !== "/dev/null") return newPath
  if (oldPath && oldPath !== "/dev/null") return oldPath
  return fallback
}

function parseDiffSection(section: string, index: number): ParsedDiffFile | null {
  const lines = section.split("\n")
  const diffHeader = lines.find((line) => line.startsWith("diff --git "))
  const headerMatch = diffHeader?.match(/^diff --git\s+a\/(.+?)\s+b\/(.+)$/)

  let oldPath = headerMatch ? stripDiffPath(`a/${headerMatch[1]}`) : ""
  let newPath = headerMatch ? stripDiffPath(`b/${headerMatch[2]}`) : ""
  const oldLines: string[] = []
  const newLines: string[] = []
  let inHunk = false
  let addedLines = 0
  let removedLines = 0
  let totalLines = 0

  for (const line of lines) {
    if (line.startsWith("--- ")) {
      oldPath = stripDiffPath(line.substring(4))
      continue
    }
    if (line.startsWith("+++ ")) {
      newPath = stripDiffPath(line.substring(4))
      continue
    }
    if (line.startsWith("@@")) {
      inHunk = true
      continue
    }
    if (!inHunk || line.startsWith("\\ No newline")) {
      continue
    }
    if (line.startsWith("-")) {
      oldLines.push(line.substring(1))
      removedLines++
      totalLines++
      continue
    }
    if (line.startsWith("+")) {
      newLines.push(line.substring(1))
      addedLines++
      totalLines++
      continue
    }
    if (line.startsWith(" ")) {
      oldLines.push(line.substring(1))
      newLines.push(line.substring(1))
      totalLines++
    }
  }

  if (!oldPath && !newPath && totalLines === 0) {
    return null
  }

  const displayPath = getDisplayPath(oldPath, newPath, `变更文件 ${index + 1}`)

  return {
    id: `${index}:${displayPath}`,
    oldPath,
    newPath,
    displayPath,
    oldContent: oldLines.join("\n"),
    newContent: newLines.join("\n"),
    totalLines,
    addedLines,
    removedLines,
    isNewFile: oldPath === "/dev/null",
    isDeletedFile: newPath === "/dev/null"
  }
}

function parseUnifiedDiffFiles(diffText: string): ParsedDiffFile[] {
  const normalized = diffText.replace(/\r\n/g, "\n")
  if (!normalized.trim()) return []

  const lines = normalized.split("\n")
  const sections: string[] = []
  let current: string[] = []

  for (const line of lines) {
    if (line.startsWith("diff --git ") && current.length > 0) {
      sections.push(current.join("\n"))
      current = [line]
      continue
    }
    current.push(line)
  }
  if (current.length > 0) {
    sections.push(current.join("\n"))
  }

  const files = sections
    .map((section, index) => parseDiffSection(section, index))
    .filter((file): file is ParsedDiffFile => Boolean(file))

  if (files.length > 0) {
    return files
  }

  // 兼容没有 `diff --git` 头、但仍包含 `---/+++/@@` 的 unified diff。
  const singleFile = parseDiffSection(normalized, 0)
  return singleFile ? [singleFile] : []
}

function buildDirectDiffFile(oldContent: string, newContent: string): ParsedDiffFile {
  const oldLineCount = oldContent ? oldContent.split("\n").length : 0
  const newLineCount = newContent ? newContent.split("\n").length : 0

  return {
    id: "direct:变更内容",
    oldPath: "变更前",
    newPath: "变更后",
    displayPath: "变更内容",
    oldContent,
    newContent,
    totalLines: Math.max(oldLineCount, newLineCount),
    addedLines: 0,
    removedLines: 0,
    isNewFile: oldLineCount === 0 && newLineCount > 0,
    isDeletedFile: newLineCount === 0 && oldLineCount > 0
  }
}

export const DiffDisplay = memo(({ diff, oldValue, newValue, filePath }: DiffDisplayProps) => {
  const [isFullscreen, setIsFullscreen] = useState(false)
  const [selectedFileId, setSelectedFileId] = useState<string | null>(null)
  const [diffViewerModule, setDiffViewerModule] = useState<DiffViewerModule | null>(null)
  const [diffViewerLoadError, setDiffViewerLoadError] = useState<string | null>(null)
  const themePreference = useSyncExternalStore(
    subscribeThemePreference,
    getThemePreference,
    () => DEFAULT_THEME_ID
  )
  const isDarkTheme = getThemeDefinition(themePreference).colorScheme === "dark"

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
  const diffFiles = useMemo(() => {
    if (oldValue !== undefined || newValue !== undefined) {
      return [buildDirectDiffFile(oldValue ?? "", newValue ?? "")]
    }
    return parseUnifiedDiffFiles(diffToUse)
  }, [diffToUse, oldValue, newValue])

  const selectedFile = diffFiles.find((file) => file.id === selectedFileId) ?? diffFiles[0]
  const totalAddedLines = diffFiles.reduce((sum, file) => sum + file.addedLines, 0)
  const totalRemovedLines = diffFiles.reduce((sum, file) => sum + file.removedLines, 0)
  const totalChangedLines = diffFiles.reduce((sum, file) => sum + file.totalLines, 0)
  const oldContent = selectedFile?.oldContent ?? ""
  const newContent = selectedFile?.newContent ?? ""
  const totalLines = selectedFile?.totalLines ?? 0

  const isDirectDiff = oldValue !== undefined || newValue !== undefined
  const shouldVirtualizeFullscreen =
    isFullscreen && !isDirectDiff && totalLines > VIRTUALIZED_DIFF_LINE_THRESHOLD

  // Keep the O(1) DOM behavior for large diffs, but derive rows from the same two
  // text sides used by the preview. Defer the line diff until fullscreen is opened.
  const virtualizedDiffRows = useMemo<DiffRow[]>(() => {
    if (!shouldVirtualizeFullscreen || !selectedFile) return []
    return buildLineDiffRows(
      selectedFile.oldContent,
      selectedFile.newContent,
      selectedFile.displayPath
    )
  }, [selectedFile, shouldVirtualizeFullscreen])

  const sourceOldContent = oldValue ?? oldContent
  const sourceNewContent = newValue ?? newContent

  const isLargeDiff = totalLines > 100
  const maxPreviewLines = 30

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

  const renderFileTabs = (fullscreen: boolean) => {
    if (diffFiles.length <= 1) return null

    return (
      <div
        className={cn(
          "flex gap-1 overflow-x-auto border-b border-border bg-background/80",
          fullscreen ? "px-4 py-2" : "px-2 py-1.5"
        )}
      >
        {diffFiles.map((file) => {
          const selected = file.id === selectedFile?.id
          return (
            <button
              key={file.id}
              type="button"
              onClick={() => setSelectedFileId(file.id)}
              className={cn(
                "inline-flex max-w-[16rem] shrink-0 items-center gap-1.5 rounded border px-2 py-1 text-[10px] transition-colors",
                selected
                  ? "border-primary/40 bg-primary/10 text-primary"
                  : "border-border bg-muted/50 text-muted-foreground hover:bg-muted hover:text-foreground"
              )}
              title={file.displayPath}
            >
              <span className="truncate font-mono">{file.displayPath}</span>
              {file.isNewFile && <span className="rounded bg-status-nominal/10 px-1 text-status-nominal">new</span>}
              {file.isDeletedFile && <span className="rounded bg-status-critical/10 px-1 text-status-critical">del</span>}
              {file.addedLines > 0 && (
                <span className="text-status-nominal-foreground">+{file.addedLines}</span>
              )}
              {file.removedLines > 0 && (
                <span className="text-status-critical-foreground">-{file.removedLines}</span>
              )}
            </button>
          )
        })}
      </div>
    )
  }

  const makeDiffViewer = (fullscreen: boolean) => {
    // Fullscreen large diff → virtualized self-rendering for performance
    if (fullscreen && shouldVirtualizeFullscreen) {
      return (
        <div className="h-full bg-background-secondary font-mono text-[11px]">
          <VirtualList
            items={virtualizedDiffRows}
            itemHeight={DIFF_ROW_HEIGHT}
            maxHeight="100%"
            overscanCount={30}
            renderItem={(row) => renderDiffListItem(row)}
            listClassName="overflow-x-auto"
          />
        </div>
      )
    }

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
        useDarkTheme={isDarkTheme}
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
            light: DIFF_VIEWER_THEME_VARIABLES,
            dark: DIFF_VIEWER_THEME_VARIABLES
          },
          diffContainer: {
            width: "100%",
            minWidth: "100%",
            maxWidth: "100%",
            ...(!fullscreen && {
              "col:first-of-type": {
                width: "2rem"
              }
            }),
            maxHeight: fullscreen ? "100%" : undefined,
            minHeight: fullscreen ? "100%" : "0",
            overflow: "auto",
            overflowX: "hidden",
            height: "100%",
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
            width: "2rem",
            minWidth: "2rem",
            padding: "0 0.25rem"
          }
        }}
      />
    )
  }

  return (
    <div className="flex h-full min-h-0 w-full flex-col">
      {/* Header toolbar */}
      <div className="flex items-center justify-between gap-2 px-3 py-2 bg-muted/60 border-b border-border">
        {/* Left: icon + title + stats */}
        <div className="flex items-center gap-2 min-w-0">
          <GitCommit className="size-3.5 text-muted-foreground shrink-0" />
          <span className="text-[11px] font-semibold text-foreground tracking-wide truncate">
            变更预览
          </span>
          {diffFiles.length > 1 && (
            <span className="text-[10px] text-muted-foreground shrink-0">
              {diffFiles.length} 个文件
            </span>
          )}
          {(totalAddedLines > 0 || totalRemovedLines > 0) && (
            <div className="flex items-center gap-1">
              {totalAddedLines > 0 && (
                <span className="inline-flex items-center gap-0.5 text-[10px] font-medium px-1.5 py-0.5 rounded-full bg-green-100 text-green-700 dark:bg-green-950 dark:text-green-400">
                  <Plus className="size-2.5" />
                  {totalAddedLines}
                </span>
              )}
              {totalRemovedLines > 0 && (
                <span className="inline-flex items-center gap-0.5 text-[10px] font-medium px-1.5 py-0.5 rounded-full bg-red-100 text-red-700 dark:bg-red-950 dark:text-red-400">
                  <Minus className="size-2.5" />
                  {totalRemovedLines}
                </span>
              )}
              {totalChangedLines > 0 && (
                <span className="text-[10px] text-muted-foreground">共 {totalChangedLines} 行</span>
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

      {renderFileTabs(false)}


      {shouldUsePreview && (
        <div className="flex items-center justify-between gap-2 border-b border-amber-200 bg-amber-50 px-3 py-1.5 text-xs text-amber-700 dark:border-amber-800 dark:bg-amber-950/60 dark:text-amber-300">
          <span>
            当前仅展示前 {maxPreviewLines} 行，共 {totalLines} 行
          </span>
          <button
            type="button"
            onClick={() => setIsFullscreen(true)}
            className="w-[90px] inline-flex items-center gap-1 rounded border border-amber-300/80 bg-background px-2 py-1 text-[11px] font-medium text-amber-700 transition-colors hover:bg-amber-100/60 dark:border-amber-700 dark:text-amber-200 dark:hover:bg-amber-900/50"
          >
            <Eye className="size-3" />
            查看全部
          </button>
        </div>
      )}

      {/* Diff content */}
      <div
        className="relative flex min-h-0 w-full flex-1 flex-col overflow-hidden bg-background-elevated font-mono"
      >
        <div className="min-h-0 flex-1 overflow-y-auto overflow-x-hidden">
          {makeDiffViewer(false)}
        </div>
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
                {diffFiles.length > 1 && (
                  <span className="text-xs text-muted-foreground">{diffFiles.length} 个文件</span>
                )}
                {totalAddedLines > 0 && (
                  <span className="inline-flex items-center gap-0.5 text-[11px] font-medium px-2 py-0.5 rounded-full bg-green-100 text-green-700 dark:bg-green-950 dark:text-green-400">
                    <Plus className="size-3" />
                    {totalAddedLines} 行新增
                  </span>
                )}
                {totalRemovedLines > 0 && (
                  <span className="inline-flex items-center gap-0.5 text-[11px] font-medium px-2 py-0.5 rounded-full bg-red-100 text-red-700 dark:bg-red-950 dark:text-red-400">
                    <Minus className="size-3" />
                    {totalRemovedLines} 行删除
                  </span>
                )}
                <span className="text-xs text-muted-foreground">共 {totalChangedLines} 行</span>
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

          {renderFileTabs(true)}

          {/* Modal content */}
          <div className="flex-1 overflow-hidden p-4">
            <div className="h-full overflow-auto rounded-md border border-border bg-background-elevated font-mono text-xs">
              {makeDiffViewer(true)}
            </div>
          </div>
        </div>
      )}
    </div>
  )
})

DiffDisplay.displayName = "DiffDisplay"
