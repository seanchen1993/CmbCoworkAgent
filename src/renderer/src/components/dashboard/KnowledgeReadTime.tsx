import { InfoHint } from "./panels/dashboard-shared"

export function KnowledgeReadTimeHeader(): React.JSX.Element {
  return (
    <span className="inline-flex items-center gap-1">
      最近读取时间
      <InfoHint content="取近30天相关读取记录的最后时间。部分记录按整轮对话汇总，或使用上报时间，可能与文件的实际读取时间略有偏差。" />
    </span>
  )
}

export function KnowledgeReadTimeValue({ value }: { value?: string }): React.JSX.Element {
  const date = value ? new Date(value) : null
  if (!date || !Number.isFinite(date.getTime())) return <span>未记录</span>
  return (
    <time dateTime={value} className="tabular-nums">
      {date.toLocaleString("zh-CN", {
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
        hour: "2-digit",
        minute: "2-digit",
        second: "2-digit",
        hour12: false
      })}
    </time>
  )
}
