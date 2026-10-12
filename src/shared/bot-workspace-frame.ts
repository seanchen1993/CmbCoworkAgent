import type { CoworkBotAPI } from "./bot-api"
import { BOT_RUN_OUTPUT_CAPABILITY } from "./bot-run-output"
import { BOT_WORK_PAGES_CAPABILITY, type BotWorkView } from "./bot-work-pages"
import { BotDomainError } from "./bot-types"

/** Negotiate before using an additive read contract. A modern frame is bound to
 * the exact Host and data generation that advertised that contract. */
export async function readBotWorkspaceFrame(
  api: Pick<CoworkBotAPI, "status" | "snapshot">,
  view?: BotWorkView
) {
  for (let attempt = 0; attempt < 2; attempt++) {
    const host = await api.status()
    const summary = host.capabilities?.includes(BOT_RUN_OUTPUT_CAPABILITY) ?? false
    const paged = host.capabilities?.includes(BOT_WORK_PAGES_CAPABILITY) ?? false
    const snapshot = await api.snapshot(
      paged
        ? {
            runProjection: "summary",
            workProjection: "paged",
            hostId: host.hostId,
            dataEpoch: host.dataEpoch,
            ...(view ? { view } : {})
          }
        : summary
          ? { runProjection: "summary" }
          : undefined
    )
    if (
      (!summary && !paged) ||
      (snapshot.hostId === host.hostId && snapshot.dataEpoch === host.dataEpoch)
    )
      return { host, snapshot }
  }
  throw new BotDomainError("workspace_changed", "Bot 后台或数据已变化，请重新读取")
}
