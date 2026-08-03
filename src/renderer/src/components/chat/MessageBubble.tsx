import type { Message, HITLRequest, ToolCallState, ToolCallStatus } from "@/types"
import { ToolCallRenderer } from "./ToolCallRenderer"
import { StreamingMarkdown } from "./StreamingMarkdown"
import { getToolLabel } from "@/lib/tool-labels"
import { emitOpenResourcePreview } from "@/lib/resource-preview-events"
import React, { useEffect, useMemo, useRef, useState } from "react"
import {
  ChevronDown,
  ChevronRight,
  ChevronUp,
  Eye,
  Wrench,
  Copy,
  Check,
  PencilLine,
  ThumbsUp,
  ThumbsDown,
  Smile,
  Frown,
  Info,
  Flag,
  PlayCircle,
  GitFork,
  Loader2
} from "lucide-react"
import { toast } from "sonner"
import { cn } from "@/lib/utils"
import { stripLegacyGoalTransportSummary } from "@/lib/goal-transport-summary"
import { MessageFeedbackDialog, type DislikeFeedbackPayload } from "./MessageFeedbackDialog"
import { SkillChip } from "@/features/slash-commands/skill-chip"
import { parseSkillUseBlock } from "@/features/slash-commands/skill-marker"
import {
  isCoordinatorWorkerToolName,
  normalizeCoordinatorWorkerToolArgsForDisplay
} from "@/lib/coordinator-worker-tool-args"
import { getWorkerToolUiKey } from "@/lib/worker-tool-result-key"
import { DurationShow } from "./DurationShow"
import { isGoalClearAlias } from "../../../../shared/goal-slash"
import { isResultlessCompletedToolCall } from "@/lib/tool-call-display-state"
import { normalizeVisibleReasoningText } from "@/lib/message-display-visibility"

/**
 * Strip the trailing `<CMBDEVCLAW-SKILL-USE-V1>…</…>` block when present.
 * Only applied to user-authored content — assistant replies that happen to
 * quote the tag (e.g. discussing the protocol) should copy verbatim instead
 * of silently losing characters.
 */
function stripSkillUseBlock(s: string): string {
  const parsed = parseSkillUseBlock(s)
  return parsed ? parsed.rest : s
}

function parseUserVisibleSkillContent(content: string): {
  visibleText: string
  skillName: string | null
} {
  const skillParsed = parseSkillUseBlock(content)
  if (skillParsed) {
    return { visibleText: skillParsed.rest, skillName: skillParsed.skillName }
  }
  const legacy = stripLegacyGoalTransportSummary(content)
  return { visibleText: legacy.text, skillName: legacy.skillName }
}

function parseGoalUserSetMessage(text: string): {
  objective: string
  attachments: string | null
  skillName: string | null
} | null {
  const lines = text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
  if (lines.length === 0) return null

  const firstLine = lines[0]
  const match = firstLine.match(/^\/goal\b\s*(.*)$/i)
  if (!match) return null

  const rest = (match[1] ?? "").trim()
  if (!rest) return null

  const normalizedRest = rest.toLowerCase()
  if (
    ["status", "pause", "resume"].includes(normalizedRest) ||
    isGoalClearAlias(normalizedRest)
  )
    return null

  let attachments: string | null = null
  let skillName: string | null = null
  const objectiveLines: string[] = [rest]

  for (const line of lines.slice(1)) {
    const attachmentMatch = line.match(/^启动附件[：:]\s*(.+)$/)
    if (attachmentMatch) {
      attachments = attachmentMatch[1]?.trim() || null
      continue
    }
    const skillMatch = line.match(/^显式技能[：:]\s*(.+)$/)
    if (skillMatch) {
      skillName = skillMatch[1]?.trim() || null
      continue
    }
    objectiveLines.push(line)
  }

  const objective = objectiveLines.join("\n").trim()
  return objective ? { objective, attachments, skillName } : null
}

function parseGoalUserControlMessage(text: string): {
  label: string
  description: string
  tone: "resume"
} | null {
  const normalized = text.trim().replace(/\s+/g, " ").toLowerCase()
  if (normalized !== "/goal resume") return null
  return {
    label: "继续 Goal",
    description: "从上次暂停处继续推进目标",
    tone: "resume"
  }
}

function extractMessagePlainText(
  content: Message["content"],
  options: { stripSkillUse?: boolean } = {}
): string {
  const maybeStrip = options.stripSkillUse ? stripSkillUseBlock : (s: string): string => s
  if (typeof content === "string") return maybeStrip(content)
  if (!Array.isArray(content)) return ""

  return content
    .map((block) => {
      if (block.type === "text") return maybeStrip(block.text ?? "")
      if (typeof block.content === "string") return maybeStrip(block.content)
      return ""
    })
    .filter(Boolean)
    .join("\n")
}

function normalizeToolCallForDisplay<T extends { name: string; args?: Record<string, unknown> }>(
  toolCall: T
): T {
  if (!toolCall.args || !isCoordinatorWorkerToolName(toolCall.name)) return toolCall
  return {
    ...toolCall,
    args: normalizeCoordinatorWorkerToolArgsForDisplay(toolCall.name, toolCall.args)
  }
}

function stripThinkBlocksForDisplay(text: string): string {
  return text
    .replace(/<think>[\s\S]*?<\/think>\s*/gi, "")
    .replace(/^\s*<think>[\s\S]*$/i, "")
    .replace(/^[\s\S]*?<\/think>\s*/i, "")
}

