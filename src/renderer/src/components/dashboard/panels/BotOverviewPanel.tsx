import { useEffect, useState } from "react"
import { Bot, RefreshCw } from "lucide-react"
import {
  BOT_CHANNELS,
  BOT_RUN_KINDS,
  type BotOverviewData
} from "../../../../../shared/bots/telemetry"
import type { Granularity, TimeRange } from "../use-dashboard"
import { InfoHint } from "./dashboard-shared"

const count = (n: number) => n.toLocaleString("zh-CN")
const duration = (ms: number | null) =>
  ms === null
    ? "—"
    : ms < 60000
      ? `${(ms / 1000).toFixed(1)} 秒`
      : `${(ms / 60000).toFixed(1)} 分钟`

/** Kept separate so a missing event index cannot take down the existing overview. */
export function BotOverviewPanel({
  range,
  granularity,
  organizations,
  refreshKey
}: {
  range: TimeRange
  granularity: Granularity
  organizations: string[]
  refreshKey: number
}) {
  const [data, setData] = useState<BotOverviewData | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [retry, setRetry] = useState(0)
  const orgKey = JSON.stringify([...organizations].sort())
  useEffect(() => {
    let live = true
    setLoading(true)
    setError(null)
    setData(null)
    void window.api.dashboard
      .botOverview(range, granularity, { upperOrgLv1: JSON.parse(orgKey) })
      .then((result) => {
        if (!live) return
        if (!result.success || !result.data) throw new Error(result.error ?? "Bot 统计暂时不可用")
        setData(result.data)
      })
      .catch((cause) => {
        if (live) setError(cause instanceof Error ? cause.message : "Bot 统计暂时不可用")
      })
      .finally(() => {
        if (live) setLoading(false)
      })
    return () => {
      live = false
      void window.api.dashboard.cancelRequests?.(["dashboard:botOverview"]).catch(() => {})
    }
  }, [range.from, range.to, granularity, orgKey, refreshKey, retry])

  return (
    <section
      className="rounded-xl border border-border bg-card p-4"
      aria-label="Bot 运营概览"
      aria-busy={loading}
    >
      <div className="mb-4 flex items-center justify-between gap-3">
        <div className="flex items-center gap-2">
          <Bot className="size-4 text-muted-foreground" />
          <h3 className="text-sm font-semibold">Bot 运营</h3>
          {data?.source === "mock" && (
            <span className="rounded bg-muted px-1.5 py-0.5 text-[10px] text-muted-foreground">
              示例数据
            </span>
          )}
          <InfoHint
            content={
              <div className="max-w-xs space-y-2">
                <p>统计当前时间范围及可见组织内的新埋点。旧版本数据不回填。</p>
                <p>
                  处理轮次包括对话、独立任务、例行任务、协作和后台汇报，不等同于用户消息数或模型调用数。首次招呼及本地渠道模拟不计入。
                </p>
                <p>
                  Bot 协作统计 Bot
                  间交办及结果回传触发的处理轮次，不是发送消息条数。群内普通发言和讨论归入对话处理。
                </p>
                <p>
                  活跃 Bot 和使用账号采用 ES 去重估算；账号指 App 登录账号，不是招乎群成员人数。
                </p>
              </div>
            }
          />
        </div>
        <button
          className="rounded-md p-1.5 text-muted-foreground hover:bg-muted disabled:opacity-40"
          aria-label="刷新 Bot 统计"
          disabled={loading}
          onClick={() => setRetry((n) => n + 1)}
        >
          <RefreshCw className={`size-3.5 ${loading ? "animate-spin" : ""}`} />
        </button>
      </div>
      {loading ? (
        <p className="py-6 text-center text-xs text-muted-foreground">正在读取 Bot 统计…</p>
      ) : error ? (
        <p role="alert" className="py-5 text-xs text-muted-foreground">
          {error}。可点击右上角重试。
        </p>
      ) : !data?.hasData ? (
        <p className="py-6 text-center text-xs text-muted-foreground">
          当前范围暂无 Bot 统计。升级后的使用记录上报后将在这里展示。
        </p>
      ) : (
        <BotMetrics data={data} />
      )}
    </section>
  )
}

