import type { BotModelUsageSummary } from "../../../../shared/bot-model-usage"

const purposes = {
  task: "任务及辅助调用",
  "memory-synthesis": "记忆提炼",
  "memory-verification": "记忆核验"
}
export function BotModelUsage({
  value,
  memory = false
}: {
  value?: BotModelUsageSummary
  memory?: boolean
}) {
  if (!value?.requests) return null
  return (
    <details className="rounded-lg border border-border/70 px-3 py-2 text-xs text-muted-foreground">
      <summary className="cursor-pointer rounded-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
        {memory ? "近 30 天整理用量" : "模型用量"} · {value.requests.toLocaleString()} 次调用
      </summary>
      <div className="mt-3 space-y-3">
        <p className="leading-5">
          已报告输入 {value.inputReportedRequests ? value.inputTokens.toLocaleString() : "—"}、输出{" "}
          {value.requests > value.unknownRequests ? value.outputTokens.toLocaleString() : "—"}{" "}
          tokens。
          {value.unknownRequests > 0 &&
            ` ${value.unknownRequests} 次尚无完整用量回执，不按零用量计算。`}
          {value.inputReportedRequests < value.requests - value.unknownRequests &&
            " 部分请求未报告输入用量。"}
        </p>
        <ul className="space-y-2" aria-label="各模型已记录用量">
          {value.models.map((item) => (
            <li
              key={JSON.stringify([item.modelRef, item.model, item.purpose])}
              className="flex items-start justify-between gap-4"
            >
              <span className="min-w-0">
                <span
                  className="block truncate text-foreground"
                  title={`${item.model} · ${item.modelRef}`}
                >
                  {item.model}
                </span>
                <span>
                  {purposes[item.purpose]} · {item.requests.toLocaleString()} 次
                </span>
              </span>
              <span className="shrink-0 text-right tabular-nums">
                输入 {item.inputReportedRequests ? item.inputTokens.toLocaleString() : "—"}
                <br />
                输出{" "}
                {item.requests > item.unknownRequests ? item.outputTokens.toLocaleString() : "—"}
              </span>
            </li>
          ))}
        </ul>
        {value.otherModelRequests > 0 && (
          <p>其余 {value.otherModelRequests.toLocaleString()} 次调用已包含在总量中。</p>
        )}
        <p className="leading-5">仅统计已记录的模型回执；token 数量不等于费用。</p>
      </div>
    </details>
  )
}
