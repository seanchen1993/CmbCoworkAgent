import type { Thread } from "@/types"
import { isCoordinatorModeMetadata, isWorkflowModeMetadata } from "@/lib/coordinator-mode-helpers"

export function isBuiltinRobotThreadRemoteAccessEligible(
  thread: Thread | null | undefined
): boolean {
  if (!thread) return false

  const metadata = thread.metadata ?? {}
  const workspacePath = metadata.workspacePath
  return (
    !isCoordinatorModeMetadata(metadata) &&
    !isWorkflowModeMetadata(metadata) &&
    (metadata.remoteThread !== true || metadata.targetKind === "feature") &&
    metadata.targetKind !== "inbox" &&
    typeof workspacePath === "string" &&
    workspacePath.trim().length > 0
  )
}
