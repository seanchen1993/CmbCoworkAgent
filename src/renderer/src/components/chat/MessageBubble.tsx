import type { Message, HITLRequest } from "@/types"
import { ToolCallRenderer } from "./ToolCallRenderer";
import { StreamingMarkdown } from "./StreamingMarkdown"
import { getToolLabel } from "@/lib/tool-labels"
import { useState } from "react"
import { ChevronDown, ChevronRight, Wrench } from "lucide-react"

// 获取工具调用的简要描述
function getToolCallSummary(toolCall: { name: string; args?: Record<string, unknown> }): string {
  const label = getToolLabel(toolCall.name)
  const args = toolCall.args || {}

  // 获取主要参数用于显示
  let param = ""
  if (args.path || args.file_path) {
    const path = (args.path || args.file_path) as string
    param = path.split("/").pop() || path
  } else if (args.command) {
    const command = args.command as string
    param = command.slice(0, 30) + (command.length > 30 ? "..." : "")
  } else if (args.pattern || args.query) {
    param = (args.pattern || args.query) as string
  }

  return param ? `${label}: ${param}` : label
}

function isHtmlRenderToolCall(toolCall: { name: string; args?: Record<string, unknown> }): boolean {
  if (toolCall.name !== "write_file" && toolCall.name !== "edit_file") return false
  const args = toolCall.args || {}
  const path = (args.path || args.file_path) as string | undefined
  if (!path) return false
  const lowerPath = path.toLowerCase()
  return lowerPath.endsWith(".html") || lowerPath.endsWith(".htm")
}

interface ToolResultInfo {
  content: string | unknown
  is_error?: boolean
}

interface MessageBubbleProps {
  message: Message
  previousMessage?: Message | null
  isStreaming?: boolean
  toolResults?: Map<string, ToolResultInfo>
  pendingApproval?: HITLRequest | null
  onApprovalDecision?: (decision: "approve" | "approve_session" | "approve_permanent" | "reject" | "edit") => void
  threadId: string
}

