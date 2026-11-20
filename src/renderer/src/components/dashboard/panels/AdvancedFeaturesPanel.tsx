import {
  Activity,
  Brain,
  Code,
  Sparkles,
  GitBranch,
  Bot,
  Webhook,
  Terminal,
  type LucideIcon
} from "lucide-react"
import type {
  AdvancedFeaturesData,
  AdvancedFeatureCard,
  AdvancedFeatureTone
} from "../use-dashboard"
import { InfoHint } from "./dashboard-shared"

const CARD_ICON: Record<string, LucideIcon> = {
  heartbeat: Activity,
  memory: Brain,
  lsp: Code,
  optimizer: Sparkles,
  evolvedUsage: GitBranch,
  im: Bot,
  hooks: Webhook,
  programmatic: Terminal
}

const CARD_ICON_COLOR: Record<string, string> = {
  heartbeat: "bg-rose-500",
  memory: "bg-violet-500",
  lsp: "bg-blue-500",
  optimizer: "bg-amber-500",
  evolvedUsage: "bg-teal-500",
  im: "bg-sky-500",
  hooks: "bg-indigo-500",
  programmatic: "bg-emerald-500"
}

const TONE_CLASS: Record<AdvancedFeatureTone, string> = {
  good: "bg-emerald-50 text-emerald-700 dark:bg-emerald-500/10 dark:text-emerald-400",
  bad: "bg-rose-50 text-rose-700 dark:bg-rose-500/10 dark:text-rose-400",
  warn: "bg-amber-50 text-amber-700 dark:bg-amber-500/10 dark:text-amber-400",
  neutral: "bg-muted text-muted-foreground"
}

function formatNumber(value: number): string {
  return Math.round(value).toLocaleString("zh-CN")
}

function FeatureCard({ card }: { card: AdvancedFeatureCard }) {
  const Icon = CARD_ICON[card.key] ?? Activity
  const iconColor = CARD_ICON_COLOR[card.key] ?? "bg-slate-500"

  return (
    <div className="flex flex-col rounded-xl border border-border bg-card p-4">
      <div className="flex items-center gap-3">
        <div className={`flex size-9 items-center justify-center rounded-lg ${iconColor}`}>
          <Icon className="size-4 text-white" />
        </div>
        <div className="min-w-0">
          <div className="flex items-center gap-1 text-xs font-medium text-foreground">
            <span className="truncate">{card.label}</span>
            {card.key === "im" && (
              <InfoHint
                content={
                  <div className="space-y-2 leading-relaxed">
                    <p>按所选时间范围统计。</p>
                    <p>
                      处理完成：收到的消息中，本轮任务正常执行结束的次数，不代表整个项目完成，也不保证回复已送达。
                    </p>
                    <p>
                      回复条数：针对收到的消息发出的回复，长回复拆成多条时分别计数；包含失败、取消时的提示，以及发送失败或结果未确认的回复。主动推送和审批/提问卡片单独统计。
                    </p>
                    <p>
                      一次任务可能产生多条回复，因此两项不一一对应。“异常”表示发送失败或结果未确认的条数，已包含在发出条数中。
                    </p>
                  </div>
                }
              />
            )}
          </div>
          <div className="flex items-baseline gap-1.5">
            <span className="text-xl font-bold leading-tight text-foreground tabular-nums">
              {formatNumber(card.value)}
            </span>
            <span className="text-[10px] text-muted-foreground">{card.valueLabel}</span>
          </div>
        </div>
      </div>

      {card.hint ? (
        <div className="mt-2 text-[11px] text-muted-foreground leading-relaxed">{card.hint}</div>
      ) : null}

      {card.items.length > 0 ? (
        <div className="mt-3 flex flex-wrap gap-1.5">
          {card.items.map((item) => (
            <span
              key={`${card.key}-${item.label}`}
              className={`inline-flex items-center gap-1 rounded-md px-1.5 py-0.5 text-[11px] font-medium ${TONE_CLASS[item.tone]}`}
            >
              <span>{item.label}</span>
              <span className="tabular-nums">{formatNumber(item.count)}</span>
            </span>
          ))}
        </div>
      ) : null}
    </div>
  )
}

export function AdvancedFeaturesPanel({
  data,
  loading
}: {
  data: AdvancedFeaturesData | null
  loading: boolean
}) {
  if (loading && !data) {
    return <div className="text-sm text-muted-foreground py-8 text-center">加载中...</div>
  }
  if (!data) return null

  if (data.cards.length === 0) {
    return (
      <div className="rounded-xl border border-border bg-card p-8 text-center text-xs text-muted-foreground">
        当前时间范围内暂无高级特性使用数据
      </div>
    )
  }

  return (
    <div className="grid grid-cols-2 md:grid-cols-3 xl:grid-cols-4 gap-3">
      {data.cards.map((card) => (
        <FeatureCard key={card.key} card={card} />
      ))}
    </div>
  )
}
