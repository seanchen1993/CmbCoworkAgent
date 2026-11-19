import { isHarnessProjectModeThread as isSharedHarnessProjectModeThread } from "../../../shared/thread-search-scope"
import type { Thread } from "@/types"
import { readHostProjectThreadTarget } from "./host-project-thread"

export { isHarnessFeatureThread, isHarnessProjectSessionThread } from "../../../shared/thread-search-scope"

export function isHarnessProjectModeThread(thread: Thread | null | undefined): boolean {
  return isSharedHarnessProjectModeThread(thread) || readHostProjectThreadTarget(thread) !== null
}

export function findFirstChatThread(threads: Thread[]): Thread | null {
  return threads.find((thread) => !isHarnessProjectModeThread(thread)) ?? null
}
