import { getThreadCore, updateThread, type ThreadRow } from "../db"
import type { ThreadMetadataPatch } from "../types"
import { isAgentOutputStyle } from "../../shared/agent-output-style"
import {
  resolveThreadExecutionModeFromMetadata,
  type ThreadExecutionMode
} from "../../shared/agent-mode-metadata"

const UNSAFE_METADATA_KEYS = new Set(["__proto__", "prototype", "constructor"])
const RENDERER_METADATA_PATCH_MAX_BYTES = 8 * 1024
const RENDERER_MODEL_ID_MAX_BYTES = 1024
const RENDERER_METADATA_PATCH_MAX_FIELDS = 8
const RENDERER_METADATA_KEY_MAX_CHARS = 64

export const RENDERER_WRITABLE_THREAD_METADATA_KEYS = new Set([
  "agentMode",
  "subagentsEnabled",
  "coordinatorMode",
  "memoryEnabled",
  "outputStyle",
  "conciseModeEnabled",
  "model"
])

function assertSafeMetadataKey(key: string): void {
  if (!key || UNSAFE_METADATA_KEYS.has(key)) {
    throw new Error(`Invalid thread metadata key: ${key || "<empty>"}`)
  }
}

export function parseThreadMetadata(raw: string | null | undefined): Record<string, unknown> {
  if (!raw) return {}
  try {
    const parsed = JSON.parse(raw) as unknown
    return parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {}
  } catch {
    return {}
  }
}

export function getThreadExecutionMode(
  metadata: Record<string, unknown>
): ThreadExecutionMode {
  return resolveThreadExecutionModeFromMetadata(metadata)
}

export function assertNoActiveAgentModeTransition(
  currentMetadata: Record<string, unknown>,
  candidateMetadata: Record<string, unknown>,
  active: boolean
): void {
  if (
    active &&
    getThreadExecutionMode(currentMetadata) !== getThreadExecutionMode(candidateMetadata)
  ) {
    throw new Error("当前会话仍在响应中，请等待完成或取消后再切换执行模式。")
  }
}

export function assertNoTranscriptAgentModeTransition(
  currentMetadata: Record<string, unknown>,
  candidateMetadata: Record<string, unknown>,
  hasTranscript: boolean
): void {
  if (
    hasTranscript &&
    getThreadExecutionMode(currentMetadata) !== getThreadExecutionMode(candidateMetadata)
  ) {
    throw new Error("当前会话已有对话消息，执行模式已锁定，请新开会话切换。")
  }
}

export function validateThreadMetadataPatch(
  patch: ThreadMetadataPatch,
  allowedKeys?: ReadonlySet<string>
): void {
  if (!patch || typeof patch !== "object" || Array.isArray(patch)) {
    throw new Error("Invalid thread metadata patch")
  }
  for (const key of Object.keys(patch)) {
    if (key !== "set" && key !== "remove") {
      throw new Error(`Invalid thread metadata patch field: ${key}`)
    }
  }
  if (
    patch.set !== undefined &&
    (patch.set === null || typeof patch.set !== "object" || Array.isArray(patch.set))
  ) {
    throw new Error("Invalid thread metadata set patch")
  }
  if (patch.remove !== undefined && !Array.isArray(patch.remove)) {
    throw new Error("Invalid thread metadata remove patch")
  }

  const setKeys = Object.keys(patch.set ?? {})
  const removeKeys = patch.remove ?? []
  const seenRemove = new Set<string>()
  for (const key of [...setKeys, ...removeKeys]) {
    if (typeof key !== "string") throw new Error("Invalid thread metadata key")
    assertSafeMetadataKey(key)
    if (allowedKeys && !allowedKeys.has(key)) {
      throw new Error(`Thread metadata key is not renderer-writable: ${key}`)
    }
  }
  for (const key of removeKeys) {
    if (seenRemove.has(key)) throw new Error(`Duplicate thread metadata remove key: ${key}`)
    seenRemove.add(key)
  }
  for (const key of setKeys) {
    if (seenRemove.has(key)) {
      throw new Error(`Thread metadata key cannot be set and removed together: ${key}`)
    }
  }
}

