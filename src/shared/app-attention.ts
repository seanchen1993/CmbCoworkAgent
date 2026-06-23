export const APP_ATTENTION_CHANNEL = "app:request-attention"

export type AppAttentionKind =
  | "approval"
  | "user-input"
  | "task-complete"
  | "task-error"
  | "interaction"

export interface AppAttentionPayload {
  action?: "raise" | "resolve"
  kind: AppAttentionKind
  threadId?: string
  key?: string
}

const ATTENTION_KINDS = new Set<AppAttentionKind>([
  "approval",
  "user-input",
  "task-complete",
  "task-error",
  "interaction"
])

export function isAppAttentionPayload(value: unknown): value is AppAttentionPayload {
  if (!value || typeof value !== "object") return false
  const candidate = value as {
    action?: unknown
    kind?: unknown
    threadId?: unknown
    key?: unknown
  }
  return (
    (candidate.action === undefined ||
      candidate.action === "raise" ||
      candidate.action === "resolve") &&
    typeof candidate.kind === "string" &&
    ATTENTION_KINDS.has(candidate.kind as AppAttentionKind) &&
    (candidate.threadId === undefined ||
      (typeof candidate.threadId === "string" && candidate.threadId.length <= 256)) &&
    (candidate.key === undefined ||
      (typeof candidate.key === "string" &&
        candidate.key.length > 0 &&
        candidate.key.length <= 512)) &&
    (candidate.action !== "resolve" || typeof candidate.key === "string")
  )
}

export function getAppAttentionPriority(kind: AppAttentionKind): number {
  switch (kind) {
    case "approval":
      return 50
    case "user-input":
      return 40
    case "task-error":
      return 30
    case "interaction":
      return 20
    case "task-complete":
      return 10
  }
}

export function isPersistentAppAttention(kind: AppAttentionKind): boolean {
  return kind === "approval" || kind === "user-input"
}

export function isRendererAppAttentionPayload(value: unknown): value is AppAttentionPayload {
  return (
    isAppAttentionPayload(value) &&
    value.action !== "resolve" &&
    value.key === undefined &&
    !isPersistentAppAttention(value.kind)
  )
}

interface StoredAppAttention {
  payload: AppAttentionPayload
  sequence: number
}

export class AppAttentionStore {
  private readonly entries = new Map<string, StoredAppAttention>()
  private sequence = 0

  raise(payload: AppAttentionPayload): void {
    const sequence = ++this.sequence
    const key = payload.key?.trim() || `transient:${sequence}`
    if (!isPersistentAppAttention(payload.kind)) {
      for (const [existingKey, entry] of this.entries) {
        if (!isPersistentAppAttention(entry.payload.kind) && entry.payload.kind === payload.kind) {
          this.entries.delete(existingKey)
        }
      }
    }
    this.entries.set(key, {
      payload: { ...payload, action: "raise", key },
      sequence
    })
  }

  resolve(key: string): void {
    this.entries.delete(key)
  }

  acknowledgeVisible(): void {
    for (const [key, entry] of this.entries) {
      if (!isPersistentAppAttention(entry.payload.kind)) {
        this.entries.delete(key)
      }
    }
  }

  highestPriority(): AppAttentionPayload | null {
    let selected: StoredAppAttention | null = null
    for (const entry of this.entries.values()) {
      if (
        !selected ||
        getAppAttentionPriority(entry.payload.kind) >
          getAppAttentionPriority(selected.payload.kind) ||
        (getAppAttentionPriority(entry.payload.kind) ===
          getAppAttentionPriority(selected.payload.kind) &&
          entry.sequence > selected.sequence)
      ) {
        selected = entry
      }
    }
    return selected?.payload ?? null
  }

  clear(): void {
    this.entries.clear()
  }
}

export function getAgentStreamAttentionKind(value: unknown): AppAttentionKind | null {
  if (!value || typeof value !== "object") return null
  const event = value as { type?: unknown }
  if (event.type === "error") return "task-error"
  return null
}
