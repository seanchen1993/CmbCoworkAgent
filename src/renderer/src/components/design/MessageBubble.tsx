import { useState } from "react"
import { ChevronDown, ChevronRight, Eye, Wrench } from "lucide-react"
import { getToolLabel } from "@/lib/tool-labels"
import type { DesignExecutionEvent, DesignModelRetryState, Message } from "./types"

const MAX_VISIBLE_TOOL_CALLS = 60
const MAX_VISIBLE_ASSISTANT_TEXT_EVENTS = 80

function getDesignToolLabel(name: string): string {
  return getToolLabel(name, { showToolName: false })
}

function basename(path: string): string {
  const normalized = path.replace(/\\/g, "/")
  return normalized.split("/").filter(Boolean).pop() || path
}

function getDesignToolParam(args?: Record<string, unknown>): string {
  if (!args) return ""
  const raw =
    args.path ??
    args.file_path ??
    args.command ??
    args.pattern ??
    args.query ??
    args.name ??
    args.url ??
    ""
  if (typeof raw !== "string") return ""
  const value = raw.includes("/") || raw.includes("\\") ? basename(raw) : raw
  return value.length > 54 ? `${value.slice(0, 51)}...` : value
}

function stringifyForPanel(value: unknown): string {
  if (typeof value === "string") return value
  try {
    return JSON.stringify(value, null, 2)
  } catch {
    return String(value)
  }
}

function getToolPreviewPath(call: DesignExecutionEvent): string | null {
  if (call.name !== "read_file" && call.name !== "write_file" && call.name !== "edit_file") return null
  const path = call.args?.file_path ?? call.args?.path
  return typeof path === "string" && path.trim() ? path : null
}

function hasUsefulArgs(args?: Record<string, unknown>): boolean {
  return Boolean(args && Object.keys(args).length > 0)
}

function getToolProgressText(
  call: DesignExecutionEvent,
  status: "running" | "success" | "error",
  param: string
): string {
  const target = param ? ` ${param}` : ""
  const label = getDesignToolLabel(call.name || "tool")

  if (status === "running") {
    if (call.name === "read_file") return `正在读取${target}...`
    if (call.name === "write_file") return `正在写入${target}...`
    if (call.name === "edit_file") return `正在修改${target}...`
    return `正在执行${target ? ` ${label}: ${param}` : ` ${label}`}...`
  }

  if (status === "error") {
    if (call.name === "read_file") return `读取${target}失败，正在等待模型处理...`
    return `${label}执行失败，正在等待模型处理...`
  }

  if (call.name === "read_file") return `已读取${target}，正在分析内容...`
  if (call.name === "write_file") return `已写入${target}，正在整理生成结果...`
  if (call.name === "edit_file") return `已修改${target}，正在整理生成结果...`
  if (call.name === "glob" || call.name === "grep" || call.name === "list_files") {
    return `已获取${target || "检索结果"}，正在继续分析...`
  }
  return `${label}已完成，正在继续处理...`
}

function sanitizeProgressText(content: string): string {
  const text = content.replace(/<think>[\s\S]*?<\/think>/gi, "").trim()
  if (!text) return ""
  if (/<!doctype|<html|<head|<body|<style|<script/i.test(text)) {
    return "正在生成 HTML 设计稿..."
  }
  if (text.length > 360) return `${text.slice(0, 360)}...`
  return text
}

function getEventKey(event: DesignExecutionEvent, index: number): string {
  if (event.kind === "assistant_text") {
    return `${event.id || "assistant-text"}:${event.timestamp}:${index}`
  }
  return event.toolCallId || event.id || `${event.kind}:${event.name ?? "event"}:${event.timestamp}:${index}`
}

function getVisibleTimelineEvents(events: DesignExecutionEvent[]): {
  visibleEvents: DesignExecutionEvent[]
  hiddenEventCount: number
} {
  const toolCalls = events.filter((event) => event.kind === "tool_call")
  const keepAllTools = toolCalls.length <= MAX_VISIBLE_TOOL_CALLS
  const visibleToolIds = new Set(
    keepAllTools
      ? toolCalls.map((event) => event.toolCallId || event.id).filter(Boolean)
      : toolCalls
          .slice(-MAX_VISIBLE_TOOL_CALLS)
          .map((event) => event.toolCallId || event.id)
          .filter(Boolean)
  )
  let assistantTextCount = 0
  const reversedVisible: DesignExecutionEvent[] = []

  for (let index = events.length - 1; index >= 0; index--) {
    const event = events[index]
    if (event.kind === "tool_call") {
      const id = event.toolCallId || event.id
      if (keepAllTools || !id || visibleToolIds.has(id)) {
        reversedVisible.push(event)
      }
      continue
    }

    if (event.kind === "assistant_text" && assistantTextCount < MAX_VISIBLE_ASSISTANT_TEXT_EVENTS) {
      assistantTextCount += 1
      reversedVisible.push(event)
    }
  }

  const visibleEvents = reversedVisible.reverse()
  return {
    visibleEvents,
    hiddenEventCount: events.length - visibleEvents.length,
  }
}

