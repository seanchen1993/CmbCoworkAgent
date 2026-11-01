import { getDb, getThreadRuntimeScope, getThreadMessagesPage } from "../../db"
import { types } from "node:util"
import {
  captureThreadIncarnation,
  matchesThreadIncarnation
} from "../../services/thread-incarnation"
import { isVisibleTranscriptMessage } from "../../../shared/checkpoint-transcript"
import type { FunctionPlacedAnchor } from "../../../shared/mods/v2/placed"
import type { Message } from "../../types"

type Cursor = {
  database: object
  incarnation: ReturnType<typeof captureThreadIncarnation>
  anchor: FunctionPlacedAnchor
  assertCurrent?: () => void
}
const cursors = new Map<string, Cursor>()
const unreadable = Symbol("unreadable-cursor-data")
const cursorFields = [
  "id",
  "role",
  "content",
  "provider_source_id",
  "provider_occurrence",
  "function_row",
  "function_row_invalid",
  "additional_kwargs",
  "kwargs"
] as const

/** A cursor is optional. Never run message accessors ahead of the original flush boundary. */
function cursorData(
  value: unknown,
  depth: number,
  budget: { remaining: number },
  active: WeakSet<object>
): unknown {
  if (
    value === null ||
    value === undefined ||
    typeof value === "string" ||
    typeof value === "boolean"
  )
    return value
  if (typeof value === "number") return Number.isFinite(value) ? value : unreadable
  if (typeof value !== "object" || depth === 0 || types.isProxy(value) || active.has(value))
    return unreadable
  const array = Array.isArray(value),
    prototype = Object.getPrototypeOf(value)
  if (prototype !== null && prototype !== (array ? Array.prototype : Object.prototype))
    return unreadable
  const descriptors = Object.getOwnPropertyDescriptors(value)
  const keys = Reflect.ownKeys(descriptors)
  if (
    keys.length > budget.remaining ||
    keys.some((key) => typeof key !== "string" || !("value" in descriptors[key]))
  )
    return unreadable
  budget.remaining -= keys.length
  active.add(value)
  try {
    if (array) {
      const result: unknown[] = []
      const length = descriptors.length?.value
      if (!Number.isSafeInteger(length) || keys.length !== length + 1) return unreadable
      for (let index = 0; index < length; index++) {
        const field = descriptors[String(index)]
        if (!field || !("value" in field)) return unreadable
        const item = cursorData(field.value, depth - 1, budget, active)
        if (item === unreadable) return unreadable
        result.push(item)
      }
      return result
    }
    const result: Record<string, unknown> = Object.create(null)
    for (const key of keys) {
      if (typeof key !== "string") return unreadable
      const item = cursorData(descriptors[key].value, depth - 1, budget, active)
      if (item === unreadable) return unreadable
      result[key] = item
    }
    return result
  } finally {
    active.delete(value)
  }
}

function anchor(
  message: Pick<Message, "id" | "role" | "content" | "provider_source_id" | "provider_occurrence">
): FunctionPlacedAnchor | undefined {
  if (!message || typeof message !== "object" || types.isProxy(message)) return
  const descriptors = Object.getOwnPropertyDescriptors(message)
  const keys = Reflect.ownKeys(descriptors)
  if (
    keys.length > 128 ||
    keys.some((key) => !("value" in descriptors[key as keyof typeof descriptors])) ||
    ["id", "role", "content"].some((key) => !Object.hasOwn(descriptors, key))
  )
    return
  if (descriptors.role.value !== "assistant" && descriptors.role.value !== "user") return
  const selected: Record<string, unknown> = Object.create(null)
  for (const key of cursorFields) {
    if (!Object.hasOwn(descriptors, key)) continue
    const field = descriptors[key]
    if (!field || !("value" in field)) return
    selected[key] = field.value
  }
  const snapshot = cursorData(selected, 4, { remaining: 128 }, new WeakSet())
  if (
    !snapshot ||
    snapshot === unreadable ||
    typeof snapshot !== "object" ||
    Array.isArray(snapshot)
  )
    return
  const data = snapshot as Record<string, unknown>
  const sourceId = data.provider_source_id,
    occurrence = data.provider_occurrence
  if (
    (data.role !== "assistant" && data.role !== "user") ||
    typeof data.id !== "string" ||
    !data.id ||
    (sourceId !== undefined && typeof sourceId !== "string") ||
    (occurrence !== undefined &&
      (typeof occurrence !== "number" || !Number.isSafeInteger(occurrence))) ||
    !isVisibleTranscriptMessage(data.role, data.content, data)
  )
    return undefined
  return {
    kind: "after-message",
    id: data.id,
    role: data.role,
    ...(sourceId ? { providerSourceId: sourceId } : {}),
    ...(occurrence === undefined ? {} : { providerOccurrence: occurrence })
  }
}
/** Called next to real native stream normalization, never from renderer payloads. */
export function rememberFunctionPlacedMessage(
  threadId: string,
  message: Parameters<typeof anchor>[0],
  assertCurrent?: () => void
): void {
  const point = anchor(message)
  if (!point) return
  const thread = getThreadRuntimeScope(threadId)
  if (!thread) return
  if (cursors.size >= 256 && !cursors.has(threadId)) cursors.delete(cursors.keys().next().value!)
  cursors.set(threadId, {
    database: getDb(),
    incarnation: captureThreadIncarnation(thread),
    anchor: point,
    assertCurrent
  })
}
export function forgetFunctionPlacedCursor(threadId: string): void {
  cursors.delete(threadId)
}
export function captureFunctionPlacedAnchor(threadId: string): FunctionPlacedAnchor | undefined {
  const thread = getThreadRuntimeScope(threadId)
  if (!thread) return undefined
  const cursor = cursors.get(threadId)
  if (cursor?.database === getDb() && matchesThreadIncarnation(thread, cursor.incarnation)) {
    try {
      cursor.assertCurrent?.()
      return { ...cursor.anchor }
    } catch {
      cursors.delete(threadId)
    }
  }
  const tail = getThreadMessagesPage(threadId, { limit: 32, includeVisibleMessagePresence: true })
  for (let i = tail.messages.length - 1; i >= 0; i--) {
    const point = anchor(tail.messages[i])
    if (point) return point
  }
  if (tail.total === 0 && tail.legacyCheckpointMigrationStatus !== "migrating")
    return { kind: "start" }
  return undefined
}
