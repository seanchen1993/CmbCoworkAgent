import { useEffect, useRef, useState } from "react"
import type { FlowAttempt } from "../../../../shared/mods/flows/types"

type TraceDetail = NonNullable<Awaited<ReturnType<typeof window.api.optimizer.getTraceDetail>>>

/** Historical navigation only. Neither a trace ID nor the loaded trace authorizes recovery. */
export function FlowTraceView({
  attempt,
  parentThreadId
}: {
  attempt: FlowAttempt
  parentThreadId: string
}) {
  const telemetry = attempt.telemetry
  const alive = useRef(true)
  const generation = useRef(0)
  const [detail, setDetail] = useState<TraceDetail>()
  const [message, setMessage] = useState("")
  useEffect(() => {
    alive.current = true
    return () => {
      alive.current = false
    }
  }, [])
  if (!telemetry) return null
  const load = async (parent: boolean) => {
    const request = ++generation.current
    setDetail(undefined)
    setMessage("正在读取执行轨迹…")
    try {
      const id = parent ? telemetry.rootTraceId : telemetry.traceId
      const trace = await window.api.optimizer.getTraceDetail(id)
      if (!alive.current || generation.current !== request) return
      if (!trace) {
        setMessage("轨迹文件缺失或尚未落盘；历史关联仍保留。")
        return
      }
      if (
        trace.traceId !== id ||
        trace.threadId !== (parent ? parentThreadId : telemetry.childThreadId)
      ) {
        setMessage("轨迹身份与宿主历史关联不一致，未展示内容。")
        return
      }
      setDetail(trace)
      setMessage("")
    } catch {
      if (alive.current && generation.current === request)
        setMessage("轨迹读取失败；不能据此推断执行成功。")
    }
  }
  return (
    <div className="mt-2 space-y-2 text-xs" aria-label="宿主执行轨迹">
      <div className="flex gap-3">
        <button type="button" className="underline" onClick={() => void load(false)}>
          查看子执行轨迹
        </button>
        <button type="button" className="underline" onClick={() => void load(true)}>
          查看父流程轨迹
        </button>
      </div>
      {message && <p role="status">{message}</p>}
      {detail && (
        <div className="max-h-64 space-y-1 overflow-auto rounded border p-2">
          <p className="break-all">
            {detail.traceId} · {detail.outcome} · {detail.durationMs} ms
          </p>
          <p>以下是宿主历史观测，不代表当前文件或恢复资格。</p>
          {(detail.nodes ?? []).slice(0, 128).map((node) => (
            <p key={node.id} className="break-all">
              {node.type} · {node.name?.slice(0, 200) ?? node.id} · {node.status ?? "unknown"}
            </p>
          ))}
          {(detail.nodes?.length ?? 0) > 128 && <p>这里只显示前 128 条节点。</p>}
        </div>
      )}
    </div>
  )
}
