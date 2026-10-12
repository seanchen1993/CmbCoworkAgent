import { randomUUID } from "node:crypto"
import { z } from "zod"
import {
  BOT_ERROR_TRAY_LIMIT,
  BOT_ERROR_TRAY_TITLE_LIMIT,
  BOT_ERROR_TRAY_DETAIL_LIMIT,
  BOT_ERROR_TRAY_HINT_LIMIT,
  botErrorTrayAuthoritySchema,
  botErrorTraySchema,
  botErrorTraySnapshotSchema,
  botDismissErrorTraySchema,
  botClearErrorTraysSchema,
  type BotErrorTray,
  type BotErrorTrayAuthority,
  type BotErrorTraySnapshot,
  type BotDismissErrorTray,
  type BotClearErrorTrays
} from "../../shared/bot-error-trays"
import { safeBotErrorDiagnostic, safeBotErrorText } from "./error-diagnostic"

const EPISODE_LIMIT = 512
const internalIdentity = z.string().min(1).max(512)
const noticeIdentity = z
  .object({ episodeId: internalIdentity, groupKey: internalIdentity.optional() })
  .strict()

export type BotErrorTrayNotice = Pick<
  BotErrorTray,
  | "title"
  | "detail"
  | "hint"
  | "source"
  | "botId"
  | "conversationId"
  | "threadRootId"
  | "runId"
  | "diagnostic"
> & {
  /** A committed failure transition, never a poll/snapshot or model-supplied key. */
  episodeId: string
  /** Optional grouping of separate failure episodes from the same source/owner. */
  groupKey?: string
}

const copy = (item: BotErrorTray): BotErrorTray => ({ ...item, diagnostic: { ...item.diagnostic } })

/** Host-owned transient UI notifications. Execution history remains in BotStore.
 * Synchronous methods are atomic on the Host event loop; no I/O, timers or polling.
 * Only committed failure producers can push, while narrow RPC exposes read/clear.
 */
export class BotErrorTrays {
  private authority: BotErrorTrayAuthority
  private revision = 0
  private readonly items = new Map<string, BotErrorTray>()
  private readonly groups = new Map<string, string>()
  private readonly itemGroups = new Map<string, string>()
  private readonly episodes = new Map<string, true>()

  constructor(
    authority: BotErrorTrayAuthority,
    private readonly now: () => number = Date.now
  ) {
    this.authority = botErrorTrayAuthoritySchema.parse(authority)
  }

  /** A restore retires every prior notification and its commands. Host ID is
   * stable for this object; a new process creates a fresh object and Host UUID. */
  setDataEpoch(dataEpoch: string): void {
    const next = botErrorTrayAuthoritySchema.parse({ ...this.authority, dataEpoch })
    if (next.dataEpoch === this.authority.dataEpoch) return
    this.authority = next
    this.revision = 0
    this.items.clear()
    this.groups.clear()
    this.itemGroups.clear()
    this.episodes.clear()
  }

  snapshot(): BotErrorTraySnapshot {
    return {
      ...this.authority,
      revision: this.revision,
      items: Array.from(this.items.values(), copy)
    }
  }

