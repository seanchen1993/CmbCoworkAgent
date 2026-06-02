import { useEffect, useMemo, useRef, useState } from "react"
import { Bot, ChevronDown, ChevronRight, User, Wrench } from "lucide-react"
import { cn } from "@/lib/utils"
import { parseSkillUseBlock } from "@/features/slash-commands/skill-marker"

type TraceRole = "user" | "assistant" | "tool"

interface TraceConversationNode {
  id?: string
  type?: string
  parentId?: string | null
  name?: string
  input?: unknown
  output?: unknown
  status?: string
  metadata?: Record<string, unknown>
}

interface TraceConversationToolCall {
  name?: string
  args?: unknown
  result?: unknown
  durationMs?: number
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
  traceId?: string
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
  tools?: TraceConversationToolInfo[]
  /** Which trace this message was reconstructed from (thread view only). */
  traceId?: string
}

export interface TraceConversationSummary {
  messages: TraceConversationMessage[]
  toolNames: string[]
  tools: TraceConversationToolInfo[]
  assistantText: string
  userText: string
}

interface TraceConversationToolInfo {
  name: string
  input?: unknown
  output?: unknown
  durationMs?: number
  status?: string
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

/**
 * Slash-command invocations append a verbose `<CMBDEVCLAW-SKILL-USE-V1>` block
 * (read-instructions + name + path) to the end of the user message. That block
 * is plumbing meant for the model, not something a human wants to read back in
 * the conversation reconstruction. Strip it: keep the user's own prose, and if
 * the prose is empty, fall back to a short "使用 /skill 技能" label.
 */
function cleanUserText(raw: string): string {
  const text = raw.trim()
  if (!text) return text
  const parsed = parseSkillUseBlock(text)
  if (!parsed) return text
  const prose = parsed.rest.trim()
  return prose || `使用 /${parsed.skillName} 技能`
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

function summarizeToolNames(tools: TraceConversationToolInfo[], limit = 8): string {
  const counts = new Map<string, number>()
  for (const tool of tools) {
    const name = tool.name.trim() || "unknown"
    counts.set(name, (counts.get(name) ?? 0) + 1)
  }
  const labels = [...counts.entries()].map(([name, count]) =>
    count > 1 ? `${name} x${count}` : name
  )
  if (labels.length <= limit) return labels.join("、")
  return `${labels.slice(0, limit).join("、")} 等`
}

function serializeValue(value: unknown): string {
  if (value === undefined || value === null) return ""
  let text = ""
  if (typeof value === "string") {
    text = value
  } else {
    try {
      text = JSON.stringify(value, null, 2)
    } catch {
      text = String(value)
    }
  }
  return text.trim()
}

function formatDuration(ms?: number): string {
  if (!ms || !Number.isFinite(ms)) return ""
  if (ms < 1000) return `${Math.round(ms)}ms`
  return `${(ms / 1000).toFixed(1)}s`
}

function extractToolInfos(trace: TraceConversationSource): TraceConversationToolInfo[] {
  const nodeTools = (trace.nodes ?? [])
    .filter((node) => node.type === "tool")
    .map((node): TraceConversationToolInfo => {
      const toolCallId =
        typeof node.metadata?.toolCallId === "string" ? node.metadata.toolCallId : undefined
      const resultNode = (trace.nodes ?? []).find((candidate) => {
        if (candidate.type !== "tool_result") return false
        if (node.id && candidate.parentId === node.id) return true
        if (candidate.metadata?.toolCallId && toolCallId) {
          return candidate.metadata.toolCallId === toolCallId
        }
        return false
      })
      return {
        name: node.name ?? "unknown",
        input: node.input,
        output: resultNode?.output,
        status: resultNode?.status ?? node.status
      }
    })
  if (nodeTools.length > 0) return nodeTools

  const stepTools = (trace.steps ?? []).flatMap((step) =>
    (step.toolCalls ?? []).map((tool): TraceConversationToolInfo => ({
      name: tool.name ?? "unknown",
      input: tool.args,
      output: tool.result,
      durationMs: tool.durationMs
    }))
  )
  if (stepTools.length > 0) return stepTools

  return (trace.modelCalls ?? []).flatMap((call) =>
    (call.toolCalls ?? []).map((tool): TraceConversationToolInfo => ({
      name: tool.name ?? "unknown",
      input: tool.args,
      output: tool.result,
      durationMs: tool.durationMs
    }))
  )
}

function isUsefulAssistantText(text: string): boolean {
  const normalized = text.trim()
  if (!normalized) return false
  if (/^(completed|run completed|success)$/i.test(normalized)) return false
  return true
}

export function buildTraceConversation(trace: TraceConversationSource | null | undefined): TraceConversationSummary {
  if (!trace) {
    return { messages: [], toolNames: [], tools: [], assistantText: "", userText: "" }
  }

  const rootInput = trace.nodes?.find((node) => node.type === "trace")?.input
  const userText = cleanUserText(textFromUnknown(trace.userMessage) || textFromUnknown(rootInput))

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

  const tools = extractToolInfos(trace)
  const toolNames = uniqueToolNames(tools.map((tool) => tool.name))

  const messages: TraceConversationMessage[] = []
  if (userText) messages.push({ role: "user", label: "用户", content: userText })
  if (assistantText) messages.push({ role: "assistant", label: "助手", content: assistantText })
  if (toolNames.length > 0) {
    messages.push({
      role: "tool",
      label: "工具",
      content: `调用 ${trace.totalToolCalls ?? tools.length} 次工具：${summarizeToolNames(tools)}`,
      tools
    })
  }

  return { messages, toolNames, tools, assistantText, userText }
}

export function buildThreadConversation(traces: TraceConversationSource[]): TraceConversationSummary {
  const ordered = [...traces].sort((a, b) => {
    const left = a.startedAt ?? ""
    const right = b.startedAt ?? ""
    return left.localeCompare(right)
  })
  const messages: TraceConversationMessage[] = []
  const allTools: TraceConversationToolInfo[] = []

  for (const trace of ordered) {
    const item = buildTraceConversation(trace)
    const time = formatMessageTime(trace.startedAt)
    const suffix = time ? ` · ${time}` : ""
    if (item.userText) {
      messages.push({ role: "user", label: `用户${suffix}`, content: item.userText, traceId: trace.traceId })
    }
    if (item.assistantText) {
      messages.push({
        role: "assistant",
        label: `助手${suffix}`,
        content: item.assistantText,
        traceId: trace.traceId
      })
    }
    if (item.tools.length > 0) {
      messages.push({
        role: "tool",
        label: `工具${suffix}`,
        content: `调用 ${trace.totalToolCalls ?? item.tools.length} 次工具：${summarizeToolNames(item.tools)}`,
        tools: item.tools,
        traceId: trace.traceId
      })
    }
    allTools.push(...item.tools)
  }

  const toolNames = uniqueToolNames(allTools.map((tool) => tool.name))
  const assistantText =
    [...messages].reverse().find((message) => message.role === "assistant")?.content ?? ""
  const userText = messages.find((message) => message.role === "user")?.content ?? ""

  return { messages, toolNames, tools: allTools, assistantText, userText }
}

function roleIcon(role: TraceRole): React.JSX.Element {
  if (role === "user") return <User className="size-3.5" />
  if (role === "tool") return <Wrench className="size-3.5" />
  return <Bot className="size-3.5" />
}

const VALUE_PREVIEW_LIMIT = 220

/**
 * Render a tool input/output value with a head preview and an opt-in "展开" to
 * reveal the rest. The execution tree used to be the only place you could see
 * the full value; now that it's gone this is the only window into tool args/
 * results, so a collapsed-by-default expander keeps the conversation compact
 * while still letting you read everything the trace retained.
 */
function ExpandableValue({ label, value }: { label: string; value: unknown }): React.JSX.Element | null {
  const [expanded, setExpanded] = useState(false)
  const text = serializeValue(value)
  if (!text) return null
  const truncated = text.length > VALUE_PREVIEW_LIMIT
  const shown = !truncated || expanded ? text : `${text.slice(0, VALUE_PREVIEW_LIMIT)}...`

  return (
    <div className="mt-1.5">
      <div className="text-[9px] uppercase tracking-wider text-muted-foreground/70">{label}</div>
      <pre className="mt-0.5 whitespace-pre-wrap break-all text-[10px] leading-4 text-muted-foreground">
        {shown}
      </pre>
      {truncated && (
        <button
          type="button"
          className="mt-0.5 text-[10px] text-blue-500 hover:underline"
          onClick={() => setExpanded((value) => !value)}
        >
          {expanded ? "收起" : "展开"}
        </button>
      )}
    </div>
  )
}

function ToolCallDetails({
  tools,
  label
}: {
  tools: TraceConversationToolInfo[]
  label?: string
}): React.JSX.Element | null {
  const [open, setOpen] = useState(false)

  if (tools.length === 0) return null

  return (
    <div className="rounded-lg border border-border bg-background shadow-sm">
      <button
        type="button"
        className="flex w-full items-center gap-1.5 px-3 py-2 text-left text-[11px] text-muted-foreground hover:text-foreground"
        onClick={() => setOpen((value) => !value)}
      >
        {open ? <ChevronDown className="size-3" /> : <ChevronRight className="size-3" />}
        <Wrench className="size-3" />
        <span className="font-medium">{label ?? `工具调用 ${tools.length} 次`}</span>
      </button>
      {open && (
        <div className="space-y-2 border-t border-border/60 px-2.5 py-2">
          {tools.map((tool, index) => (
            <div key={`${tool.name}-${index}`} className="rounded-md border border-border bg-background px-2.5 py-2">
              <div className="flex items-center gap-2 text-[11px]">
                <span className="font-medium text-foreground">{tool.name}</span>
                {tool.status && (
                  <span className="rounded border border-border px-1.5 py-0 text-[9px] uppercase text-muted-foreground">
                    {tool.status}
                  </span>
                )}
                {tool.durationMs ? (
                  <span className="ml-auto text-[10px] text-muted-foreground">{formatDuration(tool.durationMs)}</span>
                ) : null}
              </div>
              <ExpandableValue label="Input" value={tool.input} />
              <ExpandableValue label="Output" value={tool.output} />
            </div>
          ))}
        </div>
      )}
    </div>
  )
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
  const conversation = useMemo(() => buildTraceConversation(trace), [trace])

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
      </div>

      <div className="space-y-2">
        {conversation.messages.map((message, index) => (
          <div
            key={`${message.role}-${index}`}
            className={cn(
              "flex gap-2",
              message.role === "user" ? "justify-end" : "justify-start",
              message.role === "tool" ? "pl-8" : ""
            )}
          >
            {message.role !== "user" && message.role !== "tool" && (
              <span className="mt-1 inline-flex size-6 shrink-0 items-center justify-center rounded-md bg-primary/10 text-primary">
                {roleIcon(message.role)}
              </span>
            )}
            {message.role === "tool" && message.tools ? (
              <div className="max-w-[78%]">
                <ToolCallDetails tools={message.tools} label={message.content} />
              </div>
            ) : (
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
            )}
            {message.role === "user" && (
              <span className="mt-1 inline-flex size-6 shrink-0 items-center justify-center rounded-md bg-primary text-primary-foreground">
                {roleIcon(message.role)}
              </span>
            )}
          </div>
        ))}
      </div>
    </section>
  )
}

export function TraceThreadConversation({
  traces,
  className,
  title = "Thread 对话还原",
  loading = false,
  selectedTraceId
}: {
  traces: TraceConversationSource[]
  className?: string
  title?: string
  loading?: boolean
  /** When set, the matching trace's messages are highlighted and scrolled into view. */
  selectedTraceId?: string | null
}): React.JSX.Element {
  const conversation = useMemo(() => buildThreadConversation(traces), [traces])
  const scrollRef = useRef<HTMLDivElement>(null)

  // When the user picks a trace in the left list, jump the reconstructed
  // conversation to that trace's first message instead of forcing them to
  // scan the aggregated thread by hand.
  useEffect(() => {
    if (!selectedTraceId) return
    const container = scrollRef.current
    if (!container) return
    const target = container.querySelector<HTMLElement>(`[data-trace-id="${CSS.escape(selectedTraceId)}"]`)
    if (target) target.scrollIntoView({ behavior: "smooth", block: "center" })
  }, [selectedTraceId, conversation.messages.length])

  if (conversation.messages.length === 0) {
    return (
      <section className={cn("rounded-lg border border-dashed border-border px-4 py-3 text-xs text-muted-foreground", className)}>
        {loading ? "正在加载完整会话…" : "thread 中暂无可还原的对话内容"}
      </section>
    )
  }

  return (
    <section className={cn("space-y-3 rounded-lg border border-border bg-card/50 px-4 py-3", className)}>
      <div className="flex items-center justify-between gap-3">
        <div>
          <h4 className="text-xs font-semibold text-foreground">{title}</h4>
          <p className="mt-0.5 text-[10px] text-muted-foreground">
            {loading
              ? `正在加载完整会话…（已展示 ${traces.length} 条 trace）`
              : `已聚合 ${traces.length} 条 trace 的用户输入与助手回复`}
          </p>
        </div>
      </div>

      <div ref={scrollRef} className="max-h-[360px] space-y-3 overflow-y-auto pr-1">
        {conversation.messages.map((message, index) => {
          const isSelected = !!selectedTraceId && message.traceId === selectedTraceId
          return (
            <div
              key={`${message.role}-${index}`}
              data-trace-id={message.traceId}
              className={cn(
                "flex scroll-mt-2 gap-2",
                message.role === "user" ? "justify-end" : "justify-start",
                message.role === "tool" ? "pl-8" : ""
              )}
            >
              {message.role !== "user" && message.role !== "tool" && (
                <span className="mt-1 inline-flex size-6 shrink-0 items-center justify-center rounded-md bg-primary/10 text-primary">
                  {roleIcon(message.role)}
                </span>
              )}
              {message.role === "tool" && message.tools ? (
                <div className={cn("max-w-[78%] rounded-lg", isSelected && "ring-2 ring-primary/50")}>
                  <ToolCallDetails tools={message.tools} label={message.content} />
                </div>
              ) : (
                <div
                  className={cn(
                    "max-w-[78%] rounded-lg px-3 py-2 text-xs leading-5 shadow-sm",
                    message.role === "user"
                      ? "bg-primary text-primary-foreground"
                      : "border border-border bg-background text-foreground",
                    isSelected && "ring-2 ring-primary/50"
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
              )}
              {message.role === "user" && (
                <span className="mt-1 inline-flex size-6 shrink-0 items-center justify-center rounded-md bg-primary text-primary-foreground">
                  {roleIcon(message.role)}
                </span>
              )}
            </div>
          )
        })}
      </div>
    </section>
  )
}
