import {
  FileText,
  FolderOpen,
  Search,
  Edit,
  Terminal,
  ListTodo,
  GitBranch,
  ChevronDown,
  ChevronRight,
  CheckCircle2,
  Circle,
  Clock,
  XCircle,
  File,
  Folder,
  Maximize2,
  Minimize2,
  AlertCircle,
  GitCommit,
  Eye,
  EyeOff,
  Minus,
  Plus
} from "lucide-react"
import { memo, useState } from "react"
import { Badge } from "@/components/ui/badge"
import { cn } from "@/lib/utils"
import { getToolLabel } from "@/lib/tool-labels"
import type { ToolCall, Todo } from "@/types"
import ReactDiffViewer, { DiffMethod } from "react-diff-viewer-continued"
import { ToolCallErrorBoundary, RenderProbe } from "./ToolCallErrorBoundary"

// Module-level sentinel so identity is stable across renders. Returned by
// `tryRender` when the formatter throws synchronously — callers fall back
// to <RenderProbe> so the ErrorBoundary can catch the throw during its
// own render phase.
const THROWN: unique symbol = Symbol("tool-render-thrown")

function tryRender(fn: () => React.ReactNode): React.ReactNode | typeof THROWN {
  try {
    return fn()
  } catch (err) {
    // The boundary will display the fallback via RenderProbe's second
    // invocation and log details through componentDidCatch. Keep this at
    // debug level so the same failure isn't triple-logged in the console
    // (probe + boundary + React's own "above error occurred..." notice).
    console.debug("[ToolCallRenderer] formatter threw during probe:", err)
    return THROWN
  }
}

interface ToolCallRendererProps {
  toolCall: ToolCall
  result?: string | unknown
  isError?: boolean
  needsApproval?: boolean
  showApprovalButtons?: boolean
  onApprovalDecision?: (
    decision: "approve" | "approve_session" | "approve_permanent" | "reject" | "edit"
  ) => void
  /** Sandbox retry context — shown when sandbox blocked the command */
  retryReason?: string
  /** Which approval button types to show */
  approvalTypes?: ("approve" | "approve_session" | "approve_permanent" | "reject")[]
  threadId: string
  /** Whether the stream is still active — used to distinguish RUNNING vs INTERRUPTED. Defaults to true (prefer RUNNING over INTERRUPTED when unknown). */
  isStreaming?: boolean
}

const TOOL_ICONS: Record<string, React.ComponentType<{ className?: string }>> = {
  read_file: FileText,
  write_file: Edit,
  edit_file: Edit,
  ls: FolderOpen,
  glob: FolderOpen,
  grep: Search,
  execute: Terminal,
  write_todos: ListTodo,
  task: GitBranch,
  git_push: GitBranch,
  browser_playwright: Terminal
}

// Tools whose results are shown in the UI panels and don't need verbose display
const PANEL_SYNCED_TOOLS = new Set(["write_todos"])

function safeStringify(value: unknown): string {
  const seen = new WeakSet<object>()

  try {
    const serialized = JSON.stringify(
      value,
      (_key, currentValue: unknown) => {
        if (typeof currentValue === "bigint") {
          return `${currentValue.toString()}n`
        }
        if (currentValue instanceof Error) {
          return {
            name: currentValue.name,
            message: currentValue.message,
            stack: currentValue.stack
          }
        }
        if (typeof currentValue === "function") {
          return `[Function ${currentValue.name || "anonymous"}]`
        }
        if (typeof currentValue === "symbol") {
          return currentValue.toString()
        }
        if (currentValue && typeof currentValue === "object") {
          if (seen.has(currentValue)) {
            return "[Circular]"
          }
          seen.add(currentValue)
        }
        return currentValue
      },
      2
    )

    return typeof serialized === "string" ? serialized : String(serialized)
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    return `[Unserializable value: ${message}]`
  }
}

// Helper to get a clean file name from path
function getFileName(path: string): string {
  return path.split("/").pop() || path
}

