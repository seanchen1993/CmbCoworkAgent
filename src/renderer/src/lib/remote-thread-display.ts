import type { Thread } from "@/types"

export const REMOTE_INBOX_WORKSPACE_NAME = "远程收件箱"

export function isRemoteInboxThread(thread: Thread | null | undefined): boolean {
  const metadata = thread?.metadata
  return (
    metadata?.targetKind === "inbox" &&
    metadata.imDeliveryContext !== null &&
    typeof metadata.imDeliveryContext === "object"
  )
}