// 获取工具调用的简要描述
function getToolCallSummary(toolCall: { name: string; args?: Record<string, unknown> }): string {
  const label = getToolLabel(toolCall.name, { showToolName: false })
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

function getToolPreviewPath(toolCall: {
  name: string
  args?: Record<string, unknown>
}): string | null {
  if (
    toolCall.name !== "read_file" &&
    toolCall.name !== "write_file" &&
    toolCall.name !== "edit_file"
  ) {
    return null
  }
  const path = (toolCall.args?.path ?? toolCall.args?.file_path) as string | undefined
  if (!path || !path.trim()) return null
  return path
}

function hydrateToolCall(
  toolCall: { id: string; name: string; args?: Record<string, unknown> },
  toolState?: ToolCallState
): { id: string; name: string; args: Record<string, unknown> } {
  return {
    ...toolCall,
    name: toolCall.name || toolState?.name || "execute",
    args: {
      ...(toolState?.args || {}),
      ...(toolCall.args || {})
    }
  }
}

function getToolStatusMeta(status: ToolCallStatus): { label: string; className: string } {
  switch (status) {
    case "completed":
      return { label: "OK", className: "bg-green-100 text-green-700 border border-green-200" }
    case "failed":
      return { label: "ERROR", className: "bg-red-100 text-red-700 border border-red-200" }
    case "awaiting_approval":
      return { label: "APPROVAL", className: "bg-amber-100 text-amber-700 border border-amber-200" }
    case "queued":
      return { label: "QUEUED", className: "bg-slate-100 text-slate-600 border border-slate-200" }
    case "running":
      return {
        label: "RUNNING",
        className: "bg-gray-100 text-gray-600 border border-gray-200 animate-pulse"
      }
    case "rejected":
      return {
        label: "REJECTED",
        className: "bg-orange-100 text-orange-700 border border-orange-200"
      }
    case "interrupted":
    default:
      return {
        label: "INTERRUPTED",
        className: "bg-amber-100 text-amber-700 border border-amber-200"
      }
  }
}

function getSystemNoticePresentation(text: string): {
  icon: React.JSX.Element
  text: string
  tone: "success" | "warning" | "info"
} {
  const cleanText = text.replace(/^●\s*/, "")
  const isGoalNotice =
    cleanText.startsWith("Goal ") ||
    cleanText.startsWith("继续 Goal") ||
    cleanText.startsWith("当前没有 active goal") ||
    cleanText.startsWith("没有可继续的 goal") ||
    cleanText.startsWith("请写明 goal 目标") ||
    cleanText.startsWith("附件和显式技能不会用于 /goal 控制命令") ||
    cleanText.startsWith("该 /goal 命令") ||
    cleanText.startsWith("当前线程正在运行") ||
    cleanText.startsWith("你发送了新消息，active goal 已暂停")

  if (cleanText.startsWith("✓ Goal 已完成")) {
    return {
      icon: <Check className="size-4" />,
      text: cleanText.replace(/^✓\s*/, ""),
      tone: "success"
    }
  }

  if (
    cleanText.startsWith("Goal 已暂停") ||
    cleanText.startsWith("Ⅱ Goal 已暂停") ||
    cleanText.startsWith("Goal 等待补充信息") ||
    cleanText.startsWith("你发送了新消息，active goal 已暂停")
  ) {
    return {
      icon: <Flag className="size-4" />,
      text: cleanText.replace(/^Ⅱ\s*/, ""),
      tone: "warning"
    }
  }

  if (isGoalNotice) {
    return {
      icon: <Flag className="size-4" />,
      text: cleanText.replace(/^Ⅱ\s*/, ""),
      tone: "info"
    }
  }

  return {
    icon: <Info className="size-4" />,
    text: cleanText,
    tone: "info"
  }
}

function parseGoalNoticeText(text: string): {
  title: string
  meta?: string
  rows: Array<{ label?: string; text: string }>
  actions: string[]
} | null {
  const cleanText = text.replace(/^●\s*/, "").replace(/^Ⅱ\s*/, "").trim()
  const lines = cleanText.split(/\r?\n/).map((line) => line.trim()).filter(Boolean)
  if (lines.length === 0) return null

  const first = lines[0]
  if (
    !first.startsWith("Goal ") &&
    !first.startsWith("继续 Goal") &&
    !first.startsWith("当前没有 active goal") &&
    !first.startsWith("没有可继续的 goal") &&
    !first.startsWith("请写明 goal 目标") &&
    !first.startsWith("附件和显式技能不会用于 /goal 控制命令") &&
    !first.startsWith("该 /goal 命令") &&
    !first.startsWith("当前线程正在运行") &&
    !first.startsWith("你发送了新消息，active goal 已暂停")
  ) {
    return null
  }

  const rows: Array<{ label?: string; text: string }> = []
  const actions: string[] = []

  const pushActionText = (text: string): void => {
    const normalized = text.replace(/[。.\s]+$/g, "")
    for (const part of normalized.split(/[，,、；;·]/)) {
      const trimmed = part.trim().replace(/^(可用|需要继续时发送|稍后发送|补充信息后请发送|用)\s*/, "")
      if (trimmed.includes("/goal")) actions.push(trimmed)
    }
  }

  const pushCommandSentence = (sentence: string): boolean => {
    const commandIndex = sentence.indexOf("/goal")
    if (commandIndex < 0) return false
    const prefix = sentence
      .slice(0, commandIndex)
      .replace(/[，,；;\s]+$/g, "")
      .trim()
    const command = sentence.slice(commandIndex).replace(/[。.\s]+$/g, "").trim()
    if (prefix && !/^(用|可用|需要继续时发送|稍后发送|补充信息后请发送)$/.test(prefix)) {
      rows.push({ text: prefix })
    }
    if (command) actions.push(command)
    return true
  }

  const pushActionLine = (line: string): boolean => {
    if (!line.includes("/goal")) return false
    pushActionText(line)
    return true
  }

  const splitSentences = (body: string): string[] =>
    body
      .split(/(?<=[。.!！?？])\s*/)
      .map((item) => item.trim())
      .filter(Boolean)

  const pushBodySentences = (body: string): void => {
    for (const sentence of splitSentences(body)) {
      if (pushCommandSentence(sentence)) continue
      rows.push({ text: sentence.replace(/[。.\s]+$/g, "").trim() })
    }
  }

  const setMatch = first.match(/^Goal 已设置(?:（([^）]+)）)?[。.]?\s*(.*)$/)
  if (setMatch) {
    const body = setMatch[2]?.trim() || ""
    const actionIndex = body.indexOf("可用")
    const description =
      actionIndex >= 0 ? body.slice(0, actionIndex).replace(/[；;，,\s]+$/g, "").trim() : body
    const actionText = actionIndex >= 0 ? body.slice(actionIndex) : ""
    if (description) rows.push({ text: description })
    if (actionText) pushActionText(actionText)
    return { title: "Goal 已设置", meta: setMatch[1], rows, actions }
  }

  const noActiveMatch = first.match(/^当前没有 active goal[。.]?\s*(.*)$/)
  if (noActiveMatch) {
    const body = noActiveMatch[1]?.trim()
    if (body) pushBodySentences(body)
    return { title: "当前没有 active goal", rows, actions }
  }

  if (first === "没有可继续的 goal。" || first === "没有可继续的 goal") {
    return { title: "没有可继续的 goal", rows, actions }
  }

  const invalidGoalMatch = first.match(/^(请写明 goal 目标\/完成条件)[，,。.]?\s*(.*)$/)
  if (invalidGoalMatch) {
    const body = invalidGoalMatch[2]?.trim()
    if (body) pushBodySentences(body)
    return { title: "请写明 Goal 目标", rows, actions }
  }

  const transportControlMatch = first.match(
    /^(附件和显式技能不会用于 \/goal 控制命令)[，,。.]?\s*(.*)$/
  )
  if (transportControlMatch) {
    const body = transportControlMatch[2]?.trim()
    if (body) pushBodySentences(body)
    return { title: "Goal 控制命令未发送上下文", rows, actions }
  }

  const unavailableGoalMatch = first.match(/^该 \/goal 命令需要在当前运行结束后发送[。.]?$/)
  if (unavailableGoalMatch) {
    rows.push({ text: "当前运行结束后再发送该命令" })
    return { title: "Goal 命令暂不可用", rows, actions }
  }

  const preemptedGoalMatch = first.match(/^你发送了新消息，active goal 已暂停[。.]?\s*(.*)$/)
  if (preemptedGoalMatch) {
    const body = preemptedGoalMatch[1]?.trim()
    if (body) pushBodySentences(body)
    return { title: "active goal 已暂停", rows, actions }
  }

  const goalBusyMatch = first.match(/^(Goal 正在进行中)[，,]\s*(.*)$/)
  if (goalBusyMatch) {
    const body = goalBusyMatch[2]?.trim()
    if (body) rows.push({ text: body.replace(/[。.\s]+$/g, "") })
    return { title: goalBusyMatch[1], rows, actions }
  }

  const completeMatch = first.match(/^✓?\s*(Goal 已完成)(?:\s*\(([^)]+)\))?[：:]\s*(.*)$/)
  if (completeMatch) {
    const reason = completeMatch[3]?.trim()
    if (reason) rows.push({ text: reason })
    return { title: completeMatch[1], meta: completeMatch[2], rows, actions }
  }

  const goalAlreadyMatch = first.match(/^(Goal (?:已完成|已经暂停))(?:[，,。.]?\s*)(.*)$/)
  if (goalAlreadyMatch && !goalAlreadyMatch[2]?.startsWith("：")) {
    const body = goalAlreadyMatch[2]?.trim()
    if (body) pushBodySentences(body)
    return { title: goalAlreadyMatch[1], rows, actions }
  }

  const threadBusyMatch = first.match(/^当前线程正在运行[，,]\s*(.*)$/)
  if (threadBusyMatch) {
    const body = threadBusyMatch[1]?.trim()
    if (body) pushBodySentences(body)
    return { title: "当前线程正在运行", rows, actions }
  }

  const singleLineMatch = first.match(/^(Goal (?:等待补充信息|已暂停|已继续|当前状态|已清除))[：:]\s*(.*)$/)
  if (singleLineMatch) {
    const title = singleLineMatch[1]
    let body = singleLineMatch[2]?.trim() || ""
    const waitSplit = body.split("。补充信息后")
    if (waitSplit.length > 1) {
      body = waitSplit[0].trim()
      actions.push("/goal resume", "/goal clear")
    }
    if (body) rows.push({ text: body })
    return { title, rows, actions }
  }

  if (first.startsWith("Goal 已清除")) {
    const body = first.replace(/^Goal 已清除[。:：，,\s]*/, "").trim()
    if (body) rows.push({ text: body })
    return { title: "Goal 已清除", rows, actions }
  }

  const continueMatch = first.match(/^(继续 Goal)(?:\s*\(([^)]+)\))?[：:]\s*(.*)$/)
  if (continueMatch) {
    const body = continueMatch[3]?.trim()
    if (body) rows.push({ text: body })
    return { title: continueMatch[1], meta: continueMatch[2], rows, actions }
  }

  const title = first
  let meta: string | undefined
  for (const line of lines.slice(1)) {
    if (!meta && /^\d+s\s*·/.test(line)) {
      meta = line
      continue
    }
    if (pushActionLine(line)) continue
    const labeled = line.match(/^(目标|完成条件|最近评估|暂停原因)[：:]\s*(.*)$/)
    if (labeled) {
      rows.push({ label: labeled[1], text: labeled[2].trim() })
    } else {
      rows.push({ text: line })
    }
  }
  return { title, meta, rows, actions }
}