// Render todos nicely
function TodosDisplay({ todos }: { todos: Todo[] }): React.JSX.Element {
  const statusConfig: Record<string, { icon: typeof Circle; color: string }> = {
    pending: { icon: Circle, color: "text-muted-foreground" },
    in_progress: { icon: Clock, color: "text-status-info" },
    completed: { icon: CheckCircle2, color: "text-status-nominal" },
    cancelled: { icon: XCircle, color: "text-muted-foreground" }
  }

  const defaultConfig = { icon: Circle, color: "text-muted-foreground" }

  return (
    <div className="space-y-1">
      {todos.map((todo, i) => {
        const config = statusConfig[todo.status] || defaultConfig
        const Icon = config.icon
        const isDone = todo.status === "completed" || todo.status === "cancelled"
        return (
          <div
            key={todo.id || i}
            className={cn("flex items-start gap-2 text-xs", isDone && "opacity-50")}
          >
            <Icon className={cn("size-3.5 mt-0.5 shrink-0", config.color)} />
            <span className={cn(isDone && "line-through")}>{todo.content}</span>
          </div>
        )
      })}
    </div>
  )
}

// Render file list nicely
function FileListDisplay({
  files,
  isGlob
}: {
  files: string[] | Array<{ path: string; is_dir?: boolean }>
  isGlob?: boolean
}): React.JSX.Element {
  const items = files.slice(0, 15) // Limit display
  const hasMore = files.length > 15

  return (
    <div className="space-y-0.5">
      {items.map((file, i) => {
        const path = typeof file === "string" ? file : file.path
        const isDir = typeof file === "object" && file.is_dir
        return (
          <div key={i} className="flex items-center gap-2 text-xs font-mono">
            {isDir ? (
              <Folder className="size-3 text-status-warning shrink-0" />
            ) : (
              <File className="size-3 text-muted-foreground shrink-0" />
            )}
            <span className="truncate">{isGlob ? path : getFileName(path)}</span>
          </div>
        )
      })}
      {hasMore && (
        <div className="text-xs text-muted-foreground mt-1">... and {files.length - 15} more</div>
      )}
    </div>
  )
}

// Render grep results nicely
function GrepResultsDisplay({
  matches
}: {
  matches: Array<{ path: string; line?: number; text?: string }>
}): React.JSX.Element {
  const grouped = matches.reduce(
    (acc, match) => {
      if (!acc[match.path]) acc[match.path] = []
      acc[match.path].push(match)
      return acc
    },
    {} as Record<string, typeof matches>
  )

  const files = Object.keys(grouped).slice(0, 5)
  const hasMore = Object.keys(grouped).length > 5

  return (
    <div className="space-y-2">
      {files.map((path) => (
        <div key={path} className="text-xs">
          <div className="flex items-center gap-1.5 font-medium text-status-info mb-1">
            <FileText className="size-3" />
            {getFileName(path)}
          </div>
          <div className="space-y-0.5 pl-4 border-l border-border/50">
            {grouped[path].slice(0, 3).map((match, i) => (
              <div key={i} className="font-mono text-muted-foreground truncate">
                {match.line && <span className="text-status-warning mr-2">{match.line}:</span>}
                {match.text?.trim()}
              </div>
            ))}
            {grouped[path].length > 3 && (
              <div className="text-muted-foreground">+{grouped[path].length - 3} more matches</div>
            )}
          </div>
        </div>
      ))}
      {hasMore && (
        <div className="text-xs text-muted-foreground">
          ... matches in {Object.keys(grouped).length - 5} more files
        </div>
      )}
    </div>
  )
}

// Render file content preview
function FileContentPreview({ content }: { content: string; path?: string }): React.JSX.Element {
  const lines = content.split("\n")
  const preview = lines.slice(0, 10)
  const hasMore = lines.length > 10

  return (
    <div className="text-xs font-mono bg-background rounded-sm overflow-hidden w-full">
      <pre className="p-2 overflow-auto max-h-40 w-full">
        {preview.map((line, i) => (
          <div key={i} className="flex min-w-0">
            <span className="w-8 shrink-0 text-muted-foreground select-none pr-2 text-right">
              {i + 1}
            </span>
            <span className="flex-1 min-w-0 truncate">{line || " "}</span>
          </div>
        ))}
      </pre>
      {hasMore && (
        <div className="px-2 py-1 text-muted-foreground bg-background-elevated border-t border-border">
          ... {lines.length - 10} more lines
        </div>
      )}
    </div>
  )
}

