import type { Thread } from "@/types"
import { BOT_WORK_REMOTE_ACCESS_BLOCKED } from "../../../shared/bots/conversation"

export function botWorkRemoteAccessBlockedReason(thread: Thread | null | undefined): string | null {
  const metadata = thread?.metadata
  return metadata?.botHostId === "local" && typeof metadata.botWorkId === "string"
    ? BOT_WORK_REMOTE_ACCESS_BLOCKED
    : null
}

export function isBuiltinRobotThreadRemoteAccessEligible(
  thread: Thread | null | undefined
): boolean {
  if (!thread) return false

  const metadata = thread.metadata ?? {}
  const workspacePath = metadata.workspacePath
  return (
    (metadata.remoteThread !== true || metadata.targetKind === "feature") &&
    metadata.targetKind !== "inbox" &&
    typeof workspacePath === "string" &&
    workspacePath.trim().length > 0
  )
}
