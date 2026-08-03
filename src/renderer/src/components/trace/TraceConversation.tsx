import { useEffect, useMemo, useRef, useState } from "react"
import { Bot, ChevronDown, ChevronRight, Route, User, Wrench } from "lucide-react"
import { cn } from "@/lib/utils"
import { parseSkillUseBlock } from "@/features/slash-commands/skill-marker"
import {
  classifyInternalNotificationTurn,
  type InternalNotificationTurnKind
} from "../../../../shared/internal-notification-turn"
import { summarizeThreadProjectNodes } from "./trace-project-node-summary"

type TraceRole = "user" | "assistant" | "tool" | "subagent"

interface TraceConversationNode {
  id?: string
  type?: string
  parentId?: string | null
  name?: string
  input?: unknown
  output?: unknown
  status?: string
  startedAt?: string
  endedAt?: string
  metadata?: Record<string, unknown>
}

interface TraceConversationToolCall {
  name?: string
  args?: unknown
  result?: unknown
  durationMs?: number
}

interface TraceConversationModelCall {
  startedAt?: string
  outputMessage?: {
    content?: unknown
    reasoning?: unknown
  }
  toolCalls?: TraceConversationToolCall[]
}

interface TraceConversationStep {
  startedAt?: string
  assistantText?: string
  toolCalls?: TraceConversationToolCall[]
}

export interface TraceConversationSource {
  traceId?: string
  userMessage?: string
  triggerSource?: string
  startedAt?: string
  endedAt?: string
  outcome?: string
  errorMessage?: string
  totalToolCalls?: number
  observabilitySchemaVersion?: number
  traceKind?: string
  executionMode?: string
  rootTraceId?: string
  rootThreadId?: string
  parentTraceId?: string
  parentThreadId?: string
  parentSpanId?: string
  linkType?: string
  subagentKind?: string
  subagentRunId?: string
  subagentThreadId?: string
  handoffAction?: string
  handoffSourceAgent?: string
  handoffTargetAgent?: string
  coordinatorWorkerId?: string
  coordinatorWorkerTurn?: number
  coordinatorWorkerRole?: string
  coordinatorWorkerWorkload?: string
  workflowRunId?: string
  workflowAgentIndex?: number
  workflowPhase?: string
  workflowAgentLabel?: string
  harnessProjectId?: string
  harnessFeatureSlug?: string
  harnessNodeName?: string
  harnessNodeStatus?: string
  nodes?: TraceConversationNode[]
  modelCalls?: TraceConversationModelCall[]
  steps?: TraceConversationStep[]
}

export interface TraceConversationMessage {
  role: TraceRole
  content: string
  label: string
  tools?: TraceConversationToolInfo[]
  reasoning?: string
  subagentRun?: TraceConversationSubagentRun
  /** Actual event time used by the aggregated thread timeline. */
  occurredAt?: string
  /** Which trace this message was reconstructed from (thread view only). */
  traceId?: string
}

export interface TraceConversationSummary {
  messages: TraceConversationMessage[]
  toolNames: string[]
  tools: TraceConversationToolInfo[]
  assistantText: string
  userText: string
  internalNotificationKind: InternalNotificationTurnKind | null
}

interface TraceConversationToolInfo {
  name: string
  input?: unknown
  output?: unknown
  durationMs?: number
  status?: string
}

interface TraceConversationSubagentRun {
  actorLabel: string
  sourceLabel: string
  instruction: string
  result: string
  reasoning?: string
  tools: TraceConversationToolInfo[]
  outcome?: string
  startedAt?: string
  endedAt?: string
}

function formatMessageTime(iso?: string): string {
  if (!iso) return ""
  const date = new Date(iso)
  if (Number.isNaN(date.getTime())) return ""
  return date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
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
    count > 1 ? `${name} ×${count}` : name
  )
  if (labels.length <= limit) return labels.join("、")
  return `${labels.slice(0, limit).join("、")} 等`
}

function shortId(value?: string): string {
  return value ? value.slice(0, 8) : ""
}

function isSubagentTrace(trace: TraceConversationSource): boolean {
  return trace.traceKind === "subagent" || Boolean(trace.parentTraceId || trace.subagentKind)
}

