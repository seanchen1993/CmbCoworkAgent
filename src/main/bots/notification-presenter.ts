import type { BotWorkspaceSnapshot } from "../../shared/bot-types"
import { notificationWork, type BotDesktopNotice } from "./notification-feed"
import {
  botNotificationTargetKey,
  BOT_NOTIFICATION_MAX_TARGETS,
  type BotNotificationTarget
} from "../../shared/bot-work-notifications"

export interface BotNativeNotice {
  once(event: "click" | "close" | "failed", callback: () => void): unknown
  show(): void
  close(): void
}

/** Native notices are expendable views, never task/approval authority. */
export class BotNotificationPresenter {
  private current?: BotWorkspaceSnapshot
  private stopped = false
  private readonly active = new Map<
    string,
    { notice: BotDesktopNotice; native: BotNativeNotice; cancelled: boolean }
  >()
  constructor(
    private readonly ports: {
      create(notice: BotDesktopNotice): BotNativeNotice | null
      navigate(notice: BotDesktopNotice): void
    }
  ) {}
  frame(snapshot: BotWorkspaceSnapshot): void {
    if (this.stopped) return
    if (this.current?.dataEpoch !== snapshot.dataEpoch || this.current?.hostId !== snapshot.hostId)
      this.clear()
    this.current = snapshot
    for (const [key, entry] of this.active) if (!this.allowed(entry.notice)) this.remove(key)
  }
  targets(): BotNotificationTarget[] {
    return [...this.active.values()].flatMap((entry) =>
      entry.notice.authority ? [entry.notice.authority.target] : []
    )
  }
  private allowed(notice: BotDesktopNotice): boolean {
    const snapshot = this.current
    if (!snapshot) return false
    const bot = snapshot.bots.find((item) => item.id === notice.botId)
    if (
      !bot ||
      bot.hidden ||
      snapshot.notificationSettings?.some((item) => item.botId === bot.id && !item.enabled)
    )
      return false
    const work = notificationWork(snapshot)
    if (work?.projection === "paged") {
      const authority = notice.authority
      if (
        !authority ||
        authority.hostId !== snapshot.hostId ||
        authority.dataEpoch !== snapshot.dataEpoch
      )
        return false
      const key = botNotificationTargetKey(authority.target)
      const state = work.noticeStates?.find((item) => item.key === key)
      if (state) return state.current
      // A fresh event/attention observation belongs to this exact atomic frame.
      // Later frames must explicitly revalidate; page absence is not authority.
      if (authority.atCursor !== snapshot.cursor) return false
      return notice.kind === "agent-done"
        ? authority.target.kind === "completion"
        : work.attention.some(
            (item) =>
              item.notificationRoute &&
              botNotificationTargetKey(item.notificationRoute.target) === key
          )
    }
    if (
      notice.authority &&
      (notice.authority.hostId !== snapshot.hostId ||
        notice.authority.dataEpoch !== snapshot.dataEpoch)
    )
      return false
    if (notice.kind === "agent-done") return true
    return (
      snapshot.runs.some((run) => run.id === notice.runId && run.status === "needs_review") ||
      snapshot.interactions.some((item) => item.runId === notice.runId && item.status === "pending")
    )
  }
  show(notice: BotDesktopNotice): void {
    if (this.stopped || !this.allowed(notice)) return
    const key = `${notice.botId}:${notice.kind}`
    this.remove(key)
    while (this.active.size >= BOT_NOTIFICATION_MAX_TARGETS)
      this.remove(this.active.keys().next().value!)
    const native = this.ports.create(notice)
    if (!native) return
    const entry = { notice, native, cancelled: false }
    const epoch = this.current?.dataEpoch,
      hostId = this.current?.hostId
    this.active.set(key, entry)
    const forget = () => {
      if (this.active.get(key) === entry) this.active.delete(key)
    }
    // Keep at most32 recently closed observations until replacement or exact
    // invalidation: some platforms emit close before click. Their late clicks
    // still participate in the next frame's exact target revalidation.
    native.once("close", () => {})
    native.once("failed", () => {
      entry.cancelled = true
      forget()
    })
    native.once("click", () => {
      // close may precede click on some platforms. Revalidate against the most
      // recent snapshot, including data restoration and resolved human gates.
      if (
        !this.stopped &&
        !entry.cancelled &&
        epoch === this.current?.dataEpoch &&
        hostId === this.current?.hostId &&
        this.allowed(notice)
      )
        this.ports.navigate(notice)
      forget()
    })
    try {
      native.show()
    } catch {
      this.remove(key)
    }
  }
  private remove(key: string): void {
    const entry = this.active.get(key)
    this.active.delete(key)
    if (entry) entry.cancelled = true
    try {
      entry?.native.close()
    } catch {
      /* OS notification may already be gone. */
    }
  }
  clear(): void {
    for (const key of this.active.keys()) this.remove(key)
  }
  stop(): void {
    this.stopped = true
    this.clear()
    this.current = undefined
  }
}
