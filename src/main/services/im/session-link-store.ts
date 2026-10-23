import { randomBytes } from "node:crypto"
import type { ImTargetSnapshot } from "./conversation-state"
import type { ImPersistenceDependencies } from "./persistence"
import { readAll, readOne } from "./persistence"

const CODE_ALPHABET = "23456789ABCDEFGHJKLMNPQRSTUVWXYZ"
export const IM_SESSION_CODE_PATTERN = /^[23456789ABCDEFGHJKLMNPQRSTUVWXYZ]{8}$/u

export interface ImSessionLink {
  code: string
  principal_id: string
  conversation_key: string
  thread_id: string
  target_kind: ImTargetSnapshot["kind"]
  target_label: string
}

export interface ImSessionSwitchCard {
  delivery_id: string
  code: string
  interaction_id: string
  tag: string
  state: "pending" | "sent" | "skipped" | "handling" | "handled"
  attempts: number
  next_attempt_at: number
  response: string | null
  receipt_id: string | null
  update_pending: number
}

export interface PrepareImSessionLink {
  principalId: string
  conversationKey: string
  threadId: string
  kind: ImTargetSnapshot["kind"]
  label: string
  deliveryId: string
}

/** Local locators, not grants. Codes are never recycled and every switch rechecks access. */
export class ImSessionLinkStore {
  constructor(
    private readonly persistence: ImPersistenceDependencies,
    private readonly newCode = () =>
      Array.from(randomBytes(8), (byte) => CODE_ALPHABET[byte & 31]).join("")
  ) {}

  prepare(input: PrepareImSessionLink): string {
    const db = this.persistence.getDatabase()
    let link = readOne<ImSessionLink>(
      db,
      "SELECT * FROM im_session_links WHERE principal_id = ? AND conversation_key = ? AND thread_id = ?",
      [input.principalId, input.conversationKey, input.threadId]
    )
    if (!link) {
      let code: string | undefined
      for (let attempt = 0; attempt < 32; attempt++) {
        const candidate = this.newCode()
        if (!IM_SESSION_CODE_PATTERN.test(candidate))
          throw new Error("Invalid session code generator")
        if (!this.get(candidate)) {
          code = candidate
          break
        }
      }
      if (!code) throw new Error("Could not allocate a unique session code")
      db.run("INSERT INTO im_session_links VALUES (?, ?, ?, ?, ?, ?, ?)", [
        code,
        input.principalId,
        input.conversationKey,
        input.threadId,
        input.kind,
        input.label,
        this.persistence.now()
      ])
      link = this.get(code)!
    } else if (link.target_label !== input.label) {
      db.run("UPDATE im_session_links SET target_label = ? WHERE code = ?", [
        input.label,
        link.code
      ])
    }
    const existing = this.getCard(input.deliveryId)
    if (existing && existing.code !== link.code)
      throw new Error("Session card delivery identity conflict")
    if (!existing)
      db.run(
        "INSERT INTO im_session_switch_cards (delivery_id, code, interaction_id, tag, created_at) VALUES (?, ?, ?, ?, ?)",
        [
          input.deliveryId,
          link.code,
          randomBytes(16).toString("hex"),
          randomBytes(24).toString("base64url"),
          this.persistence.now()
        ]
      )
    // The reply's existing atomic outbox flush persists these rows before sending its code.
    this.persistence.markDirty()
    return link.code
  }

  get(code: string): ImSessionLink | null {
    return readOne(
      this.persistence.getDatabase(),
      "SELECT * FROM im_session_links WHERE code = ?",
      [code.toUpperCase()]
    )
  }

  getCard(deliveryId: string): ImSessionSwitchCard | null {
    return readOne(
      this.persistence.getDatabase(),
      "SELECT * FROM im_session_switch_cards WHERE delivery_id = ?",
      [deliveryId]
    )
  }

  getCardByTag(tag: string): ImSessionSwitchCard | null {
    return readOne(
      this.persistence.getDatabase(),
      "SELECT * FROM im_session_switch_cards WHERE tag = ?",
      [tag]
    )
  }

  readyCards(updates = false): ImSessionSwitchCard[] {
    return readAll(
      this.persistence.getDatabase(),
      updates
        ? "SELECT * FROM im_session_switch_cards WHERE update_pending = 1 AND next_attempt_at <= ? ORDER BY created_at, delivery_id LIMIT 4"
        : `SELECT card.* FROM im_session_switch_cards card
         WHERE card.state = 'pending' AND card.next_attempt_at <= ?
           AND EXISTS (SELECT 1 FROM im_reply_outbox reply WHERE reply.delivery_id = card.delivery_id)
           AND NOT EXISTS (SELECT 1 FROM im_reply_outbox reply WHERE reply.delivery_id = card.delivery_id AND reply.state != 'sent')
         ORDER BY card.created_at, card.delivery_id LIMIT 4`,
      [this.persistence.now()]
    )
  }

  async saveCard(card: ImSessionSwitchCard): Promise<void> {
    this.persistence
      .getDatabase()
      .run(
        `UPDATE im_session_switch_cards SET state = ?, attempts = ?, next_attempt_at = ?, response = ?, receipt_id = ?, update_pending = ? WHERE delivery_id = ?`,
        [
          card.state,
          card.attempts,
          card.next_attempt_at,
          card.response,
          card.receipt_id,
          card.update_pending,
          card.delivery_id
        ]
      )
    this.persistence.markDirty()
    await this.persistence.flushStrict()
  }

  async claimCard(card: ImSessionSwitchCard, receiptId: string): Promise<boolean> {
    const db = this.persistence.getDatabase()
    db.run(
      "UPDATE im_session_switch_cards SET state = 'handling', receipt_id = ? WHERE delivery_id = ? AND state IN ('pending', 'sent', 'skipped')",
      [receiptId, card.delivery_id]
    )
    const claimed = db.getRowsModified() === 1
    if (claimed) {
      this.persistence.markDirty()
      await this.persistence.flushStrict()
    }
    return claimed
  }
}

export function prepareImSessionLink(
  store: Pick<ImSessionLinkStore, "prepare"> | undefined,
  input: PrepareImSessionLink
): string | undefined {
  if (!store) return undefined
  try {
    return store.prepare(input)
  } catch (error) {
    console.warn("[IM] Session shortcut unavailable; retaining session picker fallback:", error)
    return undefined
  }
}
