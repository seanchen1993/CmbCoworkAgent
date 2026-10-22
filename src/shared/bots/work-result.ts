import type { BotTaskOrigin, BotTaskState } from "./contracts"

export type BotWorkResultOrigin = Extract<BotTaskOrigin, { kind: "work_result" }>

/** A reply finishes a turn, not the user's business task. */
export function botWorkResultLabel(state: BotTaskState): string {
  switch (state) {
    case "completed":
      return "任务有新结果"
    case "failed":
      return "任务执行失败"
    case "cancelled":
      return "任务已停止"
    case "interrupted":
      return "任务执行中断"
    default:
      return "任务结果待确认"
  }
}
