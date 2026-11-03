/** Versioned Bot properties; never include prompts, Bot/group names, paths or model output.
 * The envelope reuses the existing account/organization metadata of operational events. */
export const BOT_METRICS_VERSION = 1
export const BOT_EVENTS = {
  created: "bot.created",
  started: "bot.run.started",
  ended: "bot.run.ended",
  workCreated: "bot.work.created",
  workCompleted: "bot.work.completed",
  workReopened: "bot.work.reopened",
  connected: "bot.im.connected",
  revoked: "bot.im.revoked"
} as const
export const BOT_CHANNELS = {
  app_private: "App 私聊",
  app_group: "App 群聊",
  zhaohu_private: "招乎私聊",
  zhaohu_group: "招乎群聊"
} as const
export const BOT_RUN_KINDS = {
  chat: "对话处理",
  work: "独立任务",
  schedule: "例行任务",
  collaboration: "Bot 协作",
  notification: "后台汇报",
  introduction: "首次招呼"
} as const

export interface BotOverviewData {
  source: "es" | "mock"
  hasData: boolean
  activeBots: number
  activeOwners: number
  createdBots: number
  started: number
  completed: number
  failed: number
  cancelled: number
  superseded: number
  successRate: number | null
  avgDurationMs: number | null
  worksCreated: number
  worksCompleted: number
  worksReopened: number
  connected: number
  revoked: number
  channels: { key: keyof typeof BOT_CHANNELS; count: number }[]
  runKinds: { key: keyof typeof BOT_RUN_KINDS; count: number }[]
}