// Render edit/write file summary
function FileEditSummary({ args }: { args: Record<string, unknown> }): React.JSX.Element | null {
  const path = (args.path || args.file_path) as string
  const content = args.content as string | undefined
  const oldStr = args.old_str as string | undefined
  const newStr = args.new_str as string | undefined

  if (oldStr !== undefined && newStr !== undefined) {
    // Edit operation
    return (
      <div className="text-xs space-y-2">
        <div className="flex items-center gap-1.5 text-status-critical">
          <span className="font-mono bg-status-critical/10 px-1.5 py-0.5 rounded">
            - {oldStr.split("\n").length} lines
          </span>
        </div>
        <div className="flex items-center gap-1.5 text-status-nominal">
          <span className="font-mono bg-nominal/10 px-1.5 py-0.5 rounded">
            + {newStr.split("\n").length} lines
          </span>
        </div>
      </div>
    )
  }

  if (content) {
    const lines = content.split("\n").length
    return (
      <div className="text-xs text-muted-foreground">
        Writing {lines} lines to {getFileName(path)}
      </div>
    )
  }

  return null
}

// Command display
function CommandDisplay({
  command,
  output
}: {
  command: string
  output?: string
}): React.JSX.Element {
  return (
    <div className="text-xs space-y-2 w-full overflow-hidden">
      <div
        className="font-mono bg-background rounded-sm p-2 flex items-center gap-2 min-w-0"
        title={command || undefined}
      >
        <span className="text-status-info shrink-0">$</span>
        <span className="truncate">{command}</span>
      </div>
      {output && (
        <pre className="font-mono bg-background rounded-sm p-2 overflow-auto max-h-32 text-muted-foreground w-full whitespace-pre-wrap break-all">
          {output.slice(0, 500)}
          {output.length > 500 && "..."}
        </pre>
      )}
    </div>
  )
}

// Subagent task display
function TaskDisplay({
  args,
  isExpanded
}: {
  args: Record<string, unknown>
  isExpanded?: boolean
}): React.JSX.Element {
  const name = args.name as string | undefined
  const description = args.description as string | undefined

  return (
    <div className="text-xs space-y-1">
      {name && (
        <div className="flex items-center gap-2">
          <GitBranch className="size-3 text-status-info" />
          <span className="font-medium truncate">{name}</span>
        </div>
      )}
      {description && (
        <p className={cn("text-muted-foreground pl-5", !isExpanded && "line-clamp-2")}>
          {description}
        </p>
      )}
    </div>
  )
}

// Render git diff nicely
interface DiffDisplayProps {
  diff?: string
  oldValue?: string
  newValue?: string
}

