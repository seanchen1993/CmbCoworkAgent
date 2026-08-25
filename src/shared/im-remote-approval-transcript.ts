export const IM_REMOTE_APPROVAL_TRANSCRIPT_MESSAGE_PREFIX = "im-remote-approval:"

export function isImRemoteApprovalTranscriptMessageId(messageId: unknown): boolean {
  return (
    typeof messageId === "string" &&
    messageId.startsWith(IM_REMOTE_APPROVAL_TRANSCRIPT_MESSAGE_PREFIX)
  )
}
