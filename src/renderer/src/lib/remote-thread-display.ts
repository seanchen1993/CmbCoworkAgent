import type { Thread } from "@/types"
import { IM_DEFAULT_CHAT_TITLE } from "../../../shared/im-display"

export const REMOTE_INBOX_WORKSPACE_NAME = IM_DEFAULT_CHAT_TITLE

export function isRemoteInboxThread(thread: Thread | null | undefined): boolean {
  const metadata = thread?.metadata
  return (
    metadata?.targetKind === "inbox" &&
    metadata.imDeliveryContext !== null &&
    typeof metadata.imDeliveryContext === "object"
  )
}
