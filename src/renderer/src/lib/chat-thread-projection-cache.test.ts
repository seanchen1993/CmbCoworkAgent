import { beforeEach, describe, expect, it } from "vitest"
import type { Message } from "@/types"
import {
  CHAT_THREAD_PROJECTION_CACHE_LIMIT,
  clearAllChatThreadProjectionRuntimesForTests,
  getChatThreadProjectionRuntime
} from "./chat-thread-projection-cache"

function message(id: string, role: Message["role"]): Message {
  const createdAt = new Date(1_700_000_000_000)
  return {
    id,
    role,
    content: id,
    created_at: createdAt,
    start_at: createdAt,
    end_at: createdAt
  }
}

describe("chat thread projection cache", () => {
  beforeEach(() => {
    clearAllChatThreadProjectionRuntimesForTests()
  })

  it("reuses one projection runtime across remounts of the same thread", () => {
    const first = getChatThreadProjectionRuntime("thread-a")
    const second = getChatThreadProjectionRuntime("thread-a")
    const other = getChatThreadProjectionRuntime("thread-b")

    expect(second).toBe(first)
    expect(other).not.toBe(first)
    expect(second.projectLiveDisplayMessages).toBe(first.projectLiveDisplayMessages)
    expect(second.projectToolDerivationMessages).toBe(first.projectToolDerivationMessages)
  })

  it("keeps stable history indexes off the remount hot path", () => {
    const runtime = getChatThreadProjectionRuntime("large-thread")
    const source = Array.from({ length: 20_000 }, (_, index) =>
      message(`message-${index}`, index % 5 === 0 ? "user" : "assistant")
    )
    let poisonStablePrefix = false
    const baseline = new Proxy(source, {
      get(target, property, receiver) {
        if (poisonStablePrefix && property === Symbol.iterator) {
          throw new Error("stable transcript was enumerated after remount")
        }
        return Reflect.get(target, property, receiver)
      }
    })
    const indexById = new Map(source.map((item, index) => [item.id, index]))
    const hookLogBucketByTurnId = new Map()

    const first = runtime.projectStableMessageIndexes({
      baseline,
      indexById,
      structureVersion: 1,
      hookLogBucketByTurnId,
      hookLogEnabled: false
    })
    poisonStablePrefix = true
    const remountedRuntime = getChatThreadProjectionRuntime("large-thread")
    const second = remountedRuntime.projectStableMessageIndexes({
      baseline,
      indexById,
      structureVersion: 1,
      hookLogBucketByTurnId,
      hookLogEnabled: false
    })

    expect(second).toBe(first)
    expect(second.visibleIndexes).toHaveLength(source.length)
    expect(second.lastUserIndex).toBe(19_995)
  })

  it("bounds retained runtimes with the same limit as idle thread holders", () => {
    const oldest = getChatThreadProjectionRuntime("thread-0")
    for (let index = 1; index <= CHAT_THREAD_PROJECTION_CACHE_LIMIT; index += 1) {
      getChatThreadProjectionRuntime(`thread-${index}`)
    }

    expect(getChatThreadProjectionRuntime("thread-0")).not.toBe(oldest)
  })
})
