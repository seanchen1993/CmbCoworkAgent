import type { BotMessage } from "../../../shared/bot-types"
import type { BotReactionState } from "../../../shared/bot-reactions"
import type { BotThreadSummary } from "../../../shared/bot-threads"
import { projectThreadCounts } from "../components/bots/upstream/grok-thread-counts"

export const BOT_MESSAGE_PAGE_SIZE = 100
export const BOT_MESSAGE_RESIDENT_LIMIT = 1_500
export const BOT_MESSAGE_RESIDENT_BYTES = 16 * 1024 * 1024

const messageWeights = new WeakMap<BotMessage, number>()

/** Conservative resident estimate, including UTF-16 strings and reference metadata.
 * This is a cache budget, not a measurement of the JavaScript engine's heap.
 */
function estimatedValueBytes(value: unknown): number {
  if (typeof value === "string") return 16 + value.length * 2
  if (typeof value === "number") return 8
  if (typeof value === "boolean") return 4
  if (!value || typeof value !== "object") return 0
  if (Array.isArray(value))
    return 32 + value.reduce((bytes, item) => bytes + 8 + estimatedValueBytes(item), 0)
  return Object.entries(value).reduce(
    (bytes, [key, item]) => bytes + 16 + key.length * 2 + estimatedValueBytes(item),
    64
  )
}

export function estimateBotMessageBytes(message: BotMessage): number {
  let bytes = messageWeights.get(message)
  if (bytes === undefined) {
    bytes = estimatedValueBytes(message)
    messageWeights.set(message, bytes)
  }
  return bytes
}

interface BotMessageWindowOptions {
  direction: "older" | "newer" | "target"
  targetId?: string
  maximumMessages?: number
  maximumBytes?: number
}

/** Release only an end of the contiguous durable sequence; both ends remain reloadable.
 * A single oversize row is kept so a budget can never make a message inaccessible.
 * The Host's 8 MiB RPC frame bounds the input accepted by the renderer.
 */
export function boundBotMessageWindow(
  messages: BotMessage[],
  {
    direction,
    targetId,
    maximumMessages = BOT_MESSAGE_RESIDENT_LIMIT,
    maximumBytes = BOT_MESSAGE_RESIDENT_BYTES
  }: BotMessageWindowOptions
): { messages: BotMessage[]; removedOlder: boolean; removedNewer: boolean } {
  if (!messages.length) return { messages, removedOlder: false, removedNewer: false }
  const maximum = Math.max(1, Math.floor(maximumMessages))
  const budget = Math.max(1, maximumBytes)
  let start =
    direction === "older"
      ? 0
      : direction === "target"
        ? Math.max(
            0,
            messages.findIndex((message) => message.id === targetId)
          )
        : messages.length - 1
  let end = start + 1
  let bytes = estimateBotMessageBytes(messages[start])
  while (end - start < maximum) {
    let extendOlder =
      direction === "newer" ||
      (direction === "target" && start > 0 && (end === messages.length || (end - start) % 2 === 1))
    let next = extendOlder ? start - 1 : end
    if (
      direction === "target" &&
      (next < 0 ||
        next >= messages.length ||
        bytes + estimateBotMessageBytes(messages[next]) > budget)
    ) {
      // A large neighbor on one side must not prevent a target window filling the other.
      extendOlder = !extendOlder
      next = extendOlder ? start - 1 : end
    }
    if (next < 0 || next >= messages.length) break
    const nextBytes = estimateBotMessageBytes(messages[next])
    if (bytes + nextBytes > budget) break
    bytes += nextBytes
    if (extendOlder) start--
    else end++
  }
  return {
    messages: start === 0 && end === messages.length ? messages : messages.slice(start, end),
    removedOlder: start > 0,
    removedNewer: end < messages.length
  }
}

interface BotMessageMergeOptions {
  direction?: "older" | "newer"
  followTail?: boolean
  maximumMessages?: number
  maximumBytes?: number
  pageLimit?: number
}

