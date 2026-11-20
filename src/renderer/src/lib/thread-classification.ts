import { isHarnessProjectModeThread, isLocalWorkConversation, isRegularChatThread } from "../../../shared/thread-search-scope"
import type { Thread } from "@/types"

export {
  isBotThread,
  isLocalWorkConversation,
  isRegularChatThread,
  isHarnessFeatureThread,
  isHarnessProjectSessionThread,
  isHarnessProjectModeThread
} from "../../../shared/thread-search-scope"

export function isManagedLocalWorkConversation(thread: Thread | null | undefined): boolean {
  const metadata = thread?.metadata
  return (
    isLocalWorkConversation(thread) &&
    !isHarnessProjectModeThread(thread) &&
    !metadata?.remoteState &&
    !metadata?.remoteReadOnly &&
    metadata?.targetKind !== "inbox" &&
    !metadata?.imDeliveryContext
  )
}

export function findFirstChatThread(threads: Thread[]): Thread | null {
  return threads.find(isRegularChatThread) ?? null
}
