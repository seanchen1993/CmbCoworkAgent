import { useMemo, useState } from "react"
import { Bot, ChevronDown, ChevronRight, User, Wrench } from "lucide-react"
import { cn } from "@/lib/utils"

type TraceRole = "user" | "assistant" | "tool"

interface TraceConversationNode {
  type?: string
  name?: string
  input?: unknown
  output?: unknown
}

interface TraceConversationToolCall {
  name?: string
}

interface TraceConversationModelCall {
  outputMessage?: {
    content?: unknown
  }
  toolCalls?: TraceConversationToolCall[]
}

interface TraceConversationStep {
  assistantText?: string
  toolCalls?: TraceConversationToolCall[]
}

export interface TraceConversationSource {
  userMessage?: string
  startedAt?: string
  outcome?: string
  errorMessage?: string
  totalToolCalls?: number
  nodes?: TraceConversationNode[]
  modelCalls?: TraceConversationModelCall[]
  steps?: TraceConversationStep[]
}

export interface TraceConversationMessage {
  role: TraceRole
  content: string
  label: string
}

export interface TraceConversationSummary {
  messages: TraceConversationMessage[]
  toolNames: string[]
  assistantText: string
  userText: string
}

function formatMessageTime(iso?: string): string {
  if (!iso) return ""
  const date = new Date(iso)
  if (Number.isNaN(date.getTime())) return ""
  return date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {}
}

function textFromUnknown(value: unknown): string {
  if (typeof value === "string") return value.trim()
  if (Array.isArray(value)) {
    return value.map(textFromUnknown).filter(Boolean).join("\n").trim()
  }
  const record = asRecord(value)
  if (typeof record.text === "string") return record.text.trim()
  if (typeof record.content === "string") return record.content.trim()
  if (typeof record.userMessage === "string") return record.userMessage.trim()
  if (typeof record._traceTruncatedJson === "string") return record._traceTruncatedJson.trim()
  return ""
}

function uniqueToolNames(names: string[]): string[] {
  const seen = new Set<string>()
  const result: string[] = []
  for (const raw of names) {
    const name = raw.trim()
    if (!name || seen.has(name)) continue
    seen.add(name)
    result.push(name)
  }
  return result
}

function isUsefulAssistantText(text: string): boolean {
  const normalized = text.trim()
  if (!normalized) return false
  if (/^(completed|run completed|success)$/i.test(normalized)) return false
  return true
}

export function buildTraceConversation(trace: TraceConversationSource | null | undefined): TraceConversationSummary {
  if (!trace) {
    return { messages: [], toolNames: [], assistantText: "", userText: "" }
  }

  const rootInput = trace.nodes?.find((node) => node.type === "trace")?.input
  const userText = textFromUnknown(trace.userMessage) || textFromUnknown(rootInput)

  const assistantCandidates = [
    ...(trace.modelCalls ?? []).map((call) => textFromUnknown(call.outputMessage?.content)),
    ...(trace.nodes ?? [])
      .filter((node) => node.type === "llm" || node.type === "message")
      .map((node) => textFromUnknown(node.output)),
    ...(trace.steps ?? []).map((step) => step.assistantText?.trim() ?? "")
  ].filter(isUsefulAssistantText)

  let assistantText = assistantCandidates[assistantCandidates.length - 1] ?? ""
  if (!assistantText && trace.outcome === "error") {
    assistantText = trace.errorMessage?.trim() || "本次运行失败，trace 中没有记录最终回复。"
  } else if (!assistantText && trace.outcome === "cancelled") {
    assistantText = "本次运行被取消，trace 中没有记录最终回复。"
  }

  const toolNames = uniqueToolNames([
    ...(trace.nodes ?? [])
      .filter((node) => node.type === "tool")
      .map((node) => node.name ?? ""),
    ...(trace.modelCalls ?? []).flatMap((call) => call.toolCalls ?? []).map((tool) => tool.name ?? ""),
    ...(trace.steps ?? []).flatMap((step) => step.toolCalls ?? []).map((tool) => tool.name ?? "")
  ])

  const messages: TraceConversationMessage[] = []
  if (userText) messages.push({ role: "user", label: "用户", content: userText })
  if (assistantText) messages.push({ role: "assistant", label: "助手", content: assistantText })
  if (toolNames.length > 0) {
    messages.push({
      role: "tool",
      label: "工具",
      content: `调用 ${trace.totalToolCalls ?? toolNames.length} 次工具：${toolNames.slice(0, 8).join("、")}${toolNames.length > 8 ? " 等" : ""}`
    })
  }

  return { messages, toolNames, assistantText, userText }
}

