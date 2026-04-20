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
  AlertCircle
} from "lucide-react"
import { useState } from "react"
import { Badge } from "@/components/ui/badge"
import { cn } from "@/lib/utils"
import { getToolLabel } from "@/lib/tool-labels"
import type { ToolCall, Todo } from "@/types"

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
      <div className="font-mono bg-background rounded-sm p-2 flex items-center gap-2 min-w-0">
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

  // Format the main argument for display
  const getDisplayArg = (): string | null => {
    if (!args) return null
    if (args.path) return args.path as string
    if (args.file_path) return args.file_path as string
    if (args.command) return (args.command as string).slice(0, 50)
    if (args.pattern) return args.pattern as string
    if (args.query) return args.query as string
    if (args.glob) return args.glob as string
    if (args.branch) return args.branch as string
    if (args.remoteUrl) return args.remoteUrl as string
    if (args.commitMessage) return (args.commitMessage as string).slice(0, 50)
    return null
  }

  const displayArg = getDisplayArg()

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
        const output = typeof result === "string" ? result : undefined
        return <CommandDisplay command="" output={isExpanded ? output : undefined} />
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
        const output = typeof result === "string" ? result : safeStringify(result)

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
            <pre className="space-y-2">
              <div className="text-xs text-status-nominal flex items-center gap-1.5">
                <CheckCircle2 className="size-3" />
                <span>Command completed</span>
              </div>
              <pre className="text-xs font-mono bg-background rounded-sm p-2 overflow-auto max-h-32 text-muted-foreground whitespace-pre-wrap break-all">
                {output.slice(0, 500)}
                {output.length > 500 && "..."}
              </pre>
            </pre>
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

  const formattedContent = renderFormattedContent()
  const formattedResult = renderFormattedResult()
  const hasFormattedDisplay = formattedContent || formattedResult

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
