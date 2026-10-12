import type { BotHostControlAPI, CoworkBotAPI } from "../../../shared/bot-api"
import { createBotIpcClient } from "../../../shared/bot-ipc-result"

// Domain errors must be constructed here, after Electron's context bridge.
export const botApi = createBotIpcClient<CoworkBotAPI>(() => window.api.bots)
export const botHostApi = createBotIpcClient<BotHostControlAPI>(() => window.api.botHost)
