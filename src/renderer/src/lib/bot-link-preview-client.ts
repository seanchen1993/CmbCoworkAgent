import { createBotIpcClient, type BotIpcTransport } from "../../../shared/bot-ipc-result"
import type { BotLinkPreviewClient } from "../../../shared/bot-link-preview"

/** Renderer-local facade; resolve the existing contextBridge transport at call time. */
export function createBotLinkPreviewClient(
  transport: () => BotIpcTransport<BotLinkPreviewClient>
): BotLinkPreviewClient {
  return createBotIpcClient(transport)
}
