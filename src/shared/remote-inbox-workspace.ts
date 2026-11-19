import { IM_DEFAULT_CHAT_TITLE } from "./im-display"

export const REMOTE_INBOX_WORKSPACE_NAME = IM_DEFAULT_CHAT_TITLE

export function isRemoteInboxMetadata(metadata?: Record<string, unknown>): boolean {
  return metadata?.targetKind === "inbox" &&
    metadata.imDeliveryContext !== null && typeof metadata.imDeliveryContext === "object"
}
