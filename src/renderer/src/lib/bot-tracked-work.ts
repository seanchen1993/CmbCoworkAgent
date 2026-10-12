import {
  BOT_WORK_MAX_TRACKED,
  botTrackedWorkKey,
  botTrackedWorkTarget,
  type BotTrackedWorkState,
  type BotTrackedWorkTarget
} from "../../../shared/bot-work-pages"
/** The mounted consumers own these registrations; no timer and no remembered global run list. */
export class BotTrackedWorkRegistry {
  private targets = new Map<string, { target: BotTrackedWorkTarget; count: number }>()
  private capacityListeners = new Set<() => void>()
  onCapacityAvailable(listener: () => void): () => void {
    this.capacityListeners.add(listener)
    return () => this.capacityListeners.delete(listener)
  }
  register(target: BotTrackedWorkTarget): () => void {
    target = botTrackedWorkTarget.parse(target)
    const key = botTrackedWorkKey(target)
    const previous = this.targets.get(key)
    if (!previous && this.targets.size === BOT_WORK_MAX_TRACKED)
      throw new Error("当前打开的任务过多，请关闭部分面板后重试")
    const entry = previous ?? { target, count: 0 }
    entry.count++
    this.targets.set(key, entry)
    let released = false
    return () => {
      if (released) return
      released = true
      if (--entry.count === 0 && this.targets.get(key) === entry) {
        const wasFull = this.targets.size === BOT_WORK_MAX_TRACKED
        this.targets.delete(key)
        // A successful waiter may unsubscribe while another still waits for a slot.
        if (wasFull) for (const listener of [...this.capacityListeners]) listener()
      }
    }
  }
  list(): BotTrackedWorkTarget[] {
    return [...this.targets.values()].map((entry) => entry.target)
  }
  has(key: string): boolean {
    return this.targets.has(key)
  }
}

export interface BotTrackedWorkIssue {
  scope: string
  message: string
}

export function botTrackedWorkError(
  issue: BotTrackedWorkIssue | undefined,
  scope: string,
  enabled: boolean
): string | undefined {
  return enabled && issue?.scope === scope ? issue.message : undefined
}

/** Only rejected registrations wait for capacity; active consumers keep their refcounts. */
export function observeBotTrackedWorkRegistration(
  scope: string,
  register: () => () => void,
  watchCapacity: (retry: () => void) => () => void,
  publish: (issue?: BotTrackedWorkIssue) => void
): () => void {
  let stopped = false
  let release: (() => void) | undefined
  let unwatch: (() => void) | undefined
  const attempt = () => {
    if (stopped || release) return
    try {
      release = register()
      unwatch?.()
      unwatch = undefined
      publish(undefined)
    } catch (error) {
      publish({ scope, message: error instanceof Error ? error.message : "任务状态无法读取" })
      unwatch ??= watchCapacity(attempt)
    }
  }
  attempt()
  return () => {
    stopped = true
    unwatch?.()
    release?.()
  }
}

/** Transport results must retain the exact consumer address, including branch. */
export function isBotTrackedWorkState(
  target: BotTrackedWorkTarget,
  state: BotTrackedWorkState
): boolean {
  if (state.key !== botTrackedWorkKey(target)) return false
  const run = state.run
  switch (target.kind) {
    case "run":
      return !run || (run.id === target.runId && run.botId === target.botId)
    case "routine":
      return (
        !run ||
        (run.botId === target.botId &&
          run.source === `routine-manual:${target.routineId}` &&
          ["queued", "running", "waiting_input", "cancelling", "needs_review"].includes(run.status))
      )
    case "interaction": {
      const item = state.interaction
      return (
        (!run ||
          (run.id === target.runId &&
            run.conversationId === target.conversationId &&
            run.threadRootId === target.threadRootId)) &&
        (!item ||
          (item.id === target.interactionId &&
            item.address.runId === target.runId &&
            item.address.conversationId === target.conversationId &&
            item.address.threadRootId === target.threadRootId &&
            (!run || item.botId === run.botId)))
      )
    }
  }
}