function GoalNoticeBody({ text }: { text: string }): React.JSX.Element {
  const parsed = parseGoalNoticeText(text)
  if (!parsed) {
    return <StreamingMarkdown isStreaming={false}>{text}</StreamingMarkdown>
  }

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
        <div className="text-[15px] font-semibold leading-6 text-foreground">{parsed.title}</div>
        {parsed.meta && (
          <div className="rounded-full bg-foreground/5 px-2 py-0.5 text-xs leading-5 text-muted-foreground">
            {parsed.meta}
          </div>
        )}
      </div>
      {parsed.rows.length > 0 && (
        <div className="space-y-2">
          {parsed.rows.map((row, index) => (
            <div key={index} className="grid gap-1 text-[14px] leading-6 sm:grid-cols-[4.5rem_minmax(0,1fr)]">
              {row.label ? (
                <>
                  <span className="text-muted-foreground">{row.label}</span>
                  <span className="min-w-0 text-foreground/90">{row.text}</span>
                </>
              ) : (
                <span className="min-w-0 text-foreground/90 sm:col-span-2">{row.text}</span>
              )}
            </div>
          ))}
        </div>
      )}
      {parsed.actions.length > 0 && (
        <div className="flex flex-wrap gap-2 pt-1">
          {parsed.actions.map((action) => (
            <span
              key={action}
              className="rounded-md border border-border/70 bg-background/60 px-2 py-1 font-mono text-xs leading-4 text-muted-foreground"
            >
              {action}
            </span>
          ))}
        </div>
      )}
    </div>
  )
}

