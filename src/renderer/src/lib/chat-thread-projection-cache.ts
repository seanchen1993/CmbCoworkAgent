import type { Message } from "@/types"
import type { HookLogBucket } from "@/lib/thread-context"
import { createChatMessageProjector } from "@/lib/chat-message-projection"
import {
  createDynamicLiveVisibilityProjector,
  createLiveDisplayMessageProjector
} from "@/lib/live-display-message-projection"
import { createIncrementalToolDerivationProjector } from "@/lib/message-render-stability"
import { messageHasVisibleRow } from "@/lib/message-display-visibility"
import { buildMessageBubbleTimingMeta } from "@/lib/message-bubble-timing"
import { buildToolResultAssociations } from "@/lib/worker-tool-result-key"
import { mergeVisibleChatMessageIndexes } from "@/lib/chat-visible-index"
import { createChatScrollQuestionRevisionProjector } from "@/components/chat/ChatScrollNavigator"

export const CHAT_THREAD_PROJECTION_CACHE_LIMIT = 6

export interface StableMessageIndexProjection {
  visibleIndexes: number[]
  userMessageIds: Set<string>
  lastUserIndex: number
}

export interface ChatThreadProjectionRuntime {
  projectLiveDisplayMessages: ReturnType<typeof createLiveDisplayMessageProjector>
  chatMessageProjectors: WeakMap<Message[], ReturnType<typeof createChatMessageProjector>>
  projectChatScrollQuestionRevision: ReturnType<
    typeof createChatScrollQuestionRevisionProjector
  >
  projectDynamicLiveVisibility: ReturnType<typeof createDynamicLiveVisibilityProjector>
  projectToolDerivationMessages: ReturnType<typeof createIncrementalToolDerivationProjector>
  projectHookLogBucketMap: (buckets: readonly HookLogBucket[]) => Map<string, HookLogBucket>
  projectStableMessageIndexes: (input: {
    baseline: readonly Message[]
    indexById: ReadonlyMap<string, number>
    structureVersion: number
    hookLogBucketByTurnId: ReadonlyMap<string, HookLogBucket>
    hookLogEnabled: boolean
  }) => StableMessageIndexProjection
  projectDetachedHookLogBuckets: (input: {
    displayMessages: readonly Message[]
    structureVersion: number
    hookLogBuckets: readonly HookLogBucket[]
  }) => HookLogBucket[]
  projectToolResults: (
    messages: readonly Message[],
    projectionVersion: number
  ) => ReturnType<typeof buildToolResultAssociations>
  projectTimingMeta: (
    messages: Message[],
    structureVersion: number
  ) => ReturnType<typeof buildMessageBubbleTimingMeta>
  projectVisibleMessageIndexes: (input: {
    stableIndexes: readonly number[]
    dynamicVisibilityByIndex: ReadonlyMap<number, boolean>
    orderedDynamicIndexes: readonly number[]
    dynamicVersion: number
  }) => number[]
  projectToolCallDisplayState: <T>(input: {
    messages: readonly Message[]
    projectionVersion: number
    toolResults: object
    toolCallStates: object
    pendingApproval: object | null | undefined
    isLoading: boolean
    compute: () => T
  }) => T
}

