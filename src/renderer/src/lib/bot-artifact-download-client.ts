import { createBotIpcClient, type BotIpcTransport } from "../../../shared/bot-ipc-result"
import type {
  BotArtifactDownloadsAPI,
  BotArtifactDownloadSource
} from "../../../shared/bot-artifact-downloads"
import type { BotDownloadStartIntent, BotDownloadStartStore } from "./bot-artifact-download-starts"
import {
  isDefiniteBotDownloadStartFailure,
  verifyBotDownloadJob
} from "./bot-artifact-download-view"

/** Main owns bytes, queue, dialogs, paths and durable jobs. This adapter only
 * saves an exact start intent before IPC and verifies its acceptance receipt. */
export function createBotArtifactDownloadClient(
  transport: () => BotIpcTransport<BotArtifactDownloadsAPI>,
  starts: BotDownloadStartStore
) {
  const api = createBotIpcClient<BotArtifactDownloadsAPI>(transport)
  const subscribers = new Set<() => void>()
  const notify = () => {
    for (const callback of subscribers) callback()
  }
  async function checkStart(intent: BotDownloadStartIntent) {
    let job
    try {
      job = verifyBotDownloadJob(await api.start({ nonce: intent.nonce, source: intent.source }), {
        id: intent.nonce,
        source: intent.source
      })
    } catch (error) {
      if (isDefiniteBotDownloadStartFailure(error)) starts.forget(intent)
      notify()
      throw error
    }
    let cleanupFailed = false
    try {
      starts.forget(intent)
    } catch {
      cleanupFailed = true
    }
    notify()
    return { job, cleanupFailed }
  }
  async function start(source: BotArtifactDownloadSource, label: { name: string; mime: string }) {
    const intent = starts.remember(source, label)
    notify()
    return checkStart(intent)
  }
  return {
    api,
    starts,
    start,
    checkStart,
    subscribe(callback: () => void) {
      subscribers.add(callback)
      return () => {
        subscribers.delete(callback)
      }
    }
  }
}
export type BotArtifactDownloadClient = ReturnType<typeof createBotArtifactDownloadClient>