export function buildThreadConversation(traces: TraceConversationSource[]): TraceConversationSummary {
  const ordered = [...traces].sort((a, b) => {
    const left = a.startedAt ?? ""
    const right = b.startedAt ?? ""
    return left.localeCompare(right)
  })
  const messages: TraceConversationMessage[] = []
  const allToolNames: string[] = []

  for (const trace of ordered) {
    const item = buildTraceConversation(trace)
    const time = formatMessageTime(trace.startedAt)
    const suffix = time ? ` · ${time}` : ""
    if (item.userText) {
      messages.push({ role: "user", label: `用户${suffix}`, content: item.userText })
    }
    if (item.assistantText) {
      messages.push({ role: "assistant", label: `助手${suffix}`, content: item.assistantText })
    }
    allToolNames.push(...item.toolNames)
  }

  const toolNames = uniqueToolNames(allToolNames)
  const assistantText =
    [...messages].reverse().find((message) => message.role === "assistant")?.content ?? ""
  const userText = messages.find((message) => message.role === "user")?.content ?? ""

  return { messages, toolNames, assistantText, userText }
}

function roleIcon(role: TraceRole): React.JSX.Element {
  if (role === "user") return <User className="size-3.5" />
  if (role === "tool") return <Wrench className="size-3.5" />
  return <Bot className="size-3.5" />
}

export function TraceConversation({
  trace,
  className,
  title = "对话还原"
}: {
  trace: TraceConversationSource
  className?: string
  title?: string
}): React.JSX.Element {
  const [toolsOpen, setToolsOpen] = useState(false)
  const conversation = useMemo(() => buildTraceConversation(trace), [trace])
  const visibleMessages = conversation.messages.filter((message) => message.role !== "tool")

  if (conversation.messages.length === 0) {
    return (
      <section className={cn("rounded-lg border border-dashed border-border px-4 py-3 text-xs text-muted-foreground", className)}>
        trace 中暂无可还原的对话内容
      </section>
    )
  }

  return (
    <section className={cn("space-y-3 rounded-lg border border-border bg-card/50 px-4 py-3", className)}>
      <div className="flex items-center justify-between gap-3">
        <h4 className="text-xs font-semibold text-foreground">{title}</h4>
        {conversation.toolNames.length > 0 && (
          <button
            type="button"
            className="inline-flex items-center gap-1 text-[10px] text-muted-foreground hover:text-foreground"
            onClick={() => setToolsOpen((value) => !value)}
          >
            {toolsOpen ? <ChevronDown className="size-3" /> : <ChevronRight className="size-3" />}
            工具 {trace.totalToolCalls ?? conversation.toolNames.length} 次
          </button>
        )}
      </div>

      <div className="space-y-2">
        {visibleMessages.map((message, index) => (
          <div
            key={`${message.role}-${index}`}
            className={cn(
              "flex gap-2",
              message.role === "user" ? "justify-end" : "justify-start"
            )}
          >
            {message.role !== "user" && (
              <span className="mt-1 inline-flex size-6 shrink-0 items-center justify-center rounded-md bg-primary/10 text-primary">
                {roleIcon(message.role)}
              </span>
            )}
            <div
              className={cn(
                "max-w-[78%] rounded-lg px-3 py-2 text-xs leading-5 shadow-sm",
                message.role === "user"
                  ? "bg-primary text-primary-foreground"
                  : "border border-border bg-background text-foreground"
              )}
            >
              <div className={cn(
                "mb-1 text-[10px] font-medium",
                message.role === "user" ? "text-primary-foreground/70" : "text-muted-foreground"
              )}>
                {message.label}
              </div>
              <div className="whitespace-pre-wrap break-words">{message.content}</div>
            </div>
            {message.role === "user" && (
              <span className="mt-1 inline-flex size-6 shrink-0 items-center justify-center rounded-md bg-primary text-primary-foreground">
                {roleIcon(message.role)}
              </span>
            )}
          </div>
        ))}
      </div>

      {toolsOpen && conversation.toolNames.length > 0 && (
        <div className="flex flex-wrap gap-1.5 border-t border-border/70 pt-2">
          {conversation.toolNames.map((name) => (
            <span key={name} className="rounded-md border border-border bg-background px-2 py-0.5 text-[10px] text-muted-foreground">
              {name}
            </span>
          ))}
        </div>
      )}
    </section>
  )
}