export function validateRendererThreadMetadataPatch(patch: ThreadMetadataPatch): void {
  if (!patch || typeof patch !== "object" || Array.isArray(patch)) {
    throw new Error("Invalid thread metadata patch")
  }
  if (patch.remove !== undefined && !Array.isArray(patch.remove)) {
    throw new Error("Invalid thread metadata remove patch")
  }
  if (
    patch.set !== undefined &&
    (patch.set === null || typeof patch.set !== "object" || Array.isArray(patch.set))
  ) {
    throw new Error("Invalid thread metadata set patch")
  }

  // Reject pathological renderer payloads before Object.keys/JSON.stringify can
  // enumerate or serialize an attacker-sized object on Electron's main thread.
  let setFieldCount = 0
  for (const key in patch.set ?? {}) {
    if (!Object.prototype.hasOwnProperty.call(patch.set, key)) continue
    setFieldCount += 1
    if (setFieldCount > RENDERER_METADATA_PATCH_MAX_FIELDS) {
      throw new Error("Thread metadata patch has too many fields")
    }
    if (key.length > RENDERER_METADATA_KEY_MAX_CHARS) {
      throw new Error("Thread metadata key is too long")
    }
  }
  const removeKeys = patch.remove ?? []
  if (removeKeys.length > RENDERER_METADATA_PATCH_MAX_FIELDS) {
    throw new Error("Thread metadata patch has too many fields")
  }
  for (const key of removeKeys) {
    if (typeof key !== "string" || key.length > RENDERER_METADATA_KEY_MAX_CHARS) {
      throw new Error("Invalid thread metadata key")
    }
  }

  validateThreadMetadataPatch(patch, RENDERER_WRITABLE_THREAD_METADATA_KEYS)

  for (const [key, value] of Object.entries(patch.set ?? {})) {
    if (value === undefined) throw new Error(`Invalid thread metadata value for ${key}`)
    switch (key) {
      case "agentMode":
        if (value !== "normal" && value !== "coordinator" && value !== "workflow") {
          throw new Error("Invalid agentMode")
        }
        break
      case "subagentsEnabled":
      case "memoryEnabled":
      case "conciseModeEnabled":
        if (typeof value !== "boolean") throw new Error(`Invalid ${key}`)
        break
      case "outputStyle":
        if (!isAgentOutputStyle(value)) throw new Error("Invalid outputStyle")
        break
      case "model":
        if (
          typeof value !== "string" ||
          value.trim().length === 0 ||
          value.length > RENDERER_MODEL_ID_MAX_BYTES ||
          Buffer.byteLength(value, "utf8") > RENDERER_MODEL_ID_MAX_BYTES
        ) {
          throw new Error("Invalid model")
        }
        break
      case "coordinatorMode":
        // coordinatorMode is a legacy compatibility flag. Current UI only removes it; accepting a
        // new renderer value would create a second, weakly typed mode control channel.
        throw new Error("coordinatorMode can only be removed")
    }
  }

  // At this point every renderer-writable value is a small primitive and both
  // field collections are bounded, so final UTF-8 accounting is itself bounded.
  let serialized: string
  try {
    serialized = JSON.stringify(patch)
  } catch {
    throw new Error("Thread metadata patch must be serializable")
  }
  if (Buffer.byteLength(serialized, "utf8") > RENDERER_METADATA_PATCH_MAX_BYTES) {
    throw new Error("Thread metadata patch is too large")
  }
}

export function applyThreadMetadataPatch(
  current: Record<string, unknown>,
  patch: ThreadMetadataPatch
): Record<string, unknown> {
  validateThreadMetadataPatch(patch)
  const next = { ...current }
  for (const [key, value] of Object.entries(patch.set ?? {})) {
    Object.defineProperty(next, key, {
      configurable: true,
      enumerable: true,
      writable: true,
      value
    })
  }
  for (const key of patch.remove ?? []) delete next[key]
  return next
}

/**
 * Synchronous read-modify-write edge for thread metadata. Callers may do slow work before this
 * function, but the mutation itself always rebases onto the latest database value without yielding.
 */
export function mutateLatestThreadMetadata(
  threadId: string,
  mutator: (latest: Record<string, unknown>) => Record<string, unknown> | void
): { row: ThreadRow; metadata: Record<string, unknown> } {
  const thread = getThreadCore(threadId)
  if (!thread) throw new Error("Thread not found")
  const latest = parseThreadMetadata(thread.metadata)
  const replacement = mutator(latest)
  const metadata = replacement ?? latest
  const row = updateThread(threadId, { metadata: JSON.stringify(metadata) })
  if (!row) throw new Error("Thread not found")
  return { row, metadata }
}

export function patchLatestThreadMetadata(
  threadId: string,
  patch: ThreadMetadataPatch
): { row: ThreadRow; metadata: Record<string, unknown> } {
  validateThreadMetadataPatch(patch)
  return mutateLatestThreadMetadata(threadId, (latest) =>
    applyThreadMetadataPatch(latest, patch)
  )
}