function createChatThreadProjectionRuntime(): ChatThreadProjectionRuntime {
  let previousHookLogBuckets: readonly HookLogBucket[] | null = null
  let hookLogBucketMap = new Map<string, HookLogBucket>()

  let stableInput:
    | {
        baseline: readonly Message[]
        indexById: ReadonlyMap<string, number>
        structureVersion: number
        hookLogBucketByTurnId: ReadonlyMap<string, HookLogBucket>
        hookLogEnabled: boolean
      }
    | undefined
  let stableProjection: StableMessageIndexProjection | undefined

  let detachedInput:
    | {
        displayMessages: readonly Message[]
        structureVersion: number
        hookLogBuckets: readonly HookLogBucket[]
      }
    | undefined
  let detachedProjection: HookLogBucket[] | undefined

  let previousToolMessages: readonly Message[] | null = null
  let previousToolVersion = -1
  let toolResults: ReturnType<typeof buildToolResultAssociations> | undefined

  let previousTimingMessages: Message[] | null = null
  let previousTimingVersion = -1
  let timingMeta: ReturnType<typeof buildMessageBubbleTimingMeta> | undefined

  let previousStableIndexes: readonly number[] | null = null
  let previousDynamicVisibility: ReadonlyMap<number, boolean> | null = null
  let previousOrderedDynamicIndexes: readonly number[] | null = null
  let previousDynamicVersion = -1
  let visibleIndexes: number[] | undefined

  let previousToolCallDisplayInput:
    | {
        messages: readonly Message[]
        projectionVersion: number
        toolResults: object
        toolCallStates: object
        pendingApproval: object | null | undefined
        isLoading: boolean
      }
    | undefined
  let toolCallDisplayState: unknown

  return {
    projectLiveDisplayMessages: createLiveDisplayMessageProjector(),
    chatMessageProjectors: new WeakMap(),
    projectChatScrollQuestionRevision: createChatScrollQuestionRevisionProjector(),
    projectDynamicLiveVisibility: createDynamicLiveVisibilityProjector(),
    projectToolDerivationMessages: createIncrementalToolDerivationProjector(),
    projectHookLogBucketMap: (buckets) => {
      if (buckets === previousHookLogBuckets) return hookLogBucketMap
      const next = new Map<string, HookLogBucket>()
      for (const bucket of buckets) next.set(bucket.turnId, bucket)
      previousHookLogBuckets = buckets
      hookLogBucketMap = next
      return next
    },
    projectStableMessageIndexes: (input) => {
      if (
        stableInput &&
        stableProjection &&
        input.baseline === stableInput.baseline &&
        input.indexById === stableInput.indexById &&
        input.structureVersion === stableInput.structureVersion &&
        input.hookLogBucketByTurnId === stableInput.hookLogBucketByTurnId &&
        input.hookLogEnabled === stableInput.hookLogEnabled
      ) {
        return stableProjection
      }

      const nextVisibleIndexes: number[] = []
      const userMessageIds = new Set<string>()
      let lastUserIndex = -1
      let previousVisibleIndex = -1
      let requiresSort = false
      for (const message of input.baseline) {
        if (message.role === "user") userMessageIds.add(message.id)
        const displayIndex = input.indexById.get(message.id)
        if (displayIndex === undefined) continue
        if (message.role === "user") lastUserIndex = Math.max(lastUserIndex, displayIndex)
        const hasHookLogChip = Boolean(
          input.hookLogEnabled &&
            message.role === "user" &&
            input.hookLogBucketByTurnId.get(message.id)?.entries.length
        )
        if (!messageHasVisibleRow(message, hasHookLogChip)) continue
        if (displayIndex < previousVisibleIndex) requiresSort = true
        previousVisibleIndex = displayIndex
        nextVisibleIndexes.push(displayIndex)
      }
      if (requiresSort) nextVisibleIndexes.sort((left, right) => left - right)

      stableInput = input
      stableProjection = {
        visibleIndexes: nextVisibleIndexes,
        userMessageIds,
        lastUserIndex
      }
      return stableProjection
    },
    projectDetachedHookLogBuckets: (input) => {
      if (
        detachedInput &&
        detachedProjection &&
        input.displayMessages === detachedInput.displayMessages &&
        input.structureVersion === detachedInput.structureVersion &&
        input.hookLogBuckets === detachedInput.hookLogBuckets
      ) {
        return detachedProjection
      }
      const userMessageIds = new Set<string>()
      for (const message of input.displayMessages) {
        if (message.role === "user") userMessageIds.add(message.id)
      }
      detachedInput = input
      detachedProjection = input.hookLogBuckets.filter(
        (bucket) => bucket.entries.length > 0 && !userMessageIds.has(bucket.turnId)
      )
      return detachedProjection
    },
    projectToolResults: (messages, projectionVersion) => {
      if (
        toolResults &&
        messages === previousToolMessages &&
        projectionVersion === previousToolVersion
      ) {
        return toolResults
      }
      previousToolMessages = messages
      previousToolVersion = projectionVersion
      toolResults = buildToolResultAssociations(messages)
      return toolResults
    },
    projectTimingMeta: (messages, structureVersion) => {
      if (
        timingMeta &&
        messages === previousTimingMessages &&
        structureVersion === previousTimingVersion
      ) {
        return timingMeta
      }
      previousTimingMessages = messages
      previousTimingVersion = structureVersion
      timingMeta = buildMessageBubbleTimingMeta(messages)
      return timingMeta
    },
    projectVisibleMessageIndexes: (input) => {
      if (
        visibleIndexes &&
        input.stableIndexes === previousStableIndexes &&
        input.dynamicVisibilityByIndex === previousDynamicVisibility &&
        input.orderedDynamicIndexes === previousOrderedDynamicIndexes &&
        input.dynamicVersion === previousDynamicVersion
      ) {
        return visibleIndexes
      }
      previousStableIndexes = input.stableIndexes
      previousDynamicVisibility = input.dynamicVisibilityByIndex
      previousOrderedDynamicIndexes = input.orderedDynamicIndexes
      previousDynamicVersion = input.dynamicVersion
      visibleIndexes = mergeVisibleChatMessageIndexes(
        input.stableIndexes,
        input.dynamicVisibilityByIndex,
        input.orderedDynamicIndexes
      )
      return visibleIndexes
    },
    projectToolCallDisplayState: (input) => {
      if (
        previousToolCallDisplayInput &&
        input.messages === previousToolCallDisplayInput.messages &&
        input.projectionVersion === previousToolCallDisplayInput.projectionVersion &&
        input.toolResults === previousToolCallDisplayInput.toolResults &&
        input.toolCallStates === previousToolCallDisplayInput.toolCallStates &&
        input.pendingApproval === previousToolCallDisplayInput.pendingApproval &&
        input.isLoading === previousToolCallDisplayInput.isLoading
      ) {
        return toolCallDisplayState as ReturnType<typeof input.compute>
      }
      previousToolCallDisplayInput = input
      toolCallDisplayState = input.compute()
      return toolCallDisplayState as ReturnType<typeof input.compute>
    }
  }
}

const runtimeByThreadId = new Map<string, ChatThreadProjectionRuntime>()

export function getChatThreadProjectionRuntime(threadId: string): ChatThreadProjectionRuntime {
  const cached = runtimeByThreadId.get(threadId)
  if (cached) {
    runtimeByThreadId.delete(threadId)
    runtimeByThreadId.set(threadId, cached)
    return cached
  }

  const runtime = createChatThreadProjectionRuntime()
  runtimeByThreadId.set(threadId, runtime)
  while (runtimeByThreadId.size > CHAT_THREAD_PROJECTION_CACHE_LIMIT) {
    const oldestThreadId = runtimeByThreadId.keys().next().value
    if (typeof oldestThreadId !== "string") break
    runtimeByThreadId.delete(oldestThreadId)
  }
  return runtime
}

export function clearChatThreadProjectionRuntime(threadId: string): void {
  runtimeByThreadId.delete(threadId)
}

export function clearAllChatThreadProjectionRuntimesForTests(): void {
  runtimeByThreadId.clear()
}
