import { getToolLabel } from "@/lib/tool-labels"
import type { DesignExecutionEvent, DesignModelRetryState, Message } from "./types"

function getDesignToolLabel(name: string): string {
  return getToolLabel(name, { showToolName: false })
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
    ""
  if (typeof raw !== "string") return ""
  const value = raw.includes("/") ? raw.split("/").pop() || raw : raw
  return value.length > 42 ? `${value.slice(0, 39)}...` : value
}

function DesignExecutionPanel({ events }: { events?: DesignExecutionEvent[] }) {
  if (!events || events.length === 0) return null

  const skills = events.filter((event) => event.kind === "used_skill" && event.name)
  const calls = events.filter((event) => event.kind === "tool_call")
  const resultsByToolCallId = new Map<string, DesignExecutionEvent>()
  for (const event of events) {
    if (event.kind === "tool_result" && event.toolCallId) {
      resultsByToolCallId.set(event.toolCallId, event)
    }
  }

  return (
    <div style={{
      marginTop: 8,
      maxWidth: "85%",
      border: "1px solid #e2e0da",
      borderRadius: 10,
      background: "#fbfaf7",
      overflow: "hidden",
    }}>
      <div style={{
        display: "flex",
        alignItems: "center",
        gap: 8,
        padding: "8px 10px",
        borderBottom: calls.length > 0 ? "1px solid #ebe9e3" : "none",
      }}>
        <span style={{ width: 7, height: 7, borderRadius: "50%", background: "#cc785c", flexShrink: 0 }} />
        <span style={{ fontSize: 12, fontWeight: 700, color: "#2f3437" }}>技能执行</span>
        {skills.length > 0 && (
          <div style={{ display: "flex", flexWrap: "wrap", gap: 5 }}>
            {skills.map((skill) => (
              <span key={skill.name} style={{
                padding: "2px 7px",
                borderRadius: 999,
                background: skill.status === "error" ? "#fee2e2" : skill.status === "success" ? "#dcfce7" : "#eff0fb",
                color: skill.status === "error" ? "#991b1b" : skill.status === "success" ? "#166534" : "#3a3a8a",
                border: `1px solid ${skill.status === "error" ? "#fecaca" : skill.status === "success" ? "#bbf7d0" : "#c7c9ef"}`,
                fontSize: 11,
                fontWeight: 600,
              }}>
                {skill.name}{skill.status === "error" ? " 失败" : skill.status === "success" ? " 成功" : " 执行中"}
              </span>
            ))}
          </div>
        )}
      </div>
      {calls.length > 0 && (
        <div style={{ padding: "6px 8px", display: "flex", flexDirection: "column", gap: 5 }}>
          {calls.map((call) => {
            const key = call.toolCallId || call.id || `${call.name}-${call.timestamp}`
            const result = call.toolCallId ? resultsByToolCallId.get(call.toolCallId) : undefined
            const status = result?.isError || call.status === "error"
              ? "error"
              : result || call.status === "success"
                ? "success"
                : "running"
            const param = getDesignToolParam(call.args)
            return (
              <details key={key} style={{
                border: "1px solid #ebe9e3",
                borderRadius: 8,
                background: "#ffffff",
              }}>
                <summary style={{
                  display: "flex",
                  alignItems: "center",
                  gap: 8,
                  padding: "7px 9px",
                  cursor: "pointer",
                  listStyle: "none",
                }}>
                  <span style={{
                    width: 7,
                    height: 7,
                    borderRadius: "50%",
                    background: status === "success" ? "#16a34a" : status === "error" ? "#dc2626" : "#d0a032",
                    flexShrink: 0,
                  }} />
                  <span style={{ fontSize: 12, fontWeight: 600, color: "#343a40", minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                    {getDesignToolLabel(call.name || "tool")}{param ? `: ${param}` : ""}
                  </span>
                  <span style={{
                    marginLeft: "auto",
                    padding: "1px 6px",
                    borderRadius: 5,
                    fontSize: 10,
                    fontWeight: 700,
                    color: status === "success" ? "#166534" : status === "error" ? "#991b1b" : "#7c5b12",
                    background: status === "success" ? "#dcfce7" : status === "error" ? "#fee2e2" : "#fef3c7",
                    flexShrink: 0,
                  }}>
                    {status === "success" ? "成功" : status === "error" ? "失败" : "执行中"}
                  </span>
                </summary>
                <div style={{ borderTop: "1px solid #f0eee8", padding: "7px 9px" }}>
                  <pre style={{
                    margin: 0,
                    maxHeight: 150,
                    overflow: "auto",
                    fontSize: 11,
                    lineHeight: 1.45,
                    color: "#4b5563",
                    whiteSpace: "pre-wrap",
                    wordBreak: "break-word",
                    fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
                  }}>
                    {result?.content
                      ? result.content.slice(0, 1600)
                      : JSON.stringify(call.args ?? {}, null, 2)}
                  </pre>
                </div>
              </details>
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
      {!isUser && <DesignExecutionPanel events={message.executionEvents} />}
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
            ? <span style={{ opacity: 0.4 }}>{message.isIteration ? "Updating design..." : "Generating..."}</span>
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
