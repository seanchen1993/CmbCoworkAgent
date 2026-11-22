import {
  isHarnessProjectModeThread as isSharedHarnessProjectModeThread,
  isLocalWorkConversation,
  isRegularChatThread as isSharedRegularChatThread
} from "../../../shared/thread-search-scope"
import type { Thread } from "@/types"
import { readHostProjectThreadTarget } from "./host-project-thread"

export {
  isBotThread,
  isLocalWorkConversation,
  isHarnessFeatureThread,
  isHarnessProjectSessionThread
} from "../../../shared/thread-search-scope"

export function isHarnessProjectModeThread(thread: Thread | null | undefined): boolean {
  return isSharedHarnessProjectModeThread(thread) || readHostProjectThreadTarget(thread) !== null
}

export function isRegularChatThread(thread: Thread | null | undefined): boolean {
  return isSharedRegularChatThread(thread) && !isHarnessProjectModeThread(thread)
}

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
