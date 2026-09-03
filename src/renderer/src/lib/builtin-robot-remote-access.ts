import type { Thread } from "@/types"

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