function traceActorLabel(trace: TraceConversationSource): string {
  if (trace.subagentKind === "coordinator_worker") {
    const role = trace.coordinatorWorkerRole === "verifier" ? "Verifier" : "Worker"
    return trace.coordinatorWorkerId ? `${role} ${trace.coordinatorWorkerId}` : role
  }
  if (trace.subagentKind === "workflow_agent") {
    return trace.workflowAgentLabel || `Workflow Agent ${trace.workflowAgentIndex ?? ""}`.trim()
  }
  if (trace.subagentKind === "task") return "Task Agent"
  if (trace.traceKind === "subagent") return "子 Agent"
  if (trace.executionMode === "coordinator") return "Agent Team"
  if (trace.executionMode === "workflow") return "Ultra Workflow"
  return "主 Agent"
}

function traceSourceLabel(trace: TraceConversationSource): string {
  if (trace.handoffSourceAgent === "coordinator" || trace.executionMode === "coordinator") {
    return "Agent Team"
  }
  if (trace.handoffSourceAgent === "ultra_workflow" || trace.executionMode === "workflow") {
    return "Ultra Workflow"
  }
  return "主 Agent"
}

function instructionLabel(trace: TraceConversationSource): string {
  return isSubagentTrace(trace) ? `${traceActorLabel(trace)} 指令` : "用户"
}

function responseLabel(trace: TraceConversationSource): string {
  if (isSubagentTrace(trace)) return `${traceActorLabel(trace)} 结果`
  if (trace.executionMode === "coordinator" || trace.executionMode === "workflow") {
    return `${traceActorLabel(trace)} 回复`
  }
  return "助手"
}

function toolMessageLabel(trace: TraceConversationSource): string {
  return isSubagentTrace(trace) ? `${traceActorLabel(trace)} 工具` : "工具"
}

function traceContextLabels(trace: TraceConversationSource): string[] {
  const labels = [traceActorLabel(trace)]
  if (trace.executionMode && trace.executionMode !== "normal") labels.push(trace.executionMode)
  if (trace.workflowPhase) labels.push(`phase ${trace.workflowPhase}`)
  if (trace.parentTraceId) labels.push(`parent ${shortId(trace.parentTraceId)}`)
  if (trace.rootTraceId && trace.rootTraceId !== trace.traceId)
    labels.push(`root ${shortId(trace.rootTraceId)}`)
  return labels
}

function displayToolCount(trace: TraceConversationSource, inferred: number): number {
  return trace.totalToolCalls && trace.totalToolCalls > 0 ? trace.totalToolCalls : inferred
}

