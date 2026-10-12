import type { BotHostStatus } from "../../shared/bot-api"
import { BOT_BUILD_ID, type BotIdleRestartResult } from "./host-build"
import type { BotTransportClient } from "./transport-client"

export interface BotHostUpgradePorts {
  negativePreflight(): Promise<string | null>
  /** Main bounds only the submitted restart probe, not its read-only preflight. */
  restartIfIdle(hostId: string): Promise<BotIdleRestartResult>
}

/** Returns true only after this authenticated Host accepted an idle restart. */
export async function requestBotHostUpgrade(
  client: BotTransportClient,
  status: BotHostStatus,
  desiredBuild = BOT_BUILD_ID,
  ports?: BotHostUpgradePorts
): Promise<boolean> {
  if (status.buildId === desiredBuild) {
    client.upgradePending = null
    return false
  }
  if (!status.buildId) {
    client.upgradePending =
      "当前 Bot 后台不支持平滑升级，请完成或停止任务后关闭旧后台并重新打开应用"
    return false
  }
  if (ports) {
    try {
      const blocked = await ports.negativePreflight()
      if (blocked !== null) {
        client.upgradePending = `Bot 后台有待更新：${blocked}`
        return false
      }
    } catch {
      // A failed negative read must retain this usable authenticated client.
      // Throwing here would enter Main's reconnect/launch fallback instead.
      client.upgradePending = "Bot 后台有待更新：无法核对命令现场，请保留当前后台并查看诊断记录"
      return false
    }
  }
  const result = await (ports
    ? ports.restartIfIdle(status.hostId)
    : client.restartIfIdle(status.hostId))
  client.upgradePending = result.accepted
    ? "Bot 后台正在切换新版本"
    : `Bot 后台有待更新：${result.reason}`
  return result.accepted
}