export function TraceThreadConversation({
  traces,
  className,
  title = "Thread 对话还原"
}: {
  traces: TraceConversationSource[]
  className?: string
  title?: string
}): React.JSX.Element {
  const [toolsOpen, setToolsOpen] = useState(false)
  const conversation = useMemo(() => buildThreadConversation(traces), [traces])
  const totalToolCalls = traces.reduce((sum, trace) => sum + (trace.totalToolCalls ?? 0), 0)

  if (conversation.messages.length === 0) {
    return (
      <section className={cn("rounded-lg border border-dashed border-border px-4 py-3 text-xs text-muted-foreground", className)}>
        thread 中暂无可还原的对话内容
      </section>
    )
  }

  return (
    <section className={cn("space-y-3 rounded-lg border border-border bg-card/50 px-4 py-3", className)}>
      <div className="flex items-center justify-between gap-3">
        <div>
          <h4 className="text-xs font-semibold text-foreground">{title}</h4>
          <p className="mt-0.5 text-[10px] text-muted-foreground">
            已聚合 {traces.length} 条 trace 的用户输入与助手回复
          </p>
        </div>
        {conversation.toolNames.length > 0 && (
          <button
            type="button"
            className="inline-flex items-center gap-1 text-[10px] text-muted-foreground hover:text-foreground"
            onClick={() => setToolsOpen((value) => !value)}
          >
            {toolsOpen ? <ChevronDown className="size-3" /> : <ChevronRight className="size-3" />}
            工具 {totalToolCalls || conversation.toolNames.length} 次
          </button>
        )}
      </div>

      <div className="max-h-[360px] space-y-3 overflow-y-auto pr-1">
        {conversation.messages.map((message, index) => (
          <div
            key={`${message.role}-${index}`}
            className={cn("flex gap-2", message.role === "user" ? "justify-end" : "justify-start")}
          >
            {message.role !== "user" && (
              <span className="mt-1 inline-flex size-6 shrink-0 items-center justify-center rounded-md bg-primary/10 text-primary">
                {roleIcon(message.role)}
              </span>
            )}
            <div
              className={cn(
                "max-w-[78%] rounded-lg px-3 py-2 text-xs leading-5 shadow-sm",
                message.role === "user"
                  ? "bg-primary text-primary-foreground"
                  : "border border-border bg-background text-foreground"
              )}
            >
              <div className={cn(
                "mb-1 text-[10px] font-medium",
                message.role === "user" ? "text-primary-foreground/70" : "text-muted-foreground"
              )}>
                {message.label}
              </div>
              <div className="whitespace-pre-wrap break-words">{message.content}</div>
            </div>
            {message.role === "user" && (
              <span className="mt-1 inline-flex size-6 shrink-0 items-center justify-center rounded-md bg-primary text-primary-foreground">
                {roleIcon(message.role)}
              </span>
            )}
          </div>
        ))}
      </div>

      {toolsOpen && conversation.toolNames.length > 0 && (
        <div className="flex flex-wrap gap-1.5 border-t border-border/70 pt-2">
          {conversation.toolNames.map((name) => (
            <span key={name} className="rounded-md border border-border bg-background px-2 py-0.5 text-[10px] text-muted-foreground">
              {name}
            </span>
          ))}
        </div>
      )}
    </section>
  )
}