function TraceContextPills({
  trace
}: {
  trace: TraceConversationSource
}): React.JSX.Element | null {
  const [actor, ...rest] = traceContextLabels(trace).filter(Boolean)
  if (!actor) return null
  return (
    <div className="flex min-w-0 flex-wrap items-center gap-x-1.5 gap-y-0.5">
      <span className="rounded border border-blue-500/25 bg-blue-500/10 px-1.5 text-[10px] leading-4 text-blue-700 dark:text-blue-300">
        {actor}
      </span>
      {rest.length > 0 && (
        <span className="truncate text-[10px] text-muted-foreground">{rest.join(" · ")}</span>
      )}
    </div>
  )
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

interface TimedToolGroup {
  occurredAt?: string
  tools: TraceConversationToolInfo[]
}

interface TimelineEntry {
  message: TraceConversationMessage
  timestamp: number
  traceOrder: number
  sequence: number
}

function validEventTime(...candidates: Array<string | undefined>): string | undefined {
  return candidates.find((candidate) => {
    if (!candidate) return false
    return !Number.isNaN(new Date(candidate).getTime())
  })
}

function eventTimestamp(occurredAt: string | undefined, traceOrder: number): number {
  if (occurredAt) {
    const parsed = new Date(occurredAt).getTime()
    if (!Number.isNaN(parsed)) return parsed
  }
  // Keep timestamp-less legacy events deterministic without moving them ahead
  // of every real event in the thread.
  return Number.MAX_SAFE_INTEGER - 10_000 + traceOrder
}

function nodeDurationMs(node: TraceConversationNode): number | undefined {
  if (!node.startedAt || !node.endedAt) return undefined
  const duration = new Date(node.endedAt).getTime() - new Date(node.startedAt).getTime()
  return Number.isFinite(duration) && duration >= 0 ? duration : undefined
}

function extractTimedToolGroups(trace: TraceConversationSource): TimedToolGroup[] {
  const nodes = trace.nodes ?? []
  const toolNodes = nodes.filter((node) => node.type === "tool")
  if (toolNodes.length > 0) {
    const grouped = new Map<string, TimedToolGroup>()
    for (const [index, node] of toolNodes.entries()) {
      const toolCallId =
        typeof node.metadata?.toolCallId === "string" ? node.metadata.toolCallId : undefined
      const resultNode = nodes.find((candidate) => {
        if (candidate.type !== "tool_result") return false
        if (node.id && candidate.parentId === node.id) return true
        return Boolean(
          candidate.metadata?.toolCallId &&
          toolCallId &&
          candidate.metadata.toolCallId === toolCallId
        )
      })
      const groupKey = node.parentId || node.id || `tool-${index}`
      const occurredAt = validEventTime(node.startedAt, resultNode?.startedAt, trace.startedAt)
      const group = grouped.get(groupKey) ?? { occurredAt, tools: [] }
      group.occurredAt = validEventTime(group.occurredAt, occurredAt)
      group.tools.push({
        name: node.name ?? "unknown",
        input: node.input,
        output: resultNode?.output,
        durationMs: nodeDurationMs(node),
        status: resultNode?.status ?? node.status
      })
      grouped.set(groupKey, group)
    }
    return [...grouped.values()]
  }

  const stepGroups = (trace.steps ?? []).flatMap((step): TimedToolGroup[] => {
    const tools = (step.toolCalls ?? []).map(
      (tool): TraceConversationToolInfo => ({
        name: tool.name ?? "unknown",
        input: tool.args,
        output: tool.result,
        durationMs: tool.durationMs
      })
    )
    return tools.length > 0
      ? [{ occurredAt: validEventTime(step.startedAt, trace.startedAt), tools }]
      : []
  })
  if (stepGroups.length > 0) return stepGroups

  const modelGroups = (trace.modelCalls ?? []).flatMap((call): TimedToolGroup[] => {
    const tools = (call.toolCalls ?? []).map(
      (tool): TraceConversationToolInfo => ({
        name: tool.name ?? "unknown",
        input: tool.args,
        output: tool.result,
        durationMs: tool.durationMs
      })
    )
    return tools.length > 0
      ? [{ occurredAt: validEventTime(call.startedAt, trace.startedAt), tools }]
      : []
  })
  if (modelGroups.length > 0) return modelGroups

  return nodes.flatMap((node): TimedToolGroup[] => {
    const toolNames = node.metadata?.toolNames
    if (!Array.isArray(toolNames)) return []
    const tools = toolNames
      .filter((name): name is string => typeof name === "string" && name.trim().length > 0)
      .map(
        (name): TraceConversationToolInfo => ({
          name,
          status: node.status,
          output: node.output
        })
      )
    return tools.length > 0
      ? [
          {
            occurredAt: validEventTime(
              node.startedAt,
              node.endedAt,
              trace.endedAt,
              trace.startedAt
            ),
            tools
          }
        ]
      : []
  })
}

function isUsefulAssistantText(text: string): boolean {
  const normalized = text.trim()
  if (!normalized) return false
  if (/^(completed|run completed|success)$/i.test(normalized)) return false
  return true
}

// Exported for deterministic reconstruction tests; UI components below consume the same builder.
// eslint-disable-next-line react-refresh/only-export-components
export function buildTraceConversation(
  trace: TraceConversationSource | null | undefined
): TraceConversationSummary {
  if (!trace) {
    return {
      messages: [],
      toolNames: [],
      tools: [],
      assistantText: "",
      userText: "",
      internalNotificationKind: null
    }
  }

  const rootInput = trace.nodes?.find((node) => node.type === "trace")?.input
  const rawUserText = textFromUnknown(trace.userMessage) || textFromUnknown(rootInput)
  const internalNotificationKind = classifyInternalNotificationTurn({
    content: rawUserText,
    executionMode: trace.executionMode,
    triggerSource: trace.triggerSource
  })
  const userText = internalNotificationKind ? "" : cleanUserText(rawUserText)

  const timeline = sortTimeline(buildTraceTimeline(trace, 0))
  const messages = timeline.map((entry) => entry.message)
  const assistantText =
    [...messages].reverse().find((message) => message.role === "assistant" && message.content)
      ?.content ?? ""
  const tools = messages.flatMap((message) => message.tools ?? [])
  const toolNames = uniqueToolNames(tools.map((tool) => tool.name))

  return {
    messages,
    toolNames,
    tools,
    assistantText,
    userText,
    internalNotificationKind
  }
}

function buildTraceTimeline(trace: TraceConversationSource, traceOrder: number): TimelineEntry[] {
  const entries: TimelineEntry[] = []
  let sequence = 0
  const add = (
    message: Omit<TraceConversationMessage, "occurredAt">,
    occurredAt?: string
  ): void => {
    const time = validEventTime(occurredAt, trace.startedAt)
    entries.push({
      message: {
        ...message,
        traceId: message.traceId ?? trace.traceId,
        occurredAt: time
      },
      timestamp: eventTimestamp(time, traceOrder),
      traceOrder,
      sequence: sequence++
    })
  }

  const rootInput = trace.nodes?.find((node) => node.type === "trace")?.input
  const rawUserText = textFromUnknown(trace.userMessage) || textFromUnknown(rootInput)
  const internalNotificationKind = classifyInternalNotificationTurn({
    content: rawUserText,
    executionMode: trace.executionMode,
    triggerSource: trace.triggerSource
  })
  const userText = internalNotificationKind ? "" : cleanUserText(rawUserText)
  if (userText) {
    add({ role: "user", label: instructionLabel(trace), content: userText }, trace.startedAt)
  }

  const llmNodes = (trace.nodes ?? []).filter((node) => node.type === "llm")
  const terminalMessageNodes = (trace.nodes ?? []).filter(
    (node) =>
      node.type === "message" &&
      node.name !== "User Message" &&
      isUsefulAssistantText(textFromUnknown(node.output))
  )
  // Collector terminal nodes are bookkeeping fallbacks. Once real LLM nodes
  // exist, rendering both would duplicate a Solo task's final answer.
  const nodeAssistantCandidates = llmNodes.length > 0 ? llmNodes : terminalMessageNodes
  let assistantCount = 0
  const addAssistant = (content: string, reasoning: string, occurredAt?: string): void => {
    if (!isUsefulAssistantText(content) && !reasoning) return
    assistantCount += 1
    add(
      {
        role: "assistant",
        label: responseLabel(trace),
        content,
        ...(reasoning ? { reasoning } : {})
      },
      occurredAt
    )
  }

  if (nodeAssistantCandidates.length > 0) {
    for (const node of nodeAssistantCandidates) {
      addAssistant(
        textFromUnknown(node.output),
        textFromUnknown(node.metadata?.reasoning),
        validEventTime(node.endedAt, node.startedAt, trace.endedAt, trace.startedAt)
      )
    }
  } else if ((trace.modelCalls ?? []).length > 0) {
    for (const call of trace.modelCalls ?? []) {
      addAssistant(
        textFromUnknown(call.outputMessage?.content),
        textFromUnknown(call.outputMessage?.reasoning),
        validEventTime(call.startedAt, trace.endedAt, trace.startedAt)
      )
    }
  } else {
    for (const step of trace.steps ?? []) {
      addAssistant(
        step.assistantText?.trim() ?? "",
        "",
        validEventTime(step.startedAt, trace.endedAt, trace.startedAt)
      )
    }
  }

  if (assistantCount === 0 && trace.outcome === "error") {
    addAssistant(
      trace.errorMessage?.trim() || "本次运行失败，trace 中没有记录最终回复。",
      "",
      trace.endedAt
    )
  } else if (assistantCount === 0 && trace.outcome === "cancelled") {
    addAssistant("本次运行被取消，trace 中没有记录最终回复。", "", trace.endedAt)
  }

  const toolGroups = extractTimedToolGroups(trace)
  for (const group of toolGroups) {
    const count =
      toolGroups.length === 1 ? displayToolCount(trace, group.tools.length) : group.tools.length
    add(
      {
        role: "tool",
        label: toolMessageLabel(trace),
        content: `调用 ${count} 次工具 · ${summarizeToolNames(group.tools)}`,
        tools: group.tools
      },
      group.occurredAt
    )
  }

  return entries
}

function sortTimeline(entries: TimelineEntry[]): TimelineEntry[] {
  return entries.sort(
    (left, right) =>
      left.timestamp - right.timestamp ||
      left.traceOrder - right.traceOrder ||
      left.sequence - right.sequence
  )
}

function buildSubagentTimelineEntry(
  trace: TraceConversationSource,
  traceOrder: number
): TimelineEntry {
  const conversation = buildTraceConversation(trace)
  const assistantMessages = conversation.messages.filter((message) => message.role === "assistant")
  const resultMessage = assistantMessages[assistantMessages.length - 1]
  const instruction =
    conversation.messages.find((message) => message.role === "user")?.content ||
    cleanUserText(trace.userMessage ?? "")
  // A synchronous task child is conceptually nested at the task invocation.
  // Detached Agent Team / Workflow spans are completion events, so keep them
  // anchored at their actual end time instead.
  const occurredAt =
    trace.linkType === "parent_child" || trace.subagentKind === "task"
      ? validEventTime(trace.startedAt, trace.endedAt)
      : validEventTime(trace.endedAt, trace.startedAt)
  const actorLabel = traceActorLabel(trace)
  const result = resultMessage?.content ?? ""
  return {
    message: {
      role: "subagent",
      label: `${actorLabel} 执行`,
      content: result,
      traceId: trace.traceId,
      occurredAt,
      subagentRun: {
        actorLabel,
        sourceLabel: traceSourceLabel(trace),
        instruction,
        result,
        ...(resultMessage?.reasoning ? { reasoning: resultMessage.reasoning } : {}),
        tools: conversation.tools,
        outcome: trace.outcome,
        startedAt: trace.startedAt,
        endedAt: trace.endedAt
      }
    },
    timestamp: eventTimestamp(occurredAt, traceOrder),
    traceOrder,
    sequence: 0
  }
}

// eslint-disable-next-line react-refresh/only-export-components
export function buildThreadConversation(
  traces: TraceConversationSource[]
): TraceConversationSummary {
  const ordered = [...traces].sort(
    (left, right) =>
      (left.startedAt ?? "").localeCompare(right.startedAt ?? "") ||
      (left.traceId ?? "").localeCompare(right.traceId ?? "")
  )
  const messages = sortTimeline(
    ordered.flatMap((trace, traceOrder) =>
      isSubagentTrace(trace)
        ? [buildSubagentTimelineEntry(trace, traceOrder)]
        : buildTraceTimeline(trace, traceOrder)
    )
  ).map((entry) => entry.message)
  const allTools = messages.flatMap((message) => message.tools ?? message.subagentRun?.tools ?? [])

  const toolNames = uniqueToolNames(allTools.map((tool) => tool.name))
  const assistantText =
    [...messages].reverse().find((message) => message.role === "assistant" && message.content)
      ?.content ??
    [...messages].reverse().find((message) => message.role === "subagent" && message.content)
      ?.content ??
    ""
  const userText =
    messages.find((message) => message.role === "user")?.content ??
    messages.find((message) => message.subagentRun?.instruction)?.subagentRun?.instruction ??
    ""

  return {
    messages,
    toolNames,
    tools: allTools,
    assistantText,
    userText,
    internalNotificationKind: null
  }
}

function roleIcon(role: TraceRole): React.JSX.Element {
  if (role === "user") return <User className="size-3.5" />
  if (role === "tool") return <Wrench className="size-3.5" />
  return <Bot className="size-3.5" />
}

function statusDotClass(status?: string): string {
  if (status === "error") return "bg-destructive"
  if (status === "cancelled") return "bg-amber-500"
  if (status === "running") return "bg-blue-500"
  if (status === "success") return "bg-emerald-500"
  return "bg-muted-foreground/40"
}

function ReasoningDetails({ text }: { text: string }): React.JSX.Element {
  const [open, setOpen] = useState(false)
  return (
    <div className="my-0.5">
      <button
        type="button"
        className="flex items-center gap-1 rounded px-0.5 text-[10px] text-muted-foreground/80 hover:text-foreground"
        onClick={() => setOpen((value) => !value)}
        aria-expanded={open}
      >
        {open ? <ChevronDown className="size-3" /> : <ChevronRight className="size-3" />}
        <span className="font-medium">思考</span>
      </button>
      {open && (
        <div className="mt-1 whitespace-pre-wrap break-words border-l-2 border-border pl-2 text-[11px] leading-5 text-muted-foreground">
          {text}
        </div>
      )}
    </div>
  )
}

const VALUE_PREVIEW_LIMIT = 220

/**
 * Render a tool input/output value with a head preview and an opt-in "展开" to
 * reveal the rest. The execution tree used to be the only place you could see
 * the full value; now that it's gone this is the only window into tool args/
 * results, so a collapsed-by-default expander keeps the conversation compact
 * while still letting you read everything the trace retained.
 */
function ExpandableValue({
  label,
  value
}: {
  label: string
  value: unknown
}): React.JSX.Element | null {
  const [expanded, setExpanded] = useState(false)
  const text = serializeValue(value)
  if (!text) return null
  const truncated = text.length > VALUE_PREVIEW_LIMIT
  const shown = !truncated || expanded ? text : `${text.slice(0, VALUE_PREVIEW_LIMIT)}...`

  return (
    <div className="mt-1.5">
      <div className="text-[10px] text-muted-foreground/70">{label}</div>
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
    <div className="min-w-0">
      <button
        type="button"
        className="flex max-w-full items-center gap-1.5 rounded px-1 py-0.5 text-left text-[11px] text-muted-foreground hover:bg-muted/60 hover:text-foreground"
        onClick={() => setOpen((value) => !value)}
        aria-expanded={open}
      >
        {open ? (
          <ChevronDown className="size-3 shrink-0" />
        ) : (
          <ChevronRight className="size-3 shrink-0" />
        )}
        <Wrench className="size-3 shrink-0" />
        <span className="truncate">{label ?? `工具调用 ${tools.length} 次`}</span>
      </button>
      {open && (
        <div className="mt-1 divide-y divide-border/60 rounded-md border border-border bg-background">
          {tools.map((tool, index) => (
            <div key={`${tool.name}-${index}`} className="px-2.5 py-2">
              <div className="flex items-center gap-2 text-[11px]">
                <span
                  className={cn("size-1.5 shrink-0 rounded-full", statusDotClass(tool.status))}
                  title={tool.status}
                />
                <span
                  className={cn(
                    "truncate font-medium",
                    tool.status === "error" ? "text-destructive" : "text-foreground"
                  )}
                >
                  {tool.name}
                </span>
                {tool.durationMs ? (
                  <span className="ml-auto shrink-0 text-[10px] text-muted-foreground">
                    {formatDuration(tool.durationMs)}
                  </span>
                ) : null}
              </div>
              <ExpandableValue label="输入" value={tool.input} />
              <ExpandableValue label="输出" value={tool.output} />
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

function subagentOutcomeLabel(outcome?: string): string {
  if (outcome === "success") return "已完成"
  if (outcome === "error") return "失败"
  if (outcome === "cancelled") return "已取消"
  return "状态未知"
}

function subagentDurationMs(run: TraceConversationSubagentRun): number | undefined {
  if (!run.startedAt || !run.endedAt) return undefined
  const duration = new Date(run.endedAt).getTime() - new Date(run.startedAt).getTime()
  return Number.isFinite(duration) && duration >= 0 ? duration : undefined
}

function SubagentRunCard({ run }: { run: TraceConversationSubagentRun }): React.JSX.Element {
  const [open, setOpen] = useState(false)
  const duration = subagentDurationMs(run)
  const isError = run.outcome === "error"
  const isCancelled = run.outcome === "cancelled"
  const meta = [
    formatMessageTime(run.startedAt),
    duration !== undefined ? formatDuration(duration) : ""
  ]
    .filter(Boolean)
    .join(" · ")

  return (
    <div
      className={cn(
        "overflow-hidden rounded-lg border bg-background",
        isError ? "border-destructive/40" : "border-border"
      )}
    >
      <button
        type="button"
        className="flex w-full items-center gap-2 px-2.5 py-2 text-left hover:bg-muted/40"
        onClick={() => setOpen((value) => !value)}
        aria-expanded={open}
      >
        {open ? (
          <ChevronDown className="size-3 shrink-0 text-muted-foreground" />
        ) : (
          <ChevronRight className="size-3 shrink-0 text-muted-foreground" />
        )}
        <span className="inline-flex size-5 shrink-0 items-center justify-center rounded bg-blue-500/10 text-blue-600 dark:text-blue-300">
          <Bot className="size-3" />
        </span>
        <span className="flex min-w-0 items-center gap-1.5 text-[11px] font-medium">
          <span className="truncate text-muted-foreground">{run.sourceLabel}</span>
          <span className="shrink-0 text-muted-foreground/60">→</span>
          <span className="truncate text-blue-700 dark:text-blue-300">{run.actorLabel}</span>
        </span>
        <span
          className={cn(
            "shrink-0 text-[10px]",
            isError
              ? "text-destructive"
              : isCancelled
                ? "text-amber-600 dark:text-amber-400"
                : "text-emerald-600 dark:text-emerald-400"
          )}
        >
          {subagentOutcomeLabel(run.outcome)}
        </span>
        {meta && <span className="ml-auto shrink-0 text-[10px] text-muted-foreground">{meta}</span>}
      </button>

      {!open && run.result ? (
        <div className="line-clamp-2 whitespace-pre-wrap break-words border-t border-border/60 px-2.5 py-1.5 text-[11px] leading-5 text-muted-foreground">
          {run.result}
        </div>
      ) : null}

      {open && (
        <div className="space-y-2.5 border-t border-border/60 px-2.5 py-2.5">
          {run.instruction && (
            <div>
              <div className="mb-0.5 text-[10px] text-muted-foreground/70">任务指令</div>
              <div className="whitespace-pre-wrap break-words border-l-2 border-border pl-2 text-[11px] leading-5 text-muted-foreground">
                {run.instruction}
              </div>
            </div>
          )}

          {run.tools.length > 0 && (
            <ToolCallDetails
              tools={run.tools}
              label={`${run.tools.length} 次工具 · ${summarizeToolNames(run.tools)}`}
            />
          )}

          {(run.result || run.reasoning) && (
            <div>
              <div className="mb-0.5 text-[10px] text-muted-foreground/70">执行结果</div>
              {run.reasoning ? <ReasoningDetails text={run.reasoning} /> : null}
              {run.result ? (
                <div className="whitespace-pre-wrap break-words text-xs leading-5 text-foreground">
                  {run.result}
                </div>
              ) : null}
            </div>
          )}
        </div>
      )}
    </div>
  )
}

/**
 * One timeline row shared by the single-trace and thread views. Speaking roles
 * (user/assistant) render as chat bubbles; process events (tool groups,
 * subagent runs) render as flat indented rows that expand on demand, so a long
 * run reads as one calm rail instead of a wall of nested boxes.
 */
function TimelineMessageRow({
  message,
  previous,
  selected = false
}: {
  message: TraceConversationMessage
  previous?: TraceConversationMessage
  selected?: boolean
}): React.JSX.Element {
  if (message.role === "subagent" && message.subagentRun) {
    return (
      <div className="flex scroll-mt-2 justify-start pl-8" data-trace-id={message.traceId}>
        <div className={cn("w-full max-w-[82%] rounded-lg", selected && "ring-2 ring-primary/50")}>
          <SubagentRunCard run={message.subagentRun} />
        </div>
      </div>
    )
  }

  if (message.role === "tool" && message.tools) {
    return (
      <div className="flex scroll-mt-2 justify-start pl-8" data-trace-id={message.traceId}>
        {/* Hug the label width like chat bubbles do — a full-width box here reads
            as a giant empty bar between much narrower bubbles. */}
        <div className={cn("max-w-[82%] rounded", selected && "ring-2 ring-primary/40")}>
          <ToolCallDetails tools={message.tools} label={message.content} />
        </div>
      </div>
    )
  }

  const isUser = message.role === "user"
  const time = formatMessageTime(message.occurredAt)
  // Consecutive same-actor bubbles read as one utterance: drop the repeated
  // avatar/label. The timestamp always shows so rows stay uniformly annotated.
  const isContinuation =
    !isUser &&
    message.role === previous?.role &&
    message.label === previous.label &&
    message.traceId === previous.traceId

  return (
    <div
      className={cn("flex scroll-mt-2 gap-2", isUser ? "justify-end" : "justify-start")}
      data-trace-id={message.traceId}
    >
      {!isUser && (
        <span
          className={cn(
            "mt-1 inline-flex size-6 shrink-0 items-center justify-center rounded-md bg-primary/10 text-primary",
            isContinuation && "invisible"
          )}
        >
          {roleIcon(message.role)}
        </span>
      )}
      <div
        className={cn(
          "max-w-[82%] rounded-lg px-3 py-2 text-xs leading-5",
          isUser
            ? "bg-primary text-primary-foreground"
            : "border border-border bg-background text-foreground",
          selected && "ring-2 ring-primary/50"
        )}
      >
        {(!isContinuation || time) && (
          <div
            className={cn(
              "mb-1 flex items-baseline justify-between gap-3 text-[10px]",
              isUser ? "text-primary-foreground/70" : "text-muted-foreground"
            )}
          >
            <span className="font-medium">{isContinuation ? "" : message.label}</span>
            {time ? <span className="shrink-0">{time}</span> : null}
          </div>
        )}
        {message.reasoning ? <ReasoningDetails text={message.reasoning} /> : null}
        {message.content ? (
          <div className="whitespace-pre-wrap break-words">{message.content}</div>
        ) : null}
      </div>
      {isUser && (
        <span className="mt-1 inline-flex size-6 shrink-0 items-center justify-center rounded-md bg-primary text-primary-foreground">
          {roleIcon(message.role)}
        </span>
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
      <section
        className={cn(
          "rounded-lg border border-dashed border-border px-4 py-3 text-xs text-muted-foreground",
          className
        )}
      >
        trace 中暂无可还原的对话内容
      </section>
    )
  }

  return (
    <section
      className={cn("space-y-3 rounded-lg border border-border bg-card/50 px-4 py-3", className)}
    >
      <div className="flex items-center justify-between gap-3">
        <h4 className="text-xs font-semibold text-foreground">{title}</h4>
        <TraceContextPills trace={trace} />
      </div>

      <div className="space-y-2">
        {conversation.messages.map((message, index) => (
          <TimelineMessageRow
            key={`${message.role}-${index}`}
            message={message}
            previous={index > 0 ? conversation.messages[index - 1] : undefined}
          />
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
  fillAvailableHeight = false,
  selectedTraceId
}: {
  traces: TraceConversationSource[]
  className?: string
  title?: string
  loading?: boolean
  /** Let the message list consume its parent's remaining height instead of using the compact 360px cap. */
  fillAvailableHeight?: boolean
  /** When set, the matching trace's messages are highlighted and scrolled into view. */
  selectedTraceId?: string | null
}): React.JSX.Element {
  const conversation = useMemo(() => buildThreadConversation(traces), [traces])
  const subagentCount = useMemo(() => traces.filter(isSubagentTrace).length, [traces])
  const projectNodeSummary = useMemo(() => summarizeThreadProjectNodes(traces), [traces])
  const scrollRef = useRef<HTMLDivElement>(null)

  // When the user picks a trace in the left list, jump the reconstructed
  // conversation to that trace's first message instead of forcing them to
  // scan the aggregated thread by hand.
  useEffect(() => {
    if (!selectedTraceId) return
    const container = scrollRef.current
    if (!container) return
    const target = container.querySelector<HTMLElement>(
      `[data-trace-id="${CSS.escape(selectedTraceId)}"]`
    )
    if (target) target.scrollIntoView({ behavior: "smooth", block: "center" })
  }, [selectedTraceId, conversation.messages.length])

  if (conversation.messages.length === 0) {
    return (
      <section
        className={cn(
          "rounded-lg border border-dashed border-border px-4 py-3 text-xs text-muted-foreground",
          className
        )}
      >
        {loading ? "正在加载完整会话…" : "thread 中暂无可还原的对话内容"}
      </section>
    )
  }

  return (
    <section
      className={cn(
        "rounded-lg border border-border bg-card/50 px-4 py-3",
        fillAvailableHeight ? "flex min-h-0 flex-col gap-3" : "space-y-3",
        className
      )}
    >
      <div className="flex items-start justify-between gap-3">
        <div>
          <h4 className="text-xs font-semibold text-foreground">{title}</h4>
          <p className="mt-0.5 text-[10px] text-muted-foreground">
            {loading
              ? `正在加载完整会话…（已展示 ${traces.length} 条 trace）`
              : `已聚合 ${traces.length} 条 trace（主 ${traces.length - subagentCount} / 子 ${subagentCount}）的输入与回复`}
          </p>
        </div>
        {projectNodeSummary.isProjectMode && (
          <span
            className="inline-flex shrink-0 items-center gap-1 rounded-full border border-primary/20 bg-primary/10 px-2 py-1 text-[10px] font-medium text-primary"
            title={
              projectNodeSummary.visitedNodeNames.length > 0
                ? `经历节点：${projectNodeSummary.visitedNodeNames.join("、")}`
                : "当前 thread 的 trace 尚未记录项目节点"
            }
          >
            <Route className="size-3" />
            已经历项目节点 {projectNodeSummary.visitedNodeNames.length} 个
          </span>
        )}
      </div>

      <div
        ref={scrollRef}
        className={cn(
          "space-y-3 overflow-y-auto pr-1",
          fillAvailableHeight ? "min-h-0 flex-1" : "max-h-[360px]"
        )}
      >
        {conversation.messages.map((message, index) => (
          <TimelineMessageRow
            key={`${message.role}-${index}`}
            message={message}
            previous={index > 0 ? conversation.messages[index - 1] : undefined}
            selected={!!selectedTraceId && message.traceId === selectedTraceId}
          />
        ))}
      </div>
    </section>
  )
}