export function BotMetrics({ data }: { data: BotOverviewData }) {
  const metrics = [
    ["活跃 Bot", count(data.activeBots), "本期开始处理的 Bot（去重估算）"],
    [
      "使用账号",
      count(data.activeOwners),
      "发生活跃执行的 App 登录账号（去重估算），不代表群成员人数"
    ],
    ["处理轮次", count(data.started), "本期开始的逻辑处理轮次，暂停恢复不会重复计数"],
    [
      "正常结束率",
      data.successRate === null ? "—" : `${(data.successRate * 100).toFixed(1)}%`,
      "正常结束 ÷（正常结束＋异常结束），按本期结束时间统计。主动停止和被新消息接续不计入分母，不表示用户已验收"
    ],
    [
      "平均处理时长",
      duration(data.avgDurationMs),
      "本期结束的正常或异常轮次，从交办到结束，含排队和等待用户时间"
    ],
    ["新增 Bot", count(data.createdBots), "本期新建的 Bot，不是当前存量"]
  ]
  const maxChannel = Math.max(1, ...data.channels.map((c) => c.count))
  return (
    <div className="space-y-5">
      <div className="grid grid-cols-2 gap-x-5 gap-y-4 lg:grid-cols-3 xl:grid-cols-6">
        {metrics.map(([label, value, hint]) => (
          <div key={label}>
            <div className="flex items-center gap-1 text-[11px] text-muted-foreground">
              {label}
              <InfoHint content={<p className="max-w-xs">{hint}</p>} />
            </div>
            <div className="mt-1 text-xl font-semibold tabular-nums">{value}</div>
          </div>
        ))}
      </div>
      <div className="grid gap-6 border-t border-border pt-4 lg:grid-cols-2">
        <div>
          <h4 className="mb-3 text-xs font-medium">使用渠道</h4>
          <div className="space-y-2.5">
            {data.channels.map((channel) => (
              <div
                key={channel.key}
                className="grid grid-cols-[80px_1fr_55px] items-center gap-3 text-xs"
              >
                <span className="text-muted-foreground">{BOT_CHANNELS[channel.key]}</span>
                <div className="h-1.5 overflow-hidden rounded-full bg-muted">
                  <div
                    className="h-full rounded-full bg-foreground/55"
                    style={{ width: `${(channel.count / maxChannel) * 100}%` }}
                  />
                </div>
                <span className="text-right tabular-nums">{count(channel.count)}</span>
              </div>
            ))}
          </div>
        </div>
        <div>
          <h4 className="mb-3 text-xs font-medium">处理类型</h4>
          <div className="flex flex-wrap gap-x-5 gap-y-3 text-xs">
            {data.runKinds.map((kind) => (
              <span key={kind.key} className="text-muted-foreground">
                {BOT_RUN_KINDS[kind.key]}
                <strong className="ml-2 font-medium tabular-nums text-foreground">
                  {count(kind.count)}
                </strong>
              </span>
            ))}
          </div>
          <p className="mt-4 text-[11px] leading-relaxed text-muted-foreground">
            正常结束 {count(data.completed)} · 异常结束 {count(data.failed)} · 主动停止{" "}
            {count(data.cancelled)} · 接续处理 {count(data.superseded)}
          </p>
        </div>
      </div>
      <div className="flex flex-wrap gap-x-6 gap-y-2 rounded-lg bg-muted/40 px-3 py-2.5 text-xs">
        <span>
          独立任务 <strong className="ml-1 font-medium">新建 {count(data.worksCreated)}</strong>
          <span className="ml-3 text-muted-foreground">
            确认完成 {count(data.worksCompleted)} · 继续处理 {count(data.worksReopened)}
          </span>
        </span>
        <span>
          招乎接入{" "}
          <span className="ml-1 text-muted-foreground">
            新增关联 {count(data.connected)} · 解除关联 {count(data.revoked)}
          </span>
        </span>
        <InfoHint
          content={
            <p className="max-w-xs">
              均为本期操作次数。关联已有会话也算新建独立任务；重新打开后再完成会再次计入确认次数，不能用确认次数除以本期新建数计算完成率。接入统计为
              App 首次观察到关联状态变化。
            </p>
          }
        />
        <span className="inline-flex items-center gap-1">
          招乎附件
          <strong className="ml-1 font-medium tabular-nums">
            已发送 {count(data.attachmentsSent)} 份
          </strong>
          <InfoHint
            content={
              <p className="max-w-xs">
                本期收到招乎发送成功回执的文件和图片，私聊、群聊及独立任务均计入。
                批量发送按文件份数统计；同一交付重试不重复计数。
                仅上传成功、发送失败或送达不确定的不计入；App 本地附件卡片不另计。
                从升级后开始统计，不回填历史记录。
              </p>
            }
          />
        </span>
      </div>
    </div>
  )
}
