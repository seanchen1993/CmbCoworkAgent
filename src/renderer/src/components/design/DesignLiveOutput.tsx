import { useEffect, useRef, useState } from "react"
import { ChevronDown, ChevronUp } from "lucide-react"
import type { DesignLiveOutput as LiveOutput } from "../../../../shared/design-live-output"
import { DesignReasoning } from "./DesignReasoning"

const labels: Record<LiveOutput["phase"], string> = {
  waiting: "等待模型继续输出",
  thinking: "模型正在思考",
  model: "正在接收模型输出",
  file: "正在生成文件内容",
  tool: "正在执行工具",
  validation: "正在检查页面",
  retry: "正在重试模型请求",
  approval: "等待操作确认"
}
const toolLabels: Record<string, string> = {
  read_file: "读取文件", write_file: "写入文件", edit_file: "修改文件"
}

export function DesignLiveOutput({ output }: { output: LiveOutput }) {
  const [expanded, setExpanded] = useState(true)
  const [now, setNow] = useState(Date.now)
  const lines = useRef<HTMLPreElement>(null)
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 1000)
    return () => window.clearInterval(timer)
  }, [])
  useEffect(() => {
    if (lines.current) lines.current.scrollTop = lines.current.scrollHeight
  }, [output.text, expanded])
  const seconds = Math.max(0, Math.floor((now - output.updatedAt) / 1000))
  return (
    <section aria-label="生成实时进度" data-testid="design-live-output" style={{
      marginBottom: 10, border: "1px solid var(--border, #e5e2db)", borderRadius: 12,
      overflow: "hidden", background: "var(--background, #faf9f6)", minWidth: 0
    }}>
      <button type="button" onClick={() => setExpanded((value) => !value)} aria-expanded={expanded} style={{
        display: "flex", alignItems: "center", gap: 8, width: "100%", border: 0,
        background: "transparent", padding: "9px 12px", textAlign: "left", cursor: "pointer", color: "#676259", fontSize: 12
      }}>
        <span aria-hidden="true" style={{ width: 6, height: 6, borderRadius: "50%", background: "#bb795a", flexShrink: 0 }} />
        <span style={{ flex: 1 }}>{labels[output.phase]}{output.toolName ? ` · ${toolLabels[output.toolName] || output.toolName}` : ""}</span>
        {expanded ? <ChevronUp size={14} /> : <ChevronDown size={14} />}
      </button>
      {expanded && <>
        {output.reasoning && <div style={{ padding: "0 12px" }}>
          <DesignReasoning key={output.reasoningScope} id={`design-live:${output.startedAt}:${output.reasoningScope}`}
            reasoning={output.reasoning} isStreaming isThinking={output.phase === "thinking"}
            hasAnswer={output.phase !== "thinking"} />
        </div>}
        {(output.text || !output.reasoning) && <pre ref={lines} aria-label="模型实时输出" style={{
          margin: "0 12px", height: 72, overflow: "auto", whiteSpace: "pre-wrap", overflowWrap: "anywhere",
          fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace", fontSize: 11, lineHeight: "18px", color: "#80796e"
        }}>{output.text || (output.phase === "validation" ? "等待当前页面的检查结果…" : "等待可显示的模型输出…")}</pre>}
        <div style={{ display: "flex", justifyContent: "space-between", gap: 8, padding: "7px 12px 9px", fontSize: 11, color: "#9a9389", fontVariantNumeric: "tabular-nums" }}>
          <span>{output.reasoningChars ? `思考 ${output.reasoningChars.toLocaleString()} 字符${output.chars ? ` · 输出 ${output.chars.toLocaleString()} 字符` : ""}` : output.chars ? `已接收 ${output.chars.toLocaleString()} 字符` : "任务正在进行"}</span>
          <span>{seconds < 2 ? "刚刚收到活动" : `${seconds} 秒未收到新活动`}</span>
        </div>
      </>}
    </section>
  )
}
