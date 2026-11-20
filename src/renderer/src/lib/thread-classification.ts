import { isHarnessProjectModeThread } from "../../../shared/thread-search-scope"
import type { Thread } from "@/types"

export {
  isHarnessFeatureThread,
  isHarnessProjectSessionThread,
  isHarnessProjectModeThread
} from "../../../shared/thread-search-scope"

export function findFirstChatThread(threads: Thread[]): Thread | null {
  return threads.find((thread) => !isHarnessProjectModeThread(thread)) ?? null
}