interface ToolResultInfo {
  content: string | unknown
  is_error?: boolean
}

interface MessageBubbleProps {
  message: Message
  previousMessage?: Message | null
  isStreaming?: boolean
  showAssistantMeta?: boolean
  toolResults?: Map<string, ToolResultInfo>
  toolCallStates?: Map<string, ToolCallState>
  pendingApprovalToolCallKeys?: Set<string>
  pendingApproval?: HITLRequest | null
  autoApproveGitPush?: boolean
  onApprovalDecision?: (
    decision: "approve" | "approve_session" | "approve_permanent" | "reject" | "edit"
  ) => void
  onEditUserMessage?: (message: Message) => void
  onSetGoalFromMessage?: (text: string) => void
  onForkFromMessage?: (message: Message) => void
  forkingMessageId?: string | null
  threadId: string
  isLoading: boolean
  hasUserAfterHead?: boolean
  assistantDurationMs?: number
  userSendTimeLabel?: string | null
}

/** 用户消息折叠阈值:收起态最大高度(px)。超过才出现"显示更多"。 */
const USER_MESSAGE_COLLAPSED_MAX_PX = 260

function MessageBubbleImpl({
  message,
  previousMessage,
  isStreaming = true,
  showAssistantMeta = true,
  toolResults,
  toolCallStates,
  pendingApprovalToolCallKeys,
  pendingApproval,
  autoApproveGitPush = false,
  onApprovalDecision,
  onEditUserMessage,
  onSetGoalFromMessage,
  onForkFromMessage,
  forkingMessageId = null,
  threadId,
  isLoading,
  hasUserAfterHead = false,
  assistantDurationMs,
  userSendTimeLabel = null
}: MessageBubbleProps): React.JSX.Element | null {
  const [collapsedTools, setCollapsedTools] = useState<Set<string>>(new Set())
  const [collapsedHtmlTools, setCollapsedHtmlTools] = useState<Set<string>>(new Set())
  const [copySuccess, setCopySuccess] = useState(false)
  const [feedbackDialogOpen, setFeedbackDialogOpen] = useState(false)
  const [likedMessageId, setLikedMessageId] = useState<string | null>(null)
  const [dislikedMessageId, setDislikedMessageId] = useState<string | null>(null)
  const [feedbackSubmitting, setFeedbackSubmitting] = useState(false)
  const [reasoningOpen, setReasoningOpen] = useState(false)
  // 超长用户消息折叠:默认收起,测量到内容超过阈值才显示"显示更多/收起"。
  const [userContentExpanded, setUserContentExpanded] = useState(false)
  const [userContentOverflow, setUserContentOverflow] = useState(false)
  const userContentRef = useRef<HTMLDivElement>(null)
  const autoOpenedReasoningForMessageRef = useRef<string | null>(null)
  const autoCollapsedReasoningForMessageRef = useRef<string | null>(null)
  const isUser = message.role === "user"
  const isTool = message.role === "tool"
  const isSystem = message.role === "system"
  const isForkingThisMessage = forkingMessageId === message.id
  const canForkFromMessage = message.role === "assistant" && Boolean(onForkFromMessage)
  const forkFromMessageDisabled = isLoading || Boolean(forkingMessageId)
  const reasoningText = !isUser ? normalizeVisibleReasoningText(message.reasoning) : ""
  const visibleAssistantContentText = useMemo(() => {
    if (isUser) return ""
    if (typeof message.content === "string") {
      return reasoningText ? stripThinkBlocksForDisplay(message.content) : message.content
    }
    if (!Array.isArray(message.content)) return ""
    return message.content
      .map((block) => {
        if (block.type !== "text" || !block.text) return ""
        return reasoningText ? stripThinkBlocksForDisplay(block.text) : block.text
      })
      .join("\n")
  }, [isUser, message.content, reasoningText])
  const hasVisibleAssistantContent = visibleAssistantContentText.trim().length > 0

  useEffect(() => {
    if (
      message.role !== "user" &&
      typeof message.content === "string" &&
      message.content.includes("改用编辑方式整体替换文件内容。")
    ) {
      console.log(message, "message///")
    }
  }, [message])

  // 测量用户消息内容高度,超过阈值才启用折叠。气泡宽度是 max-w-[80%],会随窗口/
  // 侧栏开合变化,因此除内容变化外还用 ResizeObserver 在宽度变化时重测——否则窄时
  // 测得溢出、变宽后内容已放得下,遮罩/按钮仍会残留。scrollHeight 始终是完整内容高度
  // (不受 maxHeight 截断影响),且 setState 幂等,不会造成观察循环。
  useEffect(() => {
    if (message.role !== "user") return
    const el = userContentRef.current
    if (!el) return
    const measure = (): void => {
      setUserContentOverflow(el.scrollHeight > USER_MESSAGE_COLLAPSED_MAX_PX + 8)
    }
    measure()
    if (typeof ResizeObserver === "undefined") return
    const observer = new ResizeObserver(() => measure())
    observer.observe(el)
    return () => observer.disconnect()
  }, [message.role, message.content])

  useEffect(() => {
    if (!isStreaming || !reasoningText) return
    if (autoOpenedReasoningForMessageRef.current === message.id) return
    autoOpenedReasoningForMessageRef.current = message.id
    setReasoningOpen(true)
  }, [isStreaming, message.id, reasoningText])

  useEffect(() => {
    if (!isStreaming || !reasoningText || !hasVisibleAssistantContent) return
    if (autoCollapsedReasoningForMessageRef.current === message.id) return
    autoCollapsedReasoningForMessageRef.current = message.id
    setReasoningOpen(false)
  }, [hasVisibleAssistantContent, isStreaming, message.id, reasoningText])

  // 判断是否显示 MessageHead：如果当前不是用户消息，且是第一条非用户消息
  const shouldShowMessageHead =
    !isUser &&
    !isSystem &&
    (!previousMessage || previousMessage.role === "user" || previousMessage.role === "system")

  const duration = useMemo(() => {
    if (!shouldShowMessageHead || typeof assistantDurationMs !== "number") return 0
    return assistantDurationMs
  }, [assistantDurationMs, shouldShowMessageHead])

  const shouldHideDuration = isLoading && !hasUserAfterHead

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

  if (isSystem) {
    const text = extractMessagePlainText(message.content).trim()
    if (!text) return null
    const notice = getSystemNoticePresentation(text)
    return (
      <div className="my-3 flex justify-center">
        <div className={`liquid-glass-notice liquid-glass-notice--${notice.tone}`}>
          <div className="relative z-[1] flex items-start gap-3">
            <span className="liquid-glass-notice__icon" aria-hidden="true">
              {notice.icon}
            </span>
            <div className="liquid-glass-notice__body min-w-0 text-[15px] leading-7 [&_p]:my-0 [&_strong]:font-semibold">
              <GoalNoticeBody text={notice.text} />
            </div>
          </div>
        </div>
      </div>
    )
  }

  // Only strip the skill-use tail from OUR user messages; assistant text that
  // happens to quote the tag (e.g. while discussing the protocol) copies verbatim.
  const plainTextForCopy = extractMessagePlainText(message.content, { stripSkillUse: isUser })
  const goalUserSetMessage = isUser ? parseGoalUserSetMessage(plainTextForCopy) : null
  const goalUserControlMessage = isUser ? parseGoalUserControlMessage(plainTextForCopy) : null

  const renderGoalUserSetContent = (goalMessage: NonNullable<typeof goalUserSetMessage>): React.ReactNode => (
    <div className="space-y-2 text-left">
      <div className="flex items-center gap-1.5 text-xs font-medium text-[#5f6b66]">
        <span className="flex size-6 items-center justify-center rounded-full bg-white shadow-sm ring-1 ring-black/[0.05]">
          <Flag className="size-3.5 text-sky-600" />
        </span>
        <span>设为 Goal</span>
      </div>
      <div className="whitespace-pre-wrap text-[15px] leading-7 text-foreground/95 break-all">
        {goalMessage.objective}
      </div>
      {(goalMessage.attachments || goalMessage.skillName) && (
        <div className="flex flex-wrap gap-1.5 pt-0.5">
          {goalMessage.attachments && (
            <span className="rounded-full border border-black/[0.05] bg-[#f7f7f5]/85 px-2 py-0.5 text-[11px] text-muted-foreground">
              附件：{goalMessage.attachments}
            </span>
          )}
          {goalMessage.skillName && (
            <span className="rounded-full border border-black/[0.05] bg-[#f7f7f5]/85 px-2 py-0.5 text-[11px] text-muted-foreground">
              技能：{goalMessage.skillName}
            </span>
          )}
        </div>
      )}
    </div>
  )

  const renderGoalUserControlContent = (
    goalMessage: NonNullable<typeof goalUserControlMessage>
  ): React.ReactNode => (
    <div className="flex items-center gap-2 text-left">
      <span className="flex size-8 shrink-0 items-center justify-center rounded-full bg-white text-sky-700 shadow-[0_6px_18px_rgba(24,24,27,0.10)] ring-1 ring-black/[0.05]">
        <PlayCircle className="size-4" />
      </span>
      <span className="min-w-0">
        <span className="block text-sm font-semibold text-[#35433f]">{goalMessage.label}</span>
        <span className="block text-xs text-muted-foreground">{goalMessage.description}</span>
      </span>
    </div>
  )

  const renderContent = (): React.ReactNode => {
    if (goalUserSetMessage) {
      return renderGoalUserSetContent(goalUserSetMessage)
    }
    if (goalUserControlMessage) {
      return renderGoalUserControlContent(goalUserControlMessage)
    }

    if (typeof message.content === "string") {
      const displayContent =
        !isUser && reasoningText ? stripThinkBlocksForDisplay(message.content) : message.content
      // Empty content (after potentially stripping the trailing skill-use block below)
      if (!displayContent.trim()) {
        return null
      }

      // Use streaming markdown for assistant messages, plain text for user messages
      if (isUser) {
        // Parse the trailing `<CMBDEVCLAW-SKILL-USE-V1>` block: chip at the top,
        // rest of the message as plain text. Handles skill-only sends (no text)
        // by still rendering the chip with an empty tail.
        const { visibleText, skillName } = parseUserVisibleSkillContent(displayContent)
        return (
          <div className="whitespace-pre-wrap break-words text-[15px] leading-7 text-foreground/95 [overflow-wrap:anywhere]">
            {skillName && <SkillChip label={skillName} compact className="mr-2" />}
            {visibleText}
          </div>
        )
      }
      return <StreamingMarkdown isStreaming={isStreaming}>{displayContent}</StreamingMarkdown>
    }

    // Handle content blocks
    const renderedBlocks = message.content
      .map((block, index) => {
        if (block.type === "text" && block.text) {
          const displayText =
            !isUser && reasoningText ? stripThinkBlocksForDisplay(block.text) : block.text
          if (!displayText.trim()) return null
          // Use streaming markdown for assistant text blocks
          if (isUser) {
            const { visibleText, skillName } = parseUserVisibleSkillContent(displayText)
            return (
              <div
                key={index}
                className="whitespace-pre-wrap break-words text-[15px] leading-7 text-foreground/95 [overflow-wrap:anywhere]"
              >
                {skillName && <SkillChip label={skillName} compact className="mr-2" />}
                {visibleText}
              </div>
            )
          }
          return (
            <StreamingMarkdown key={index} isStreaming={isStreaming}>
              {displayText}
            </StreamingMarkdown>
          )
        }
        return null
      })
      .filter(Boolean)

    return renderedBlocks.length > 0 ? renderedBlocks : null
  }

  const content = renderContent()
  const displayToolCalls = message.tool_calls?.map(normalizeToolCallForDisplay)
  const hasToolCalls = displayToolCalls && displayToolCalls.length > 0
  const shouldShowAssistantActions =
    showAssistantMeta && !isLoading && Boolean(content || hasToolCalls)
  const canSetGoalFromMessage =
    isUser && Boolean(onSetGoalFromMessage) && !plainTextForCopy.trim().startsWith("/goal")

  const handleCopyMessage = async (): Promise<void> => {
    if (!plainTextForCopy.trim()) {
      toast.error("该消息暂无可复制内容")
      return
    }

    try {
      await navigator.clipboard.writeText(plainTextForCopy)
      setCopySuccess(true)
      setTimeout(() => setCopySuccess(false), 1800)
    } catch (error) {
      console.error("[MessageBubble] Failed to copy message:", error)
      toast.error("复制失败，请重试")
    }
  }

  const handleOpenFeedbackDialog = (type: "like" | "dislike") => {
    setFeedbackDialogOpen(true)
    if (type === "like") {
      setLikedMessageId(message.id)
      setDislikedMessageId(null)
    } else {
      setLikedMessageId(null)
      setDislikedMessageId(message.id)
    }
  }

  const handleFeedbackSubmit = async (
    type: "like" | "dislike",
    payload?: DislikeFeedbackPayload
  ) => {
    setFeedbackSubmitting(true)
    try {
      // Track feedback event
      if (type === "like") {
        window.electron?.ipcRenderer
          ?.invoke("track-event", {
            eventName: "message.feedback.like",
            eventCategory: "chat",
            properties: {
              messageId: message.id,
              threadId: threadId
            }
          })
          .catch((err) => console.error("Failed to track like event:", err))
      } else {
        window.electron?.ipcRenderer
          ?.invoke("track-event", {
            eventName: "message.feedback.dislike.submit",
            eventCategory: "chat",
            properties: {
              feedbackId: payload?.feedbackId ?? "",
              dislikeType: payload?.feedbackType ?? payload?.feedbackId ?? "",
              dislikeTypeLabel: payload?.feedbackTypeLabel ?? "",
              dislikeText: payload?.feedbackText ?? "",
              feedbackText: payload?.feedbackText ?? "",
              messageId: message.id,
              threadId: threadId
            }
          })
          .catch((err) => console.error("Failed to track dislike feedback:", err))
      }
    } catch (error) {
      console.error("反馈提交失败", error)
      toast.error("反馈提交失败，请重试")
    } finally {
      setFeedbackSubmitting(false)
      setFeedbackDialogOpen(false)
    }
  }

  // Don't render if there's no content and no tool calls
  if (!content && !hasToolCalls && !reasoningText) {
    return null
  }

  if (isUser) {
    return (
      <div className="group flex justify-end overflow-hidden py-4">
        <div className="flex min-w-0 max-w-[80%] flex-col items-end gap-1">
          <div
            className={cn(
              "min-w-0 max-w-full overflow-hidden rounded-lg p-3",
              goalUserSetMessage || goalUserControlMessage
                ? "border border-black/[0.07] bg-white/86 shadow-[0_14px_42px_rgba(24,24,27,0.10),0_1px_0_rgba(255,255,255,0.88)_inset]"
                : "bg-primary/10"
            )}
          >
            <div
              ref={userContentRef}
              className={cn(
                "relative min-w-0 max-w-full overflow-hidden",
                userContentOverflow && !userContentExpanded && "[mask-image:linear-gradient(to_bottom,black_60%,transparent)]"
              )}
              style={
                userContentOverflow && !userContentExpanded
                  ? { maxHeight: USER_MESSAGE_COLLAPSED_MAX_PX }
                  : undefined
              }
            >
              {content}
            </div>
            {userContentOverflow && (
              <button
                type="button"
                onClick={() => setUserContentExpanded((prev) => !prev)}
                className="mt-1.5 inline-flex items-center gap-1 text-xs text-muted-foreground/80 transition-colors hover:text-foreground"
                aria-expanded={userContentExpanded}
              >
                {userContentExpanded ? (
                  <>
                    <ChevronUp className="size-3.5" />
                    收起
                  </>
                ) : (
                  <>
                    <ChevronDown className="size-3.5" />
                    显示更多
                  </>
                )}
              </button>
            )}
          </div>
          <div className="flex items-center gap-1 opacity-0 transition-opacity group-hover:opacity-100">
            {userSendTimeLabel && (
              <span className="px-1 text-xs text-muted-foreground/70">{userSendTimeLabel}</span>
            )}
            <button
              type="button"
              onClick={handleCopyMessage}
              className="inline-flex items-center justify-center rounded p-1 text-muted-foreground hover:text-foreground hover:bg-background-interactive transition-colors"
              title="复制消息"
              aria-label="复制消息"
            >
              {copySuccess ? (
                <Check className="size-3 text-status-nominal" />
              ) : (
                <Copy className="size-3" />
              )}
            </button>
            <button
              type="button"
              onClick={() => onEditUserMessage?.(message)}
              className="inline-flex items-center justify-center rounded p-1 text-muted-foreground hover:text-foreground hover:bg-background-interactive transition-colors"
              title="编辑后重新发送"
              aria-label="编辑后重新发送"
            >
              <PencilLine className="size-3" />
            </button>
            {canSetGoalFromMessage && (
              <button
                type="button"
                onClick={() => onSetGoalFromMessage?.(plainTextForCopy)}
                className="inline-flex items-center gap-1 rounded px-1.5 py-1 text-muted-foreground hover:text-foreground hover:bg-background-interactive transition-colors"
                title="设为 Goal"
                aria-label="设为 Goal"
              >
                <Flag className="size-3" />
                <span className="text-[11px]">设为目标</span>
              </button>
            )}
          </div>
        </div>
      </div>
    )
  }

  return (
    <div className="group overflow-hidden space-y-1.5">
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
          {!shouldHideDuration && <DurationShow durationMs={duration} text="耗时" />}
        </div>
      )}
      <div className="flex-1 min-w-0 space-y-2 overflow-hidden">
        {reasoningText && (
          <div className="px-3">
            <button
              type="button"
              onClick={() => setReasoningOpen((open) => !open)}
              className="inline-flex items-center gap-1.5 rounded-md border border-border/70 bg-muted/35 px-2 py-1 text-xs text-muted-foreground transition-colors hover:bg-muted/70 hover:text-foreground"
              aria-expanded={reasoningOpen}
            >
              {reasoningOpen ? (
                <ChevronDown className="size-3.5" />
              ) : (
                <ChevronRight className="size-3.5" />
              )}
              <span>思考</span>
            </button>
            {reasoningOpen && (
              <div className="mt-2 rounded-md border border-border/70 bg-muted/25 px-3 py-2 text-sm text-muted-foreground">
                <StreamingMarkdown isStreaming={Boolean(isStreaming)}>
                  {reasoningText}
                </StreamingMarkdown>
              </div>
            )}
          </div>
        )}
        {content && (
          <div className="min-w-0 max-w-full overflow-hidden break-words rounded-lg px-3 [overflow-wrap:anywhere]">
            {content}
          </div>
        )}
        {hasToolCalls && (
          <div className="space-y-2 overflow-hidden">
            {displayToolCalls!.map((toolCall, index) => {
              const toolId = getWorkerToolUiKey(message.id, toolCall.id, index)
              const toolState = toolCallStates?.get(toolId)
              const resolvedToolCall = hydrateToolCall(toolCall, toolState)
              const result = toolResults?.get(toolId)
              const pendingIds = pendingApproval?.pendingToolCallIds
              const needsApproval = pendingApprovalToolCallKeys
                ? pendingApprovalToolCallKeys.has(toolId)
                : Boolean(
                    pendingIds?.length
                      ? pendingIds.includes(toolCall.id)
                      : pendingApproval?.tool_call?.id &&
                          pendingApproval.tool_call.id === toolCall.id
                  )
              const inferredStatus: ToolCallStatus =
                toolState?.status ||
                (needsApproval
                  ? "awaiting_approval"
                  : result !== undefined
                    ? result.is_error
                      ? "failed"
                      : "completed"
                    : isResultlessCompletedToolCall(resolvedToolCall)
                      ? "completed"
                    : isStreaming
                      ? "running"
                      : "interrupted")
              const statusMeta = getToolStatusMeta(inferredStatus)
              const isHtmlTool = isHtmlRenderToolCall(resolvedToolCall)
              const isExpanded = isHtmlTool
                ? collapsedHtmlTools.has(toolId)
                : collapsedTools.has(toolId)
              const summary = getToolCallSummary(resolvedToolCall)
              const previewPath = getToolPreviewPath(resolvedToolCall)
              const isOk = result !== undefined && !result.is_error

              // 如果工具需要审批，使用原来的ToolCallRenderer（批量时隐藏按钮）
              if (needsApproval) {
                const isBatch = (pendingApproval?.pendingCount ?? 1) > 1
                // git commit is approved through the dedicated task-card dialog, so the
                // inline approve/reject buttons are hidden to avoid a second (card-less) path.
                const pendingOperation = (pendingApproval as unknown as {
                  operation?: string
                } | null)?.operation
                const isGitCommitApproval = pendingOperation === "git_commit"
                const isAutoGitPushApproval =
                  autoApproveGitPush && pendingOperation === "git_push"
                return (
                  <ToolCallRenderer
                    key={`${toolId}-${needsApproval ? "pending" : "done"}`}
                    toolCall={resolvedToolCall}
                    result={result?.content}
                    isError={result?.is_error}
                    status={inferredStatus}
                    needsApproval={needsApproval}
                    showApprovalButtons={!isBatch && !isGitCommitApproval && !isAutoGitPushApproval}
                    onApprovalDecision={onApprovalDecision}
                    approvalTypes={
                      (
                        pendingApproval as unknown as {
                          _approvalTypes?: (
                            | "approve"
                            | "approve_session"
                            | "approve_permanent"
                            | "reject"
                          )[]
                        }
                      )?._approvalTypes
                    }
                    threadId={threadId}
                    isStreaming={isStreaming}
                  />
                )
              }

              // 工具执行完成后，显示折叠的标题
              return (
                <div
                  key={toolId}
                  className="rounded-sm border overflow-hidden border-border bg-background-elevated"
                >
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

                    <span className="text-xs font-medium min-w-0 max-w-[420px] truncate text-left">
                      {summary}
                    </span>
                    <div className="ml-auto flex items-center gap-2 shrink-0">
                      {previewPath && isOk && (
                        <button
                          type="button"
                          onClick={(e) => {
                            e.stopPropagation()
                            emitOpenResourcePreview({ threadId, filePath: previewPath })
                          }}
                          className="inline-flex items-center justify-center rounded border border-border/70 bg-background px-1.5 py-1 text-muted-foreground hover:text-foreground hover:bg-accent/30 transition-colors"
                          title="在右侧资源预览中打开"
                          aria-label="在右侧资源预览中打开"
                        >
                          <Eye className="size-3" />
                        </button>
                      )}

                      {/* 状态指示器 */}
                      <div
                        className={`shrink-0 px-2 py-0.5 text-[10px] font-medium rounded ${statusMeta.className}`}
                      >
                        {statusMeta.label}
                      </div>
                    </div>
                  </button>

                  {/* 展开的详细内容 */}
                  {isExpanded && (
                    <div className="border-t border-border">
                      <ToolCallRenderer
                        toolCall={resolvedToolCall}
                        result={result?.content}
                        isError={result?.is_error}
                        status={inferredStatus}
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
            {pendingApproval &&
              (pendingApproval.pendingCount ?? 1) > 1 &&
              onApprovalDecision &&
              message.tool_calls!.some(
                (tc) =>
                  pendingApproval.pendingToolCallIds?.includes(tc.id) ||
                  pendingApproval.tool_call?.id === tc.id
              ) && (
                <div className="rounded-sm border border-amber-500/50 bg-amber-500/5 px-3 py-2.5 flex items-center justify-between">
                  <div className="flex items-center gap-2">
                    <span className="text-xs text-amber-600 dark:text-amber-400 font-medium whitespace-nowrap">
                      共 {pendingApproval.pendingCount} 个命令待审批
                    </span>
                    <span className="text-xs text-status-warning bg-status-warning/10 px-2 py-1 rounded-sm whitespace-nowrap">
                      💡 启用 YOLO 模式可跳过审批
                    </span>
                  </div>
                  <div className="flex items-center gap-2">
                    <button
                      className="px-3 py-1.5 text-xs border border-border rounded-sm hover:bg-background-interactive transition-colors"
                      onClick={(e) => {
                        e.stopPropagation()
                        onApprovalDecision("reject")
                      }}
                    >
                      全部拒绝
                    </button>
                    <button
                      className="px-3 py-1.5 text-xs bg-status-nominal text-background rounded-sm hover:bg-status-nominal/90 transition-colors"
                      onClick={(e) => {
                        e.stopPropagation()
                        onApprovalDecision("approve")
                      }}
                    >
                      全部批准并执行
                    </button>
                  </div>
                </div>
              )}
          </div>
        )}
        {shouldShowAssistantActions && (
          <div className="flex items-center gap-1 px-3 opacity-0 transition-opacity group-hover:opacity-100">
            {/*<span className="text-[11px] text-muted-foreground">{createdAtLabel}</span>*/}
            <button
              type="button"
              onClick={handleCopyMessage}
              className="inline-flex items-center justify-center rounded p-1 text-muted-foreground hover:text-foreground hover:bg-background-interactive transition-colors"
              title="复制消息"
              aria-label="复制消息"
            >
              {copySuccess ? (
                <Check className="size-3 text-status-nominal" />
              ) : (
                <Copy className="size-3" />
              )}
            </button>
            {canForkFromMessage ? (
              <button
                type="button"
                onClick={() => onForkFromMessage?.(message)}
                disabled={forkFromMessageDisabled}
                className={cn(
                  "inline-flex items-center justify-center rounded p-1 transition-all transform active:scale-95",
                  forkFromMessageDisabled
                    ? "cursor-not-allowed text-muted-foreground/40"
                    : "text-muted-foreground hover:text-foreground hover:bg-background-interactive hover:scale-110"
                )}
                title={isLoading ? "运行中，无法 fork" : "从这里 fork"}
                aria-label="从这里 fork"
              >
                {isForkingThisMessage ? (
                  <Loader2 className="size-3 animate-spin" />
                ) : (
                  <GitFork className="size-3" />
                )}
              </button>
            ) : null}
            {/* 点赞按钮 */}
            <button
              type="button"
              onClick={() => {
                setLikedMessageId(message.id)
                setDislikedMessageId(null)
                handleFeedbackSubmit("like")
              }}
              className={`inline-flex items-center justify-center rounded p-1 transition-all transform hover:scale-110 active:scale-95 ${
                likedMessageId === message.id
                  ? "text-green-500"
                  : "text-muted-foreground hover:text-foreground hover:bg-background-interactive"
              }`}
              title="点赞"
              aria-label="点赞"
            >
              {likedMessageId === message.id ? (
                <Smile className="size-3" />
              ) : (
                <ThumbsUp className="size-3" />
              )}
            </button>
            {/* 点踩按钮 */}
            <button
              type="button"
              onClick={() => {
                handleOpenFeedbackDialog("dislike")
              }}
              className={`inline-flex items-center justify-center rounded p-1 transition-all transform hover:scale-110 active:scale-95 ${
                dislikedMessageId === message.id
                  ? "text-red-500"
                  : "text-muted-foreground hover:text-foreground hover:bg-background-interactive"
              }`}
              title="点踩"
              aria-label="点踩"
            >
              {dislikedMessageId === message.id ? (
                <Frown className="size-3" />
              ) : (
                <ThumbsDown className="size-3" />
              )}
            </button>
          </div>
        )}
      </div>
      {/* 点赞点踩反馈对话框 */}
      <MessageFeedbackDialog
        open={feedbackDialogOpen}
        onClose={() => setFeedbackDialogOpen(false)}
        onSubmit={handleFeedbackSubmit}
        submitting={feedbackSubmitting}
      />
    </div>
  )
}

// Memoized so off-screen/unchanged bubbles skip React reconciliation when the
// parent re-renders (which happens on every streaming token). The container
// passes stable, memoized props (message, toolResults, toolCallStates and
// useCallback handlers), so the default shallow comparison is effective.
export const MessageBubble = React.memo(MessageBubbleImpl)
