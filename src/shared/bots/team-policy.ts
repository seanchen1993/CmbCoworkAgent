import { resolveAgentModeFromMetadata } from "../agent-mode-metadata"
import { BotError } from "./contracts"

export const BOT_TEAM_UNSUPPORTED =
  "Bot 不支持 Team 模式。请在原工作台使用 Team；已关联的会话请先解除任务关联，历史和文件会保留。"

/** Admission only: never rewrite existing modes, histories or pending worker results. */
export function assertBotNonTeamConversation(metadata: unknown): void {
  if (resolveAgentModeFromMetadata(metadata) === "coordinator")
    throw new BotError("CONFLICT", BOT_TEAM_UNSUPPORTED)
}
