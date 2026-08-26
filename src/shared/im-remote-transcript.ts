const IM_REMOTE_TRANSCRIPT_MESSAGE_PREFIXES = [
  "im-remote-approval:",
  "im-remote-user-input:"
] as const

export function isImRemoteControlTranscriptMessageId(messageId: unknown): boolean {
  return (
    typeof messageId === "string" &&
    IM_REMOTE_TRANSCRIPT_MESSAGE_PREFIXES.some((prefix) => messageId.startsWith(prefix))
  )
}