export const DiffDisplay = memo(({ diff, oldValue, newValue }: DiffDisplayProps) => {
  const [isFullscreen, setIsFullscreen] = useState(false)
  const [renderMode, setRenderMode] = useState<"preview" | "full">("preview")

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

  const isLargeDiff = totalLines > 100
  const maxPreviewLines = 20

  const getPreviewContent = (content: string, maxLines: number) => {
    const lines = content.split("\n")
    if (lines.length <= maxLines) return content
    return (
      lines.slice(0, maxLines).join("\n") +
      "\n...(显示前 " +
      maxLines +
      " 行，共 " +
      lines.length +
      " 行)"
    )
  }

  const shouldUsePreview = isLargeDiff && renderMode === "preview"
  const displayOldContent = shouldUsePreview
    ? getPreviewContent(oldContent, maxPreviewLines)
    : oldContent
  const displayNewContent = shouldUsePreview
    ? getPreviewContent(newContent, maxPreviewLines)
    : newContent

  const makeDiffViewer = (fullscreen: boolean) => (
    <ReactDiffViewer
      oldValue={oldValue || displayOldContent}
      newValue={newValue || displayNewContent}
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
      disableWordDiff={shouldUsePreview}
      compareMethod={shouldUsePreview ? DiffMethod.LINES : DiffMethod.WORDS}
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
          maxHeight: fullscreen ? "100%" : "22rem",
          minHeight: fullscreen ? "100%" : "80px",
          overflow: "auto",
          height: fullscreen ? "100%" : undefined,
          borderRadius: "0"
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

      {/* Large-file warning banner */}
      {isLargeDiff && renderMode === "full" && (
        <div className="flex items-center gap-2 px-3 py-1.5 bg-amber-50 dark:bg-amber-950/60 border-b border-amber-200 dark:border-amber-800">
          <div className="size-1.5 rounded-full bg-amber-500 animate-pulse shrink-0" />
          <span className="text-amber-700 dark:text-amber-300">
            大文件渲染可能较慢，建议切换至全屏模式查看
          </span>
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
              <div className="flex items-center gap-2">
                <GitCommit className="size-4 text-primary" />
                <span className="text-sm font-semibold">Git Diff — 全屏视图</span>
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
              {isLargeDiff && (
                <button
                  onClick={() => setRenderMode(renderMode === "preview" ? "full" : "preview")}
                  className="inline-flex items-center gap-1.5 cursor-pointer px-3 py-1.5 text-xs font-medium bg-background hover:bg-muted border border-border rounded transition-colors"
                >
                  {renderMode === "preview" ? (
                    <>
                      <Eye className="size-3" />
                      展开全部代码
                    </>
                  ) : (
                    <>
                      <EyeOff className="size-3" />
                      精简预览
                    </>
                  )}
                </button>
              )}
              <button
                onClick={() => {
                  setIsFullscreen(false)
                  setRenderMode("preview")
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

export function ToolCallRenderer({
  toolCall,
  result,
  isError,
  needsApproval,
  showApprovalButtons = true,
  onApprovalDecision,
  retryReason,
  approvalTypes = ["approve", "approve_session", "approve_permanent", "reject"],
  threadId,
  isStreaming = true
}: ToolCallRendererProps) {
  const [isExpanded, setIsExpanded] = useState(false)
  void threadId

  // Defensive: ensure args is always an object
  const args = toolCall?.args || {}

  // Bail out if no toolCall
  if (!toolCall) {
    return null
  }

  const Icon = TOOL_ICONS[toolCall.name] || Terminal
  const label = getToolLabel(toolCall.name)
  const isPanelSynced = PANEL_SYNCED_TOOLS.has(toolCall.name)

  const handleReject = (e: React.MouseEvent): void => {
    e.stopPropagation()
    onApprovalDecision?.("reject")
  }

  // Format the main argument for display. All reads go through `str()` so
  // a malformed / non-string value from the model never reaches JSX or
  // .slice() — either would blow up ToolCallRenderer before the inner
  // ErrorBoundary can catch it.
  const str = (v: unknown, truncate?: number): string | null => {
    if (typeof v !== "string" || !v) return null
    return truncate ? v.slice(0, truncate) : v
  }
  const getDisplayArg = (): string | null => {
    if (!args) return null
    return (
      str(args.path)
      ?? str(args.file_path)
      ?? str(args.command, 50)
      ?? str(args.pattern)
      ?? str(args.query)
      ?? str(args.glob)
      ?? str(args.branch)
      ?? str(args.remoteUrl)
      ?? str(args.commitMessage, 50)
    )
  }

  const displayArg = getDisplayArg()

  // Shared across execute's content/result formatters so we don't pay
  // safeStringify's deep-JSON cost twice for the same non-string result
  // (can matter for large stdout from git log / npm test / etc).
  const executeOutput: string | undefined =
    toolCall.name === "execute"
      ? typeof result === "string"
        ? result
        : result === undefined
          ? undefined
          : result === null
            ? ""
            : safeStringify(result)
      : undefined

  // Render formatted content based on tool type
  const renderFormattedContent = (): React.ReactNode => {
    if (!args) return null

    switch (toolCall.name) {
      case "write_todos": {
        const todos = args.todos as Todo[] | undefined
        if (todos && todos.length > 0) {
          return <TodosDisplay todos={todos} />
        }
        return null
      }

      case "task": {
        return <TaskDisplay args={args} isExpanded={isExpanded} />
      }

      case "edit_file":
      case "write_file": {
        return <FileEditSummary args={args} />
      }

      case "execute": {
        const command =
          typeof args.command === "string"
            ? args.command
            : args.command == null
              ? ""
              : safeStringify(args.command)
        return (
          <CommandDisplay
            command={command}
            output={isExpanded ? executeOutput : undefined}
          />
        )
      }

      default:
        return null
    }
  }

  // Render result based on tool type
  const renderFormattedResult = (): React.ReactNode => {
    if (result === undefined) return null

    // Handle errors
    if (isError) {
      return (
        <div className="text-xs text-status-critical flex items-start gap-1.5">
          <XCircle className="size-3 mt-0.5 shrink-0" />
          <span className="break-words">
            {typeof result === "string" ? result : safeStringify(result)}
          </span>
        </div>
      )
    }

    switch (toolCall.name) {
      case "read_file": {
        const content = typeof result === "string" ? result : safeStringify(result)
        const lines = content.split("\n").length
        return (
          <div className="space-y-2">
            <div className="text-xs text-status-nominal flex items-center gap-1.5">
              <CheckCircle2 className="size-3" />
              <span>Read {lines} lines</span>
            </div>
            <FileContentPreview content={content} />
          </div>
        )
      }

      case "ls": {
        if (Array.isArray(result)) {
          const dirs = result.filter(
            (f: { is_dir?: boolean } | string) => typeof f === "object" && f.is_dir
          ).length
          const files = result.length - dirs
          return (
            <div className="space-y-2">
              <div className="text-xs text-status-nominal flex items-center gap-1.5">
                <CheckCircle2 className="size-3" />
                <span>
                  {files} file{files !== 1 ? "s" : ""}
                  {dirs > 0 ? `, ${dirs} folder${dirs !== 1 ? "s" : ""}` : ""}
                </span>
              </div>
              <FileListDisplay files={result} />
            </div>
          )
        }
        return null
      }

      case "glob": {
        if (Array.isArray(result)) {
          return (
            <div className="space-y-2">
              <div className="text-xs text-status-nominal flex items-center gap-1.5">
                <CheckCircle2 className="size-3" />
                <span>
                  Found {result.length} match{result.length !== 1 ? "es" : ""}
                </span>
              </div>
              <FileListDisplay files={result} isGlob />
            </div>
          )
        }
        return null
      }

      case "grep": {
        if (Array.isArray(result)) {
          const fileCount = new Set(result.map((m: { path: string }) => m.path)).size
          return (
            <div className="space-y-2">
              <div className="text-xs text-status-nominal flex items-center gap-1.5">
                <CheckCircle2 className="size-3" />
                <span>
                  {result.length} match{result.length !== 1 ? "es" : ""} in {fileCount} file
                  {fileCount !== 1 ? "s" : ""}
                </span>
              </div>
              <GrepResultsDisplay matches={result} />
            </div>
          )
        }
        return null
      }

      case "execute": {
        // When expanded, output is shown in CommandDisplay - just show status
        // When collapsed, show the output preview
        // Uses the outer `executeOutput` so we only pay safeStringify once
        // per render (see its declaration above).
        const output = executeOutput ?? ""

        // Special handling for git diff commands
        // todo 暂时注释，看后续是否要放开
        // if (command && command.includes("git diff") && output.trim() && !output.includes('no output') ) {
        //   if (isExpanded) {
        //     return (
        //       <div className="text-xs text-status-nominal flex items-center gap-1.5">
        //         <CheckCircle2 className="size-3" />
        //         <span>Git diff completed</span>
        //       </div>
        //     )
        //   }
        //   // Collapsed view - show diff preview
        //   return (
        //     <div className="space-y-2">
        //       <div className="text-xs text-status-nominal flex items-center gap-1.5">
        //         <CheckCircle2 className="size-3" />
        //         <span>Git diff completed</span>
        //       </div>
        //       <DiffDisplay diff={output} />
        //     </div>
        //   )
        // }

        if (isExpanded) {
          return (
            <div className="text-xs text-status-nominal flex items-center gap-1.5">
              <CheckCircle2 className="size-3" />
              <span>Command completed</span>
            </div>
          )
        }
        // Collapsed view - show output preview
        if (output.trim()) {
          return (
            <div className="space-y-2">
              <div className="text-xs text-status-nominal flex items-center gap-1.5">
                <CheckCircle2 className="size-3" />
                <span>Command completed</span>
              </div>
              <pre className="text-xs font-mono bg-background rounded-sm p-2 overflow-auto max-h-32 text-muted-foreground whitespace-pre-wrap break-all">
                {output.slice(0, 500)}
                {output.length > 500 && "..."}
              </pre>
            </div>
          )
        }
        return (
          <div className="text-xs text-status-nominal flex items-center gap-1.5">
            <CheckCircle2 className="size-3" />
            <span>Command completed (no output)</span>
          </div>
        )
      }

      case "write_todos":
        // Already shown in Tasks panel
        return null

      case "write_file":
      case "edit_file": {
        // Show confirmation message for file operations
        if (typeof result === "string" && result.trim()) {
          return (
            <div className="text-xs text-status-nominal flex items-center gap-1.5">
              <CheckCircle2 className="size-3" />
              <span>{result}</span>
            </div>
          )
        }
        return (
          <div className="text-xs text-status-nominal flex items-center gap-1.5">
            <CheckCircle2 className="size-3" />
            <span>File saved</span>
          </div>
        )
      }

      case "task": {
        // Subagent task completion
        if (typeof result === "string" && result.trim()) {
          return (
            <div className="space-y-2">
              <div className="text-xs text-status-nominal flex items-center gap-1.5">
                <CheckCircle2 className="size-3" />
                <span>Task completed</span>
              </div>
              <div className="text-xs text-muted-foreground pl-5 line-clamp-3">
                {result.slice(0, 500)}
                {result.length > 500 && "..."}
              </div>
            </div>
          )
        }
        return (
          <div className="text-xs text-status-nominal flex items-center gap-1.5">
            <CheckCircle2 className="size-3" />
            <span>Task completed</span>
          </div>
        )
      }

      default: {
        // Generic success for unknown tools
        if (typeof result === "string" && result.trim()) {
          return (
            <div className="text-xs text-status-nominal flex items-center gap-1.5">
              <CheckCircle2 className="size-3" />
              <span className="truncate">
                {result.slice(0, 100)}
                {result.length > 100 ? "..." : ""}
              </span>
            </div>
          )
        }
        return (
          <div className="text-xs text-status-nominal flex items-center gap-1.5">
            <CheckCircle2 className="size-3" />
            <span>Completed</span>
          </div>
        )
      }
    }
  }

  // `resetKey` is a fingerprint of tool-call progress. When it changes
  // while the boundary is in an error state, the boundary clears its
  // error state and re-renders the children — so a mid-stream render
  // error recovers as soon as the data changes. (Note: once the error
  // has been caught, the original subtree is already unmounted by React's
  // error-boundary semantics — "soft reset" here means "no new boundary
  // instance via parent-key change", not "subtree state preserved". For
  // normal happy-path re-renders without errors no unmount happens at all.)
  //
  // Fingerprint granularity:
  //   - string:  exact length (soft reset per chunk; no remount cost)
  //   - array:   element count
  //   - object:  top-level key count (explicit null branch because
  //              `typeof null === "object"` in JS)
  //   - other primitives: stable
  // args is folded in too because some formatters (e.g. edit_file's diff
  // summary) depend on args while result is still pending.
  const id = toolCall.id ?? toolCall.name
  const argsFingerprint =
    args && typeof args === "object" ? `a${Object.keys(args).length}` : "a0"
  const resultFingerprint =
    result === undefined
      ? "pending"
      : typeof result === "string"
        ? `s${result.length}`
        : result === null
          ? "null"
          : Array.isArray(result)
            ? `arr${result.length}`
            : typeof result === "object"
              ? `obj${Object.keys(result as object).length}`
              : "prim"
  // Include isExpanded because several formatters take different branches
  // based on it (execute output, task details, etc). Without it a render
  // error in one state would stick even after the user toggled to the
  // other.
  const resetKey = `${id}:${argsFingerprint}:${resultFingerprint}:${isExpanded ? 1 : 0}`
  // Evaluate formatters once per parent render. Happy path: the resulting
  // element is handed to both the "should we render the container?" check
  // and the boundary (no double invocation on read_file / grep / diff).
  // Throw path: fall back to <RenderProbe> so the formatter runs again
  // during the boundary's render phase — that second call is the only way
  // React's error boundary can catch the throw. Notes:
  //   - happy path  = 1 invocation  (was 2 before this optimisation)
  //   - throw path  = 2 invocations (unavoidable — boundary needs the
  //                   throw to happen inside its subtree)
  const contentNode = tryRender(renderFormattedContent)
  const resultNode = tryRender(renderFormattedResult)
  const contentHasOutput = contentNode === THROWN || contentNode != null
  const resultHasOutput = resultNode === THROWN || resultNode != null
  const hasFormattedDisplay = contentHasOutput || resultHasOutput
  const formattedContent = contentHasOutput ? (
    <ToolCallErrorBoundary toolName={toolCall.name} resetKey={`c:${resetKey}`}>
      {contentNode === THROWN ? (
        <RenderProbe render={renderFormattedContent} />
      ) : (
        contentNode
      )}
    </ToolCallErrorBoundary>
  ) : null
  const formattedResult = resultHasOutput ? (
    <ToolCallErrorBoundary toolName={toolCall.name} resetKey={`r:${resetKey}`}>
      {resultNode === THROWN ? (
        <RenderProbe render={renderFormattedResult} />
      ) : (
        resultNode
      )}
    </ToolCallErrorBoundary>
  ) : null

  return (
    <div
      className={cn(
        "rounded-sm border overflow-hidden",
        needsApproval
          ? "border-amber-500/50 bg-amber-500/5"
          : "border-border bg-background-elevated"
      )}
    >
      {/* Header */}
      <button
        onClick={() => setIsExpanded(!isExpanded)}
        className="flex w-full items-center gap-2 px-3 py-2 hover:bg-background-interactive transition-colors"
      >
        {isExpanded ? (
          <ChevronDown className="size-4 text-muted-foreground shrink-0" />
        ) : (
          <ChevronRight className="size-4 text-muted-foreground shrink-0" />
        )}

        <Icon
          className={cn("size-4 shrink-0", needsApproval ? "text-amber-500" : "text-status-info")}
        />

        <span className="text-xs font-medium shrink-0">{label}</span>

        {displayArg && (
          <span className="flex-1 truncate text-left text-xs text-muted-foreground font-mono">
            {displayArg}
          </span>
        )}

        {needsApproval && (
          <Badge variant="warning" className="ml-auto shrink-0">
            待审批
          </Badge>
        )}

        {!needsApproval && result === undefined && isStreaming && (
          <Badge variant="outline" className="ml-auto shrink-0 animate-pulse">
            RUNNING
          </Badge>
        )}

        {!needsApproval && result === undefined && !isStreaming && (
          <Badge variant="warning" className="ml-auto shrink-0">
            INTERRUPTED
          </Badge>
        )}

        {result !== undefined && !needsApproval && (
          <Badge variant={isError ? "critical" : "nominal"} className="ml-auto shrink-0">
            {isError ? "ERROR" : "OK"}
          </Badge>
        )}

        {isPanelSynced && !needsApproval && (
          <Badge variant="outline" className="shrink-0 text-[9px]">
            SYNCED
          </Badge>
        )}
      </button>

      {/* Approval UI */}
      {needsApproval ? (
        <div className="border-t border-amber-500/20 px-3 py-3 space-y-3">
          {/* Show formatted content (e.g., command preview) */}
          {formattedContent}

          {/* Arguments */}
          <div>
            <div className="text-section-header text-[10px] mb-1">参数</div>
            <pre className="text-xs font-mono bg-background p-2 rounded-sm overflow-auto max-h-24">
              {safeStringify(args)}
            </pre>
          </div>

          {/* Action buttons - hidden when batch approval bar is used */}
          {showApprovalButtons && (
            <div className="space-y-2">
              {/* Sandbox retry info */}
              {retryReason && (
                <div className="flex items-start gap-2 rounded-md border border-amber-500/20 bg-amber-500/5 p-2 text-xs text-amber-600 dark:text-amber-400">
                  <AlertCircle className="size-3 mt-0.5 shrink-0" />
                  <span>{retryReason}</span>
                </div>
              )}

              <div className="flex items-center justify-between gap-2">
                <span className="text-xs text-status-warning bg-status-warning/10 px-2 py-1 rounded-sm">
                  💡 启用 YOLO 模式可跳过审批
                </span>
                <div className="flex items-center gap-2 flex-wrap">
                  {approvalTypes.includes("reject") && (
                    <button
                      className="px-3 py-1.5 text-xs border border-border rounded-sm hover:bg-background-interactive transition-colors"
                      onClick={handleReject}
                    >
                      拒绝
                    </button>
                  )}
                  {approvalTypes.includes("approve") && (
                    <button
                      className="px-3 py-1.5 text-xs bg-status-nominal text-background rounded-sm hover:bg-status-nominal/90 transition-colors"
                      onClick={(e) => {
                        e.stopPropagation()
                        onApprovalDecision?.("approve")
                      }}
                    >
                      运行
                    </button>
                  )}
                  {!retryReason && approvalTypes.includes("approve_session") && (
                    <button
                      className="px-3 py-1.5 text-xs bg-blue-600 text-white rounded-sm hover:bg-blue-700 transition-colors"
                      onClick={(e) => {
                        e.stopPropagation()
                        onApprovalDecision?.("approve_session")
                      }}
                    >
                      本会话允许
                    </button>
                  )}
                  {!retryReason && approvalTypes.includes("approve_permanent") && (
                    <button
                      className="px-3 py-1.5 text-xs bg-purple-600 text-white rounded-sm hover:bg-purple-700 transition-colors"
                      onClick={(e) => {
                        e.stopPropagation()
                        onApprovalDecision?.("approve_permanent")
                      }}
                    >
                      始终允许
                    </button>
                  )}
                </div>
              </div>
            </div>
          )}
        </div>
      ) : null}

      {/* Formatted content (only visible when collapsed AND has result) */}
      {hasFormattedDisplay && !isExpanded && !needsApproval && result !== undefined && (
        <div className="border-t border-border px-3 py-2 space-y-2 overflow-hidden">
          {formattedContent}
          {formattedResult}
        </div>
      )}

      {/* Expanded content - raw details */}
      {isExpanded && !needsApproval && (
        <div className="border-t border-border px-3 py-2 space-y-2 overflow-hidden">
          {/* Formatted display first */}
          {formattedContent}
          {formattedResult}

          {/* Raw Arguments */}
          <div className="overflow-hidden w-full">
            <div className="text-section-header mb-1">RAW ARGUMENTS</div>
            <pre className="text-xs font-mono bg-background p-2 rounded-sm overflow-auto max-h-48 w-full whitespace-pre-wrap break-all">
              {safeStringify(args)}
            </pre>
          </div>

          {/* Raw Result */}
          {result !== undefined && (
            <div className="overflow-hidden w-full">
              <div className="text-section-header mb-1">RAW RESULT</div>
              <pre
                className={cn(
                  "text-xs font-mono p-2 rounded-sm overflow-auto max-h-48 w-full whitespace-pre-wrap break-all",
                  isError ? "bg-status-critical/10 text-status-critical" : "bg-background"
                )}
              >
                {typeof result === "string" ? result : safeStringify(result)}
              </pre>
            </div>
          )}
        </div>
      )}
    </div>
  )
}