/** Keep one contiguous history window. After a long disconnection, a full latest
 * page without overlap replaces the cache; paging backwards can then fill the gap.
 */
export function mergeBotMessagePage(
  existing: BotMessage[],
  incoming: BotMessage[],
  latest: boolean,
  options: BotMessageMergeOptions = {}
) {
  const reset =
    latest &&
    incoming.length === (options.pageLimit ?? BOT_MESSAGE_PAGE_SIZE) &&
    existing.length > 0 &&
    incoming[0].sequence > existing[existing.length - 1].sequence
  const merge = (previous: BotMessage | undefined, message: BotMessage): BotMessage => {
    const reactionState = previous?.reactionState
    const threadRead = previous?.threadSummary?.readState
    const preserveReaction =
      reactionState && reactionState.revision > (message.reactionState?.revision ?? 0)
    const preserveRead =
      threadRead &&
      message.threadSummary &&
      threadRead.revision > message.threadSummary.readState.revision
    return preserveReaction || preserveRead
      ? {
          ...message,
          ...(preserveReaction ? { reactionState } : {}),
          ...(preserveRead
            ? { threadSummary: { ...message.threadSummary!, readState: threadRead } }
            : {})
        }
      : message
  }
  const entries = new Map((reset ? [] : existing).map((message) => [message.id, message]))
  for (const message of incoming) entries.set(message.id, merge(entries.get(message.id), message))
  const merged = [...entries.values()].sort((a, b) => a.sequence - b.sequence)
  const bounded = boundBotMessageWindow(merged, {
    direction:
      options.direction ??
      (latest || !existing.length || incoming[0]?.sequence >= existing[0].sequence
        ? "newer"
        : "older"),
    maximumMessages: options.maximumMessages,
    maximumBytes: options.maximumBytes
  })
  // Automatic refresh must not evict the row being read. Keep its contiguous window and
  // expose forward paging instead; overlapping metadata can still advance by revision.
  if (
    latest &&
    options.followTail === false &&
    existing.length &&
    (reset || bounded.removedOlder)
  ) {
    const updates = new Map(incoming.map((message) => [message.id, message]))
    return {
      messages: existing.map((message) => {
        const next = updates.get(message.id)
        return next ? merge(message, next) : message
      }),
      reset: false,
      removedOlder: false,
      removedNewer: false,
      deferredLatest: (incoming.at(-1)?.sequence ?? 0) > existing[existing.length - 1].sequence
    }
  }
  return { ...bounded, reset, deferredLatest: false }
}

export function mergeBotReactionStates(
  messages: BotMessage[],
  changes: BotReactionState[]
): BotMessage[] {
  const updates = new Map(changes.map((state) => [state.messageId, state]))
  return messages.map((message) => {
    const next = updates.get(message.id)
    return next && next.revision > (message.reactionState?.revision ?? 0)
      ? { ...message, reactionState: next }
      : message
  })
}

/** Polling can finish after the user marks a branch read; never roll that revision back. */
export function mergeBotThreadSummaries(
  messages: BotMessage[],
  summaries: BotThreadSummary[]
): BotMessage[] {
  const updates = new Map(summaries.map((summary) => [summary.rootId, summary]))
  const counts = new Map(
    projectThreadCounts(
      {
        threadCounts: Object.fromEntries(
          summaries.map((summary) => [summary.rootId, summary.count])
        )
      },
      messages.map((message) => message.id)
    ).map((entry) => [entry.rootId, entry.count])
  )
  return messages.map((message) => {
    const next = updates.get(message.id)
    if (!next) return message
    const previous = message.threadSummary
    const threadSummary = counts.has(message.id)
      ? {
          ...next,
          readState:
            previous && previous.readState.revision > next.readState.revision
              ? previous.readState
              : next.readState
        }
      : undefined
    return JSON.stringify(previous) === JSON.stringify(threadSummary)
      ? message
      : { ...message, threadSummary }
  })
}