export function MessageBubble({
  message,
  previousMessage,
  isStreaming = true,
  toolResults,
  pendingApproval,
  onApprovalDecision,
  threadId
}: MessageBubbleProps): React.JSX.Element | null {
  const [collapsedTools, setCollapsedTools] = useState<Set<string>>(new Set())
  const [collapsedHtmlTools, setCollapsedHtmlTools] = useState<Set<string>>(new Set())
  const isUser = message.role === "user"
  const isTool = message.role === "tool"

  // 判断是否显示 MessageHead：如果当前不是用户消息，且是第一条非用户消息
  const shouldShowMessageHead = !isUser && (!previousMessage || previousMessage.role === "user")

  // 切换工具调用详情的展开状态
  const toggleToolExpansion = (toolId: string, defaultExpanded = false) => {
    if (defaultExpanded) {
      setCollapsedHtmlTools((prev) => {
        const newSet = new Set(prev)
        if (newSet.has(toolId)) {
          newSet.delete(toolId)
        } else {
          newSet.add(toolId)
        }
        return newSet
      })
      return
    }

    setCollapsedTools((prev) => {
      const newSet = new Set(prev)
      if (newSet.has(toolId)) {
        newSet.delete(toolId)
      } else {
        newSet.add(toolId)
      }
      return newSet
    })
  }

  // Hide tool result messages - they're shown inline with tool calls
  if (isTool) {
    return null
  }

  const renderContent = (): React.ReactNode => {
    if (typeof message.content === "string") {
      // Empty content
      if (!message.content.trim()) {
        return null
      }

      // Use streaming markdown for assistant messages, plain text for user messages
      if (isUser) {
        return (
          <div className="whitespace-pre-wrap text-[15px] leading-7 text-foreground/95">
            {message.content}
          </div>
        )
      }
      return <StreamingMarkdown isStreaming={isStreaming}>{message.content}</StreamingMarkdown>
    }

    // Handle content blocks
    const renderedBlocks = message.content
      .map((block, index) => {
        if (block.type === "text" && block.text) {
          // Use streaming markdown for assistant text blocks
          if (isUser) {
            return (
              <div
                key={index}
                className="whitespace-pre-wrap text-[15px] leading-7 text-foreground/95"
              >
                {block.text}
              </div>
            )
          }
          return (
            <StreamingMarkdown key={index} isStreaming={isStreaming}>
              {block.text}
            </StreamingMarkdown>
          )
        }
        return null
      })
      .filter(Boolean)

    return renderedBlocks.length > 0 ? renderedBlocks : null
  }

  const content = renderContent()
  const hasToolCalls = message.tool_calls && message.tool_calls.length > 0

  // Don't render if there's no content and no tool calls
  if (!content && !hasToolCalls) {
    return null
  }

  if (isUser) {
    return (
      <div className="flex justify-end overflow-hidden py-4">
        <div className="rounded-lg p-3 overflow-hidden bg-primary/10 max-w-[80%]">
          {content}
        </div>
      </div>
    )
  }

  return (
    <div className="overflow-hidden space-y-1.5">
      {shouldShowMessageHead && (
        <div className="flex items-center gap-2 mb-4">
          <svg className="size-5 shrink-0" viewBox="0 0 120 120" fill="none">
            <defs>
              <linearGradient id="chat-lobster" x1="0%" y1="0%" x2="100%" y2="100%">
                <stop offset="0%" stopColor="#ff4d4d" />
                <stop offset="100%" stopColor="#991b1b" />
              </linearGradient>
            </defs>
            <path
              d="M60 10 C30 10 15 35 15 55 C15 75 30 95 45 100 L45 110 L55 110 L55 100 C55 100 60 102 65 100 L65 110 L75 110 L75 100 C90 95 105 75 105 55 C105 35 90 10 60 10Z"
              fill="url(#chat-lobster)"
            />
            <path
              d="M20 45 C5 40 0 50 5 60 C10 70 20 65 25 55 C28 48 25 45 20 45Z"
              fill="url(#chat-lobster)"
            />
            <path
              d="M100 45 C115 40 120 50 115 60 C110 70 100 65 95 55 C92 48 95 45 100 45Z"
              fill="url(#chat-lobster)"
            />
            <path d="M45 15 Q35 5 30 8" stroke="#ff4d4d" strokeWidth="3" strokeLinecap="round" />
            <path d="M75 15 Q85 5 90 8" stroke="#ff4d4d" strokeWidth="3" strokeLinecap="round" />
            <circle cx="45" cy="35" r="6" fill="#050810" />
            <circle cx="75" cy="35" r="6" fill="#050810" />
            <circle cx="46" cy="34" r="2.5" fill="#00e5cc" />
            <circle cx="76" cy="34" r="2.5" fill="#00e5cc" />
          </svg>
          <span className="text-xs font-medium text-muted-foreground">CMBDevClaw</span>
        </div>
      )}
      <div className="flex-1 min-w-0 space-y-2 overflow-hidden pl-7">
        {content && <div className="rounded-lg px-3 overflow-hidden">{content}</div>}
        {hasToolCalls && (
          <div className="space-y-2 overflow-hidden">
            {message.tool_calls!.map((toolCall, index) => {
              const toolId = toolCall.id || `${message.id}-${index}`;
              const result = toolResults?.get(toolCall.id);
              const pendingIds = pendingApproval?.pendingToolCallIds;
              const needsApproval = Boolean(
                pendingIds?.length
                  ? pendingIds.includes(toolCall.id)
                  : pendingApproval?.tool_call?.id && pendingApproval.tool_call.id === toolCall.id
              );
              const isHtmlTool = isHtmlRenderToolCall(toolCall);
              const isExpanded = isHtmlTool ? collapsedHtmlTools.has(toolId) : collapsedTools.has(toolId);
              const summary = getToolCallSummary(toolCall);

              // 如果工具需要审批，使用原来的ToolCallRenderer（批量时隐藏按钮）
              if (needsApproval) {
                const isBatch = (pendingApproval?.pendingCount ?? 1) > 1;
                return (
                  <ToolCallRenderer
                    key={`${toolCall.id || `tc-${index}`}-${needsApproval ? "pending" : "done"}`}
                    toolCall={toolCall}
                    result={result?.content}
                    isError={result?.is_error}
                    needsApproval={needsApproval}
                    showApprovalButtons={!isBatch}
                    onApprovalDecision={onApprovalDecision}
                    approvalTypes={(pendingApproval as any)?._approvalTypes}
                    threadId={threadId}
                    isStreaming={isStreaming}
                  />
                );
              }

              // 工具执行完成后，显示折叠的标题
              return (
                <div key={toolId} className="rounded-sm border overflow-hidden border-border bg-background-elevated">
                  {/* 可折叠的工具标题 */}
                  <button
                    onClick={() => toggleToolExpansion(toolId, isHtmlTool)}
                    className="flex w-full items-center gap-2 px-3 py-2 hover:bg-background-interactive transition-colors"
                  >
                    {isExpanded ? (
                      <ChevronDown className="size-4 text-muted-foreground shrink-0" />
                    ) : (
                      <ChevronRight className="size-4 text-muted-foreground shrink-0" />
                    )}

                    <Wrench className="size-4 shrink-0 text-status-info" />

                    <span className="text-xs font-medium shrink-0">{summary}</span>

                    {/* 状态指示器 */}
                    {result !== undefined && (
                      <div className={`ml-auto shrink-0 px-2 py-0.5 text-[10px] font-medium rounded ${
                        result.is_error
                          ? 'bg-red-100 text-red-700 border border-red-200'
                          : 'bg-green-100 text-green-700 border border-green-200'
                      }`}>
                        {result.is_error ? "ERROR" : "OK"}
                      </div>
                    )}

                    {result === undefined && isStreaming && (
                      <div className="ml-auto shrink-0 px-2 py-0.5 text-[10px] font-medium rounded bg-gray-100 text-gray-600 border border-gray-200 animate-pulse">
                        RUNNING
                      </div>
                    )}

                    {result === undefined && !isStreaming && (
                      <div className="ml-auto shrink-0 px-2 py-0.5 text-[10px] font-medium rounded bg-amber-100 text-amber-700 border border-amber-200">
                        INTERRUPTED
                      </div>
                    )}
                  </button>

                  {/* 展开的详细内容 */}
                  {(isExpanded  ) && (
                    <div className="border-t border-border">
                      <ToolCallRenderer
                        toolCall={toolCall}
                        result={result?.content}
                        isError={result?.is_error}
                        needsApproval={false}
                        onApprovalDecision={undefined}
                        isStreaming={isStreaming}
                        threadId={threadId}
                      />
                    </div>
                  )}
                </div>
              )
            })}

            {/* 批量审批栏 - 只在当前消息包含待审批工具调用时显示 */}
            {pendingApproval && (pendingApproval.pendingCount ?? 1) > 1 && onApprovalDecision &&
              message.tool_calls!.some(tc => pendingApproval.pendingToolCallIds?.includes(tc.id) || pendingApproval.tool_call?.id === tc.id) && (
              <div className="rounded-sm border border-amber-500/50 bg-amber-500/5 px-3 py-2.5 flex items-center justify-between">
                <div className="flex items-center gap-2">
                  <span className="text-xs text-amber-600 dark:text-amber-400 font-medium whitespace-nowrap">
                    共 {pendingApproval.pendingCount} 个命令待审批
                  </span>
                  <span className="text-xs text-status-warning bg-status-warning/10 px-2 py-1 rounded-sm whitespace-nowrap">💡 启用 YOLO 模式可跳过审批</span>
                </div>
                <div className="flex items-center gap-2">
                  <button
                    className="px-3 py-1.5 text-xs border border-border rounded-sm hover:bg-background-interactive transition-colors"
                    onClick={(e) => { e.stopPropagation(); onApprovalDecision("reject") }}
                  >
                    全部拒绝
                  </button>
                  <button
                    className="px-3 py-1.5 text-xs bg-status-nominal text-background rounded-sm hover:bg-status-nominal/90 transition-colors"
                    onClick={(e) => { e.stopPropagation(); onApprovalDecision("approve") }}
                  >
                    全部批准并执行
                  </button>
                </div>
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  )
}