function DesignExecutionPanel({
  events,
  isStreaming,
}: {
  events?: DesignExecutionEvent[]
  isStreaming?: boolean
}) {
  const [expanded, setExpanded] = useState<Set<string>>(new Set())
  if (!events || events.length === 0) return null

  const selectedSkills = events.filter((event) => event.kind === "used_skill" && event.name)
  const resultsByToolCallId = new Map<string, DesignExecutionEvent>()
  for (const event of events) {
    if (event.kind === "tool_result" && event.toolCallId) {
      resultsByToolCallId.set(event.toolCallId, event)
    }
  }

  const seenToolCallIds = new Set<string>()
  const timelineEvents: DesignExecutionEvent[] = []
  for (const event of events) {
    if (event.kind === "tool_call") {
      const id = event.toolCallId || event.id
      if (id) seenToolCallIds.add(id)
      timelineEvents.push(event)
      continue
    }
    if (event.kind === "assistant_text") {
      timelineEvents.push(event)
      continue
    }
    if (event.kind === "tool_result" && event.toolCallId && !seenToolCallIds.has(event.toolCallId)) {
      seenToolCallIds.add(event.toolCallId)
      timelineEvents.push({
        kind: "tool_call",
        id: event.toolCallId,
        toolCallId: event.toolCallId,
        name: event.name || "tool",
        status: event.status,
        isError: event.isError,
        timestamp: event.timestamp,
      })
    }
  }

  const calls = timelineEvents.filter((event) => event.kind === "tool_call")
  if (selectedSkills.length === 0 && timelineEvents.length === 0) return null

  const { visibleEvents, hiddenEventCount } = getVisibleTimelineEvents(timelineEvents)

  const toggleExpanded = (id: string) => {
    setExpanded((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  return (
    <div style={{ marginTop: 8, maxWidth: "92%" }}>
      {selectedSkills.length > 0 && (
        <div style={{
          display: "flex",
          flexWrap: "wrap",
          alignItems: "center",
          gap: 6,
          marginBottom: calls.length > 0 ? 7 : 0,
        }}>
          <span style={{ fontSize: 12, fontWeight: 700, color: "#6b6259" }}>技能</span>
          {selectedSkills.map((skill) => (
            <span key={skill.name} style={{
              padding: "3px 8px",
              borderRadius: 999,
              background: skill.status === "error" ? "#fee2e2" : skill.status === "success" ? "#dcfce7" : "#eff0fb",
              color: skill.status === "error" ? "#991b1b" : skill.status === "success" ? "#166534" : "#3a3a8a",
              border: `1px solid ${skill.status === "error" ? "#fecaca" : skill.status === "success" ? "#bbf7d0" : "#c7c9ef"}`,
              fontSize: 11,
              fontWeight: 700,
            }}>
              {skill.name}{skill.status === "error" ? " 失败" : skill.status === "success" ? " 已读取" : " 读取中"}
            </span>
          ))}
        </div>
      )}

      {timelineEvents.length > 0 && (
        <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
          {hiddenEventCount > 0 && (
            <div style={{
              padding: "5px 10px",
              borderRadius: 8,
              background: "#f4f3ef",
              color: "#8a8a8a",
              fontSize: 11,
              fontWeight: 600,
              textAlign: "center",
            }}>
              已折叠前 {hiddenEventCount} 步，显示最近 {visibleEvents.length} 步
            </div>
          )}

          {visibleEvents.map((event, index) => {
            if (event.kind === "assistant_text") {
              const text = sanitizeProgressText(event.content ?? "")
              if (!text) return null
              return (
                <div key={getEventKey(event, index)} style={{
                  padding: "6px 2px 7px 24px",
                  color: "#4b5563",
                  fontSize: 13,
                  lineHeight: 1.6,
                  whiteSpace: "pre-wrap",
                  wordBreak: "break-word",
                }}>
                  {text}
                </div>
              )
            }

            const call = event
            const key = call.toolCallId || call.id || `${call.name}-${call.timestamp}`
            const result = call.toolCallId ? resultsByToolCallId.get(call.toolCallId) : undefined
            const status = result?.isError || call.status === "error"
              ? "error"
              : result || call.status === "success"
                ? "success"
                : "running"
            const isOpen = expanded.has(key)
            const param = getDesignToolParam(call.args)
            const previewPath = getToolPreviewPath(call)
            const progressText = getToolProgressText(call, status, param)
            const detailText = result?.content
              ? stringifyForPanel(result.content).slice(0, 1800)
              : hasUsefulArgs(call.args)
                ? stringifyForPanel(call.args)
                : "等待工具参数..."

            return (
              <div key={key} style={{ display: "flex", flexDirection: "column", gap: 5 }}>
                <div style={{
                  border: "1px solid #e2e0da",
                  borderRadius: 8,
                  background: "#ffffff",
                  overflow: "hidden",
                  boxShadow: "0 1px 2px rgba(0,0,0,0.03)",
                }}>
                  <button
                    type="button"
                    onClick={() => toggleExpanded(key)}
                    style={{
                      width: "100%",
                      display: "flex",
                      alignItems: "center",
                      gap: 8,
                      padding: "8px 10px",
                      border: "none",
                      background: "transparent",
                      cursor: "pointer",
                      fontFamily: "inherit",
                      textAlign: "left",
                    }}
                  >
                    {isOpen ? (
                      <ChevronDown size={15} color="#8a8a8a" style={{ flexShrink: 0 }} />
                    ) : (
                      <ChevronRight size={15} color="#8a8a8a" style={{ flexShrink: 0 }} />
                    )}
                    <Wrench size={15} color="#2563eb" style={{ flexShrink: 0 }} />
                    <span style={{
                      minWidth: 0,
                      flex: 1,
                      overflow: "hidden",
                      textOverflow: "ellipsis",
                      whiteSpace: "nowrap",
                      fontSize: 13,
                      fontWeight: 650,
                      color: "#2f3437",
                    }}>
                      {getDesignToolLabel(call.name || "tool")}{param ? `: ${param}` : ""}
                    </span>
                    {previewPath && status === "success" && (
                      <span
                        title={previewPath}
                        style={{
                          display: "inline-flex",
                          alignItems: "center",
                          justifyContent: "center",
                          width: 26,
                          height: 24,
                          borderRadius: 7,
                          border: "1px solid #e8e6e0",
                          background: "#f8f7f4",
                          flexShrink: 0,
                        }}
                      >
                        <Eye size={13} color="#777" />
                      </span>
                    )}
                    <span style={{
                      padding: "2px 8px",
                      borderRadius: 6,
                      fontSize: 11,
                      fontWeight: 800,
                      letterSpacing: 0,
                      color: status === "success" ? "#047857" : status === "error" ? "#b91c1c" : "#7c5b12",
                      background: status === "success" ? "#d1fae5" : status === "error" ? "#fee2e2" : "#fef3c7",
                      border: `1px solid ${status === "success" ? "#a7f3d0" : status === "error" ? "#fecaca" : "#fde68a"}`,
                      flexShrink: 0,
                    }}>
                      {status === "success" ? "OK" : status === "error" ? "ERROR" : isStreaming ? "RUNNING" : "WAITING"}
                    </span>
                  </button>

                  {isOpen && (
                    <div style={{ borderTop: "1px solid #f0eee8", padding: "8px 10px", background: "#fbfaf7" }}>
                      <pre style={{
                        margin: 0,
                        maxHeight: 180,
                        overflow: "auto",
                        fontSize: 11,
                        lineHeight: 1.5,
                        color: "#4b5563",
                        whiteSpace: "pre-wrap",
                        wordBreak: "break-word",
                        fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
                      }}>
                        {detailText}
                      </pre>
                    </div>
                  )}
                </div>
                <div style={{
                  padding: "0 2px 1px 24px",
                  color: "#4b5563",
                  fontSize: 13,
                  lineHeight: 1.6,
                  whiteSpace: "pre-wrap",
                  wordBreak: "break-word",
                }}>
                  {progressText}
                </div>
              </div>
            )
          })}
        </div>
      )}
    </div>
  )
}

function DesignModelRetryNotice({ retry }: { retry: DesignModelRetryState }) {
  return (
    <div style={{
      display: "flex",
      alignItems: "flex-start",
      gap: 8,
      marginBottom: 8,
      padding: "7px 9px",
      borderRadius: 9,
      background: "#fff7ed",
      border: "1px solid #fed7aa",
      color: "#9a3412",
      fontSize: 12,
      lineHeight: 1.45,
    }}>
      <span style={{
        width: 12,
        height: 12,
        marginTop: 3,
        borderRadius: "50%",
        border: "2px solid #f97316",
        borderTopColor: "transparent",
        flexShrink: 0,
        animation: "spin 0.8s linear infinite",
      }} />
      <span>
        模型暂时不可用（{retry.reason}），正在重试 {retry.attempt}/{retry.maxRetries}
        {retry.delayMs > 0 ? `（等待 ${Math.round(retry.delayMs / 100) / 10}s）` : ""}...
      </span>
    </div>
  )
}

export function MessageBubble({ message }: { message: Message }) {
  const isUser = message.role === "user"
  const isQPrompt = message.role === "questions-prompt"

  if (isQPrompt) {
    return (
      <div style={{ margin: "6px 0 10px" }}>
        <div style={{ display: "inline-flex", alignItems: "center", gap: 8, padding: "8px 14px", background: "rgba(204,120,92,0.08)", border: "1px solid rgba(204,120,92,0.25)", borderRadius: 20, fontSize: 13, color: "#cc785c", fontWeight: 500 }}>
          <span style={{ width: 7, height: 7, borderRadius: "50%", background: "#cc785c", flexShrink: 0 }} />
          {message.content}
        </div>
      </div>
    )
  }

  return (
    <div style={{ marginBottom: 10 }}>
      {isUser && message.imageUrl && (
        <div style={{ display: "flex", justifyContent: "flex-end", marginBottom: 4 }}>
          <img
            src={message.imageUrl}
            style={{ maxHeight: 120, maxWidth: "70%", borderRadius: 10, objectFit: "cover", border: "1px solid #e8e6e0" }}
            alt="截图参考"
          />
        </div>
      )}
      {!isUser && <DesignExecutionPanel events={message.executionEvents} isStreaming={message.isStreaming} />}
      <div style={{ display: "flex", justifyContent: isUser ? "flex-end" : "flex-start" }}>
        <div style={{ maxWidth: "85%", padding: "9px 13px", borderRadius: isUser ? "16px 16px 4px 16px" : "16px 16px 16px 4px", background: isUser ? "#1a1a1a" : "#f4f3ef", color: isUser ? "#fff" : "#1a1a1a", fontSize: 13, lineHeight: 1.6, whiteSpace: "pre-wrap", wordBreak: "break-word" }}>
          {isUser && message.attachments && message.attachments.length > 0 && (
            <div style={{ display: "flex", flexWrap: "wrap", gap: 5, marginBottom: message.content ? 8 : 0 }}>
              {message.attachments.map((att, i) => (
                <div key={i} style={{
                  display: "inline-flex", alignItems: "center", gap: 5,
                  padding: "3px 9px", borderRadius: 7,
                  background: "rgba(255,255,255,0.12)", border: "1px solid rgba(255,255,255,0.18)",
                  fontSize: 11, color: "rgba(255,255,255,0.92)", fontWeight: 500,
                  maxWidth: 220, overflow: "hidden",
                }}>
                  <span style={{ flexShrink: 0 }}>{att.kind === "code" ? "🗂️" : "📎"}</span>
                  <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                    {att.filename.length > 28 ? att.filename.slice(0, 25) + "..." + att.filename.slice(att.filename.lastIndexOf(".")) : att.filename}
                  </span>
                  {att.meta && (
                    <span style={{ flexShrink: 0, opacity: 0.65, fontSize: 10 }}>{att.meta}</span>
                  )}
                </div>
              ))}
            </div>
          )}
          {!isUser && message.modelRetry && (
            <DesignModelRetryNotice retry={message.modelRetry} />
          )}
          {message.content || (message.isStreaming
            ? <span style={{ opacity: 0.4 }}>{message.isIteration ? "正在更新设计..." : "正在生成..."}</span>
            : "")}
        </div>
      </div>
      {isUser && message.skillName && (
        <div style={{ display: "flex", justifyContent: "flex-end", marginTop: 5 }}>
          <span style={{
            display: "inline-flex", alignItems: "center", gap: 4,
            padding: "2px 9px", borderRadius: 999,
            background: "#eff0fb", border: "1px solid #c7c9ef",
            color: "#3a3a8a", fontSize: 11, fontWeight: 600,
          }}>
            <span style={{ fontSize: 12 }}>⚡</span>
            {message.skillName}
          </span>
        </div>
      )}
      {isUser && message.tags && message.tags.length > 0 && (
        <div style={{ display: "flex", justifyContent: "flex-end", gap: 4, flexWrap: "wrap", marginTop: 6 }}>
          {message.tags.map((tag, i) => (
            <span key={i} style={{ padding: "2px 10px", background: "rgba(204,120,92,0.1)", color: "#cc785c", borderRadius: 999, fontSize: 11, fontWeight: 500, border: "1px solid rgba(204,120,92,0.2)" }}>
              {tag}
            </span>
          ))}
        </div>
      )}
    </div>
  )
}
