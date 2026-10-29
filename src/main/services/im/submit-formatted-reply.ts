import type { RemoteImReplyV1 } from "../../../shared/im-gateway-contract"
import type { ImReplySubmissionResult } from "./gateway-client"

export async function submitFormattedImReply(
  client: { submitReply(reply: RemoteImReplyV1): Promise<ImReplySubmissionResult> },
  reply: RemoteImReplyV1
): Promise<ImReplySubmissionResult> {
  try {
    return await client.submitReply(reply)
  } catch (error) {
    const failure = error as { reasonCode?: string; resultUnknown?: boolean } | null
    if (
      reply.message.type !== "markdown" ||
      failure?.reasonCode !== "INVALID_PAYLOAD" ||
      failure.resultUnknown
    )
      throw error
    // Explicit rejection only: preserve segment boundaries and idempotency identity.
    return client.submitReply({ ...reply, message: { ...reply.message, type: "text" } })
  }
}
