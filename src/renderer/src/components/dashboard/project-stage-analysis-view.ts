import type { DashboardProjectModeStageRow } from "./use-dashboard"

/**
 * 阶段耗时弹窗的纯展示逻辑。
 *
 * 从组件里拆出来是为了能测：弹窗本身依赖 dialog / lucide，node 环境的用例拉不动。
 */

/**
 * 参与「单轮最慢」评选的最低轮次数。
 *
 * 轮次太少时平均值不稳：一个只跑过 1 轮、恰好那轮卡了 3 分钟的阶段，平均耗时会碾压
 * 所有正常阶段，把标记吸走，而它根本不是「这个项目慢在哪」的答案。
 */
export const SLOWEST_AVG_MIN_CONVERSATIONS = 5

/**
 * 找出单轮平均耗时最长的阶段，用于在表里高亮。
 *
 * 这个标记存在的理由：表格按总耗时降序排，而总耗时基本由轮次数决定——DEV 阶段几乎
 * 总是排第一，只因为它轮次最多。真正值得查的是「总耗时排第三、但单轮最慢」那种阶段，
 * 不单独标出来就会被排序埋掉。
 *
 * 全部阶段都不够轮次时返回 null，不退而求其次去标一个样本量不足的。
 */
export function resolveSlowestAvgStage(stages: DashboardProjectModeStageRow[]): string | null {
  let best: DashboardProjectModeStageRow | null = null
  for (const stage of stages) {
    if (stage.metrics.conversationCount < SLOWEST_AVG_MIN_CONVERSATIONS) continue
    if (!best || stage.metrics.avgDurationMs > best.metrics.avgDurationMs) best = stage
  }
  return best?.nodeName ?? null
}

/**
 * 耗时的人读格式。
 *
 * 跨度很大：单轮可能几百毫秒，项目总时长可能几十小时，所以分四档而不是统一一个单位。
 * 0 显示 `—` 而不是 `0ms`——这一列里 0 的含义是「没有数据」，写成 0ms 像个真实测量值。
 */
export function formatStageDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms <= 0) return "—"
  if (ms < 1000) return `${Math.round(ms)}ms`
  const seconds = ms / 1000
  if (seconds < 60) return `${seconds.toFixed(1)}s`
  const minutes = Math.floor(seconds / 60)
  const restSeconds = Math.round(seconds % 60)
  if (minutes < 60) return `${minutes}m${String(restSeconds).padStart(2, "0")}s`
  const hours = Math.floor(minutes / 60)
  return `${hours}h${String(minutes % 60).padStart(2, "0")}m`
}

/** 阶段占项目总耗时的比例，0~1。总耗时为 0 时没有比例可言。 */
export function stageDurationShare(stageDurationMs: number, totalDurationMs: number): number {
  if (totalDurationMs <= 0) return 0
  const share = stageDurationMs / totalDurationMs
  if (!Number.isFinite(share) || share < 0) return 0
  return Math.min(1, share)
}

export const PROJECT_ELAPSED_HINT =
  "项目历时 = 最后执行结束时间 − 项目创建时间。按项目全生命周期内主动触发的主 Agent 轮次取最晚结束时间，包含成功、失败及取消的轮次，不含子 Agent、定时任务和心跳。包含空闲、人工等待及跨天间隔，不代表项目已完成，也不是累计运行耗时。运行结束并上报后更新；时间缺失或异常时显示 —。"

export function formatProjectElapsed(ms: number | null | undefined): string {
  if (ms == null || !Number.isFinite(ms) || ms < 0) return "—"
  if (ms < 60_000) return "不足1分钟"
  const minutes = Math.floor(ms / 60_000)
  const days = Math.floor(minutes / 1440)
  const hours = Math.floor((minutes % 1440) / 60)
  return `${days ? `${days}天 ` : ""}${hours ? `${hours}小时 ` : ""}${minutes % 60}分钟`
}