  push(notice: BotErrorTrayNotice, knownSecrets: readonly string[] = []): BotErrorTraySnapshot {
    const identity = noticeIdentity.parse({
      episodeId: notice.episodeId,
      groupKey: notice.groupKey
    })
    const episodeId = identity.episodeId
    // A producer's grouping label never merges errors across task ownership.
    const groupKey =
      identity.groupKey === undefined
        ? undefined
        : JSON.stringify([
            notice.source,
            notice.botId ?? null,
            notice.conversationId ?? null,
            notice.threadRootId ?? null,
            notice.runId ?? null,
            identity.groupKey
          ])
    // Repeated delivery of one transition is not a new failure. In particular,
    // refresh must not resurrect an acknowledged or evicted notification.
    if (this.episodes.has(episodeId)) return this.snapshot()
    const previousId = groupKey === undefined ? undefined : this.groups.get(groupKey)
    const previous = previousId === undefined ? undefined : this.items.get(previousId)
    const timestamp = this.now()
    const nextRevision = this.nextRevision()
    const next = botErrorTraySchema.parse({
      kind: "error",
      id: previous?.id ?? randomUUID(),
      revision: nextRevision,
      title: safeBotErrorText(notice.title, BOT_ERROR_TRAY_TITLE_LIMIT, knownSecrets) || "执行失败",
      detail:
        safeBotErrorText(notice.detail, BOT_ERROR_TRAY_DETAIL_LIMIT, knownSecrets) ||
        "执行失败，请查看任务记录。",
      ...(notice.hint === undefined
        ? {}
        : { hint: safeBotErrorText(notice.hint, BOT_ERROR_TRAY_HINT_LIMIT, knownSecrets) }),
      source: notice.source,
      ...(notice.botId === undefined ? {} : { botId: notice.botId }),
      ...(notice.conversationId === undefined ? {} : { conversationId: notice.conversationId }),
      ...(notice.threadRootId === undefined ? {} : { threadRootId: notice.threadRootId }),
      ...(notice.runId === undefined ? {} : { runId: notice.runId }),
      diagnostic: safeBotErrorDiagnostic(notice.diagnostic, knownSecrets),
      count: Math.min(Number.MAX_SAFE_INTEGER, (previous?.count ?? 0) + 1),
      createdAt: previous?.createdAt ?? timestamp,
      updatedAt: Math.max(previous?.updatedAt ?? timestamp, timestamp)
    })
    this.revision = nextRevision
    // Move an updated notice to the newest end, keeping snapshot chronology.
    this.items.delete(next.id)
    this.items.set(next.id, next)
    if (groupKey !== undefined) {
      this.groups.set(groupKey, next.id)
      this.itemGroups.set(next.id, groupKey)
    }
    this.episodes.set(episodeId, true)
    if (this.episodes.size > EPISODE_LIMIT) this.episodes.delete(this.episodes.keys().next().value!)
    if (this.items.size > BOT_ERROR_TRAY_LIMIT) this.remove(this.items.keys().next().value!)
    return this.snapshot()
  }

  dismiss(raw: BotDismissErrorTray): BotErrorTraySnapshot {
    const input = botDismissErrorTraySchema.parse(raw)
    const item = this.items.get(input.id)
    if (!this.sameAuthority(input) || !item || item.revision !== input.revision)
      return this.snapshot()
    const revision = this.nextRevision()
    this.remove(item.id)
    this.revision = revision
    return this.snapshot()
  }

  clear(raw: BotClearErrorTrays): BotErrorTraySnapshot {
    const input = botClearErrorTraysSchema.parse(raw)
    if (!this.sameAuthority(input) || input.throughRevision > this.revision) return this.snapshot()
    const removable = Array.from(this.items.values()).filter(
      (item) => item.revision <= input.throughRevision
    )
    if (!removable.length) return this.snapshot()
    const revision = this.nextRevision()
    for (const item of removable) this.remove(item.id)
    this.revision = revision
    return this.snapshot()
  }

  private sameAuthority(input: BotErrorTrayAuthority): boolean {
    return input.hostId === this.authority.hostId && input.dataEpoch === this.authority.dataEpoch
  }

  private nextRevision(): number {
    if (this.revision >= Number.MAX_SAFE_INTEGER)
      throw new RangeError("Notification revision exhausted")
    return this.revision + 1
  }

  private remove(id: string): void {
    this.items.delete(id)
    const key = this.itemGroups.get(id)
    if (key !== undefined && this.groups.get(key) === id) this.groups.delete(key)
    this.itemGroups.delete(id)
  }
}

// The shared schema remains the single snapshot validation contract on wire.
export { botErrorTraySnapshotSchema }
