import type { Thread } from "@/types"
import { isRemoteInboxMetadata } from "../../../shared/remote-inbox-workspace"

export { REMOTE_INBOX_WORKSPACE_NAME } from "../../../shared/remote-inbox-workspace"

export function isRemoteInboxThread(thread: Thread | null | undefined): boolean {
  return isRemoteInboxMetadata(thread?.metadata)
}
