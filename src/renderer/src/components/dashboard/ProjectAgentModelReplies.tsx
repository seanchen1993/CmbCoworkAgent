import { useEffect, useRef, useState } from "react"
import { ChevronDown, ChevronRight } from "lucide-react"
import type { ProjectAgentRunState } from "./use-project-agent-run"

export function ProjectAgentModelReplies({ state }: { state: ProjectAgentRunState }) {
  const [open, setOpen] = useState(false)
  const [selected, setSelected] = useState("latest")
  const viewport = useRef<HTMLPreElement>(null)
  const follow = useRef(true)
  const steps = state.steps.filter((step) => Object.hasOwn(state.replies, step.id))
  const step = steps.find((item) => item.id === selected) ?? steps.at(-1)
  const reply = step ? state.replies[step.id] : ""
  useEffect(() => {
    const el = viewport.current
    if (el && follow.current) el.scrollTop = el.scrollHeight
  }, [reply, step?.id, open])
  if (!step) return null
  return (
    <div className="mt-2 min-w-0 border-t border-border pt-2">
      <button
        type="button"
        aria-expanded={open}
        onClick={() => setOpen(!open)}
        className="flex items-center gap-1 text-primary hover:underline"
      >
        {open ? <ChevronDown className="size-3.5" /> : <ChevronRight className="size-3.5" />}
        模型回复 · {steps.length} 轮
        {state.outcome === "running" && <span className="text-muted-foreground">· 实时更新</span>}
      </button>
      {open && (
        <div className="mt-2 min-w-0 space-y-1.5">
          <select
            aria-label="查看模型回复轮次"
            value={selected}
            onChange={(event) => {
              follow.current = true
              setSelected(event.target.value)
            }}
            className="h-8 w-full min-w-0 rounded-md border bg-background px-2 text-xs"
          >
            <option value="latest">最新回复（自动跟随）</option>
            {steps.map((item, index) => (
              <option key={item.id} value={item.id}>
                {index + 1}. {item.title}
              </option>
            ))}
          </select>
          <p className="break-words text-muted-foreground">
            {step.title} ·{" "}
            {step.status === "running"
              ? "接收中"
              : step.status === "completed"
                ? "已完成"
                : "未完成"}
          </p>
          <pre
            ref={viewport}
            tabIndex={0}
            aria-label="模型回复正文"
            onScroll={(event) => {
              const el = event.currentTarget
              follow.current = el.scrollHeight - el.scrollTop - el.clientHeight < 32
            }}
            className="max-h-32 overflow-auto overscroll-contain whitespace-pre-wrap break-words rounded border bg-background p-2 font-mono text-xs leading-relaxed sm:max-h-48"
          >
            {reply ||
              (step.status === "running"
                ? "等待模型回复…"
                : "本轮未返回正文，可在运行明细查看工具调用。")}
          </pre>
        </div>
      )}
    </div>
  )
}
