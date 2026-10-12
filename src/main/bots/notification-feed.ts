import { z } from "zod"
import type { BotEvent, BotRun, BotWorkspaceSnapshot, CoworkBot } from "../../shared/bot-types"
import type { BotNotificationSettings } from "../../shared/bot-notifications"
import type { BotDeepLink } from "../../shared/bot-deep-link"
import type { BotWorkspaceWorkState, BotWorkAttention } from "../../shared/bot-work-pages"
import type {
  BotNotificationEvent,
  BotNotificationRoute,
  BotNotificationTarget,
  BotNotificationCurrentState
} from "../../shared/bot-work-notifications"

export type NotificationWorkState = Omit<BotWorkspaceWorkState, "attention"> & {
  attention: (BotWorkAttention & {
    notificationRoute?: BotNotificationRoute
  })[]
  noticeStates?: BotNotificationCurrentState[]
}
export function notificationWork(
  snapshot: BotWorkspaceSnapshot
): NotificationWorkState | undefined {
  return snapshot.work as NotificationWorkState | undefined
}
const MAX_ROUTES = 256
import {
  SandOsNotificationDecider,
  buildNotificationContent,
  type NotificationSnapshot,
  type NotificationTransition
} from "../../shared/upstream/grok-os-notification"

const queued = z.object({
  botId: z.string(),
  conversationId: z.string(),
  source: z.string().optional(),
  parentRunId: z.string().nullable().optional(),
  messageId: z.string().optional()
})
const message = z.object({ runId: z.string(), conversationId: z.string() })
const settled = z.object({ status: z.string() })
type RunRoute = {
  botId: string
  conversationId: string
  messageId?: string
  source?: string
  parentRunId?: string | null
}
export interface BotDesktopNotice {
  botId: string
  runId: string
  kind: NotificationTransition["kind"]
  title: string
  body: string
  link: BotDeepLink
  /** Content-free observation, bound to the frame which admitted this notice. */
  authority?: {
    hostId: string
    dataEpoch: string
    atCursor: number
    target: BotNotificationTarget
  }
}
type Frame = {
  snapshot: BotWorkspaceSnapshot
  preferences: readonly BotNotificationSettings[]
  focused: boolean
  now: number
}

/** Snapshot state decides whether attention is still needed. Durable events
 * capture quick completed tasks which can start and finish between polls.
 * Neither approval contents nor model output enters desktop notifications. */
export class BotNotificationFeed {
  private decider = new SandOsNotificationDecider()
  private runs = new Map<string, RunRoute>()
  private lastMessage = new Map<string, string>()
  private attention = new Map<string, string>()
  private bots = new Set<string>()
  private preferences = new Map<string, boolean>()
  private inputs = new Map<string, NotificationWorkState["attention"][number]>()
  private paged = false
  private epoch: string | undefined
  private hostId: string | undefined
  cursor: number | null = null

