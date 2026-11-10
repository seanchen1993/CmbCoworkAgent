import type { RemoteImReplyV1 } from "../../../shared/im-gateway-contract"
import { imConversationStateStore } from "./conversation-state"
import { imEventStore, type ImEventStore } from "./event-store"

/**
 * Whether the reader switched this conversation to text. Asked once more when
 * a card is confirmed, because the switch can land while the card is in
 * flight — the resend that came with it could not see a gate not yet recorded.
 * Unreadable reads as no: the notice is still kept, only the handover waits.
 */
export function conversationSwitchedToText(
  conversationKey: string,
  warn: (message: string, error?: unknown) => void
): boolean {
  try {
    return imConversationStateStore.getReplyMode(conversationKey) === "text"
  } catch (error) {
    warn("Reply mode could not be read.", error)
    return false
  }
}

/**
 * What a resend did. `failed` counts notices that could not be queued; each is
 * kept, so another /文字模式 开 tries it again — which the reader can only know
 * to do if the reply says so.
 */
export interface ImTextResendResult {
  resent: number
  failed: number
}

/**
 * Text notices a delivered card stood in for, kept until /文字模式 asks for them.
 *
 * A gate whose card went out sends no text, which is right until the reader
 * finds the card cut short by the Zhaohu client. Switching to text mode then
 * has to hand over the one they are looking at, not just the next one.
 *
 * The notice is kept as built rather than rebuilt at resend time. The outbox
 * rejects a delivery id that comes back with different content, and the text
 * of these gates does not stay still: it quotes the thread title, a feature
 * grant snapshot and, for Biz Retry, the thread's latest assistant message.
 *
 * Keyed by the gate's notification id. An entry is removed when it is sent and
 * when its gate ends, so a notice goes out at most once, and never for a gate
 * that has already been decided.
 */
export class ImWithheldTextNotices {
  private readonly notices = new Map<string, RemoteImReplyV1[]>()

  withhold(id: string, notice: RemoteImReplyV1[]): void {
    this.notices.set(id, notice)
  }

  forget(id: string): void {
    this.notices.delete(id)
  }

  /** Sends every withheld notice for this conversation whose gate is still open. */
  async resend(input: {
    conversationKey: string
    isOpen: (id: string) => boolean
    /** Recorded on the outbox when the gate closed while its notice was queued. */
    closedReasonCode: string
    warn: (message: string, error?: unknown) => void
    events?: Pick<ImEventStore, "enqueueProactiveReplies" | "markOutboxFailed">
  }): Promise<ImTextResendResult> {
    const events = input.events ?? imEventStore
    let resent = 0
    let failed = 0
    for (const [id, notice] of [...this.notices]) {
      if (notice[0]?.conversationKey !== input.conversationKey) continue
      // Removed before the first await, so nothing that runs meanwhile can send
      // the same notice a second time.
      this.notices.delete(id)
      if (!input.isOpen(id)) continue
      try {
        const outbox = await events.enqueueProactiveReplies(notice)
        // The check every original text path makes: a gate decided while this
        // was being queued must not arrive afterwards looking open.
        if (!input.isOpen(id)) {
          await Promise.all(
            outbox.map((record) => events.markOutboxFailed(record.outboxId, input.closedReasonCode))
          )
          continue
        }
        resent += 1
      } catch (error) {
        // Put back, so the next /文字模式 开 can try this one again.
        this.notices.set(id, notice)
        failed += 1
        input.warn("Withheld text notice could not be resent.", error)
      }
    }
    return { resent, failed }
  }
}