  reset(): void {
    this.decider = new SandOsNotificationDecider()
    this.runs.clear()
    this.lastMessage.clear()
    this.attention.clear()
    this.bots.clear()
    this.preferences.clear()
    this.inputs.clear()
    this.paged = false
    this.cursor = null
    this.epoch = undefined
    this.hostId = undefined
  }
  seed(frame: Frame): void {
    this.reset()
    this.epoch = frame.snapshot.dataEpoch
    this.hostId = frame.snapshot.hostId
    this.cursor = frame.snapshot.cursor
    this.indexFrame(frame)
    for (const run of frame.snapshot.runs) this.remember(run)
    for (const bot of frame.snapshot.bots) {
      this.bots.add(bot.id)
      const input = this.waiting(bot.id, frame.snapshot)
      if (input) this.attention.set(bot.id, input.id)
      this.decider.seedBaseline([this.state(bot, frame, input?.reason)])
    }
  }
  private indexFrame(frame: Frame): void {
    this.paged = notificationWork(frame.snapshot)?.projection === "paged"
    if (this.paged)
      while (this.runs.size > MAX_ROUTES) this.runs.delete(this.runs.keys().next().value!)
    this.preferences = new Map(frame.preferences.map((item) => [item.botId, item.enabled]))
    this.inputs = new Map(
      (notificationWork(frame.snapshot)?.attention ?? []).map((item) => [item.botId, item])
    )
  }
  private remember(run: BotRun): void {
    this.rememberRoute(run.id, {
      botId: run.botId,
      conversationId: run.conversationId,
      messageId: run.messageId,
      source: run.source,
      parentRunId: run.parentRunId
    })
  }
  private rememberRoute(id: string, route: RunRoute): void {
    this.runs.delete(id)
    this.runs.set(id, route)
    if (this.paged)
      while (this.runs.size > MAX_ROUTES) this.runs.delete(this.runs.keys().next().value!)
  }
  private route(runId: string, snapshot: BotWorkspaceSnapshot): RunRoute | undefined {
    let route = this.runs.get(runId)
    if (!route) {
      const run = snapshot.runs.find((item) => item.id === runId)
      if (run) {
        this.remember(run)
        route = this.runs.get(runId)
      }
    }
    return route
  }
  private waiting(
    botId: string,
    snapshot: BotWorkspaceSnapshot
  ):
    | {
        id: string
        runId: string
        reason: string
        route?: BotNotificationRoute
      }
    | undefined {
    const work = notificationWork(snapshot)
    if (work?.projection === "paged") {
      const item = this.inputs.get(botId)
      return item
        ? {
            id: item.id,
            runId: item.runId,
            route: item.notificationRoute,
            reason:
              item.kind === "approval"
                ? "有操作等待你确认，点击查看。"
                : item.kind === "question"
                  ? "有问题等待你回答，点击查看。"
                  : "任务已中断，请核对执行结果后继续。"
          }
        : undefined
    }
    const owned = new Set(snapshot.runs.filter((run) => run.botId === botId).map((run) => run.id))
    const interaction = snapshot.interactions.find(
      (item) => item.status === "pending" && owned.has(item.runId)
    )
    if (interaction)
      return {
        id: interaction.id,
        runId: interaction.runId,
        reason:
          interaction.kind === "approval"
            ? "有操作等待你确认，点击查看。"
            : "有问题等待你回答，点击查看。"
      }
    const interrupted = snapshot.runs.find(
      (run) => run.botId === botId && run.status === "needs_review"
    )
    if (interrupted)
      return {
        id: `recovery:${interrupted.id}:${interrupted.fence}`,
        runId: interrupted.id,
        reason: "任务已中断，请核对执行结果后继续。"
      }
    return undefined
  }
  private state(bot: CoworkBot, frame: Frame, reason?: string): NotificationSnapshot {
    return {
      id: bot.id,
      name: bot.name,
      isRunning:
        notificationWork(frame.snapshot)?.projection === "paged"
          ? (() => {
              const counts = notificationWork(frame.snapshot)!.byBot[bot.id]
              return (
                !!counts &&
                counts.queued + counts.running + counts.waitingInput + counts.cancelling > 0
              )
            })()
          : frame.snapshot.runs.some(
              (run) =>
                run.botId === bot.id &&
                ["queued", "running", "waiting_input", "cancelling"].includes(run.status)
            ),
      awaitingReason: reason ?? null,
      notifyEnabled: this.preferences.get(bot.id) ?? true,
      isHiddenFromSidebar: bot.hidden,
      lastMessageId: this.lastMessage.get(bot.id),
      lastMessagePreview: null
    }
  }
  private notice(
    transition: NotificationTransition,
    runId: string,
    frame: Frame,
    projected?: BotNotificationRoute
  ): BotDesktopNotice | null {
    if (notificationWork(frame.snapshot)?.projection === "paged") {
      if (!projected || !frame.snapshot.hostId || !frame.snapshot.dataEpoch) return null
      return {
        botId: transition.agentId,
        runId,
        kind: transition.kind,
        ...buildNotificationContent(transition),
        link: projected.link,
        authority: {
          hostId: frame.snapshot.hostId,
          dataEpoch: frame.snapshot.dataEpoch,
          atCursor: frame.snapshot.cursor,
          target: projected.target
        }
      }
    }
    let route = this.route(runId, frame.snapshot)
    for (
      let depth = 0;
      route?.source === "workflow-child" && route.parentRunId && depth < 8;
      depth++
    )
      route = this.route(route.parentRunId, frame.snapshot)
    if (!route?.messageId) return null
    return {
      botId: transition.agentId,
      runId,
      kind: transition.kind,
      ...buildNotificationContent(transition),
      link: {
        conversationId: route.conversationId,
        messageId: route.messageId
      }
    }
  }
  consume(frame: Frame, events: readonly (BotEvent | BotNotificationEvent)[]): BotDesktopNotice[] {
    if (
      this.cursor === null ||
      this.epoch !== frame.snapshot.dataEpoch ||
      this.hostId !== frame.snapshot.hostId ||
      frame.snapshot.cursor < this.cursor
    ) {
      this.seed(frame)
      return []
    }
    this.indexFrame(frame)
    const nextBots = new Map(frame.snapshot.bots.map((bot) => [bot.id, bot]))
    for (const id of this.bots)
      if (!nextBots.has(id)) {
        this.decider.forget(id)
        this.lastMessage.delete(id)
        this.attention.delete(id)
      }
    this.bots = new Set(nextBots.keys())
    for (const run of frame.snapshot.runs) this.remember(run)
    const completions = new Map<
        string,
        {
          runId: string
          status: string
          createdAt: number
          route?: BotNotificationRoute
        }
      >(),
      ended = new Set<string>()
    for (const event of events) {
      if (event.cursor <= this.cursor || event.cursor > frame.snapshot.cursor) continue
      this.cursor = event.cursor
      if (notificationWork(frame.snapshot)?.projection === "paged") {
        const completion = "completion" in event ? event.completion : undefined
        if (completion && completion.target.kind === "completion")
          completions.set(completion.target.botId, {
            runId: event.entityId,
            status: completion.status,
            createdAt: event.createdAt,
            route: completion
          })
        continue
      }
      if (!("payload" in event)) continue
      if (event.kind === "run.queued") {
        const data = queued.safeParse(event.payload)
        if (data.success)
          this.rememberRoute(event.entityId, {
            ...this.runs.get(event.entityId),
            ...data.data
          })
      } else if (event.kind === "message.created") {
        const data = message.safeParse(event.payload),
          route = data.success ? this.route(data.data.runId, frame.snapshot) : undefined
        if (data.success && route && route.conversationId === data.data.conversationId)
          route.messageId = event.entityId
      } else if (event.kind === "run.settled") {
        const data = settled.safeParse(event.payload),
          route = this.route(event.entityId, frame.snapshot)
        ended.add(event.entityId)
        if (
          data.success &&
          route &&
          route.source !== "workflow-child" &&
          ["succeeded", "failed"].includes(data.data.status)
        )
          completions.set(route.botId, {
            runId: event.entityId,
            status: data.data.status,
            createdAt: event.createdAt
          })
      }
    }
    const result: BotDesktopNotice[] = [],
      gates = { isWindowFocused: frame.focused, nowMs: frame.now }
    for (const bot of frame.snapshot.bots) {
      const input = this.waiting(bot.id, frame.snapshot),
        state = this.state(bot, frame, input?.reason),
        completion = completions.get(bot.id)
      if (completion) {
        this.lastMessage.set(bot.id, completion.runId)
        if (!input) {
          this.decider.observeAgent({
            ...state,
            isRunning: true,
            awaitingReason: null
          })
          const transitions = this.decider.decideAgent(
            {
              ...state,
              isRunning: false,
              awaitingReason: null,
              lastMessageId: completion.runId,
              lastMessagePreview:
                completion.status === "failed" ? "任务未完成，点击查看原因。" : null
            },
            {
              ...gates,
              // Account for old results without consuming the live throttle.
              isWindowFocused: frame.focused || frame.now - completion.createdAt > 300000
            }
          )
          for (const transition of transitions) {
            const notice = this.notice(transition, completion.runId, frame, completion.route)
            if (notice) result.push(notice)
          }
        }
      }
      const final = this.state(bot, frame, input?.reason)
      if (input && this.attention.get(bot.id) !== input.id)
        this.decider.observeAgent({ ...final, awaitingReason: null })
      for (const transition of this.decider.decideAgent(final, gates))
        if (input) {
          const notice = this.notice(transition, input.runId, frame, input.route)
          if (notice) result.push(notice)
        }
      if (input) this.attention.set(bot.id, input.id)
      else this.attention.delete(bot.id)
    }
    // Legacy/A identity lists are complete. Preserve the preceding complete
    // frame's routes until all events through this frame have been consumed:
    // a formerly active run can finish beyond this tick's bounded event pages.
    const legacyActive =
      !this.paged && this.cursor === frame.snapshot.cursor
        ? new Set(frame.snapshot.runs.map((run) => run.id))
        : undefined
    for (const [id, route] of this.runs)
      if (
        !nextBots.has(route.botId) ||
        (this.paged ? ended.has(id) : legacyActive && !legacyActive.has(id))
      )
        this.runs.delete(id)
    return result
  }
}
