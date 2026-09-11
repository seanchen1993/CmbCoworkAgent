import {
  readStreamMessageWireMode,
  STREAM_MESSAGE_CONTENT_MODE_KEY
} from "../../shared/stream-message-wire-mode"
import {
  MESSAGE_PROVIDER_OCCURRENCE_METADATA_KEY,
  MESSAGE_PROVIDER_SOURCE_ID_METADATA_KEY
} from "../../shared/message-role-collision"

function record(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined
}

function messageScope(metadata: unknown): string {
  const data = record(metadata)
  return JSON.stringify([
    data?.langgraph_checkpoint_ns ?? data?.checkpoint_ns ?? "",
    data?.cmb_subagent_owner_tool_call_id ?? ""
  ])
}

function providerIdentity(kwargs: Record<string, unknown>) {
  const additional = record(kwargs.additional_kwargs)
  return {
    sourceId:
      additional?.[MESSAGE_PROVIDER_SOURCE_ID_METADATA_KEY] ??
      kwargs.provider_source_id ??
      kwargs.id,
    occurrence:
      additional?.[MESSAGE_PROVIDER_OCCURRENCE_METADATA_KEY] ?? kwargs.provider_occurrence ?? null
  }
}

export function extractStreamAssistantText(content: unknown): string {
  if (typeof content === "string") return content
  if (!Array.isArray(content)) return ""
  return content
    .map((block) => {
      if (typeof block === "string") return block
      const item = record(block)
      return typeof item?.text === "string"
        ? item.text
        : typeof item?.content === "string"
          ? item.content
          : ""
    })
    .join("")
}

interface TextEntry {
  text: string
  truncated: boolean
}

interface IdentityIndex {
  scopedKey: string
  alias: string
}

interface PendingValuesIdentity {
  scope: string
  indexes: IdentityIndex[]
  boundaryEpoch: number
  localOccurrence?: number
}

/** Project message replacements without rebuilding the entire run on each delta.
 * The optional retention limit is for Stop's bounded context. If a prefix was
 * dropped, mark the gap rather than joining later text across unknown content.
 */
export class StreamAssistantText {
  private readonly entries = new Map<string, TextEntry>()
  private readonly boundaries = new Map<string, number>()
  private readonly latestKeyByIdentity = new Map<string, string>()
  private readonly keysByUnscopedIdentity = new Map<string, Map<string, string>>()
  private readonly entryKeyByMessageKey = new Map<string, string>()
  private readonly pendingValuesIdentities = new Map<string, PendingValuesIdentity>()
  private readonly localKeysByIdentity = new Map<string, Map<string, string>>()
  private readonly localOccurrenceByEntry = new Map<string, number>()
  private readonly localCountsBySource = new Map<string, number>()
  private readonly scopeByEntry = new Map<string, string>()
  private nextValuesIdentity = 0
  private boundaryEpoch = 0
  private segment = 0
  private retained = 0
  private cached: string | undefined = ""

  constructor(private readonly maxChars = Number.POSITIVE_INFINITY) {}

  processMessage(payload: unknown): boolean {
    if (!Array.isArray(payload)) return false
    const message = record(payload[0])
    if (!message) return false
    const kwargs = record(message.kwargs) ?? message
    const className = Array.isArray(message.id) ? String(message.id.at(-1) ?? "") : ""
    const metadata = record(payload[1])
    const scope = messageScope(metadata)
    if (!className.includes("AI") && kwargs.type !== "ai" && kwargs.type !== "assistant") {
      this.boundaries.set(scope, ++this.boundaryEpoch)
      return false
    }
    const content = kwargs.content
    if (typeof content !== "string" && !Array.isArray(content)) return false
    const mode =
      readStreamMessageWireMode(metadata?.[STREAM_MESSAGE_CONTENT_MODE_KEY]) ??
      (className.endsWith("Chunk") ? "delta" : "snapshot")
    const text = extractStreamAssistantText(content)
    if (mode === "delta" && text.length === 0) return false
    const identity = providerIdentity(kwargs)
    const messageKey = JSON.stringify([
      this.segment,
      scope,
      this.boundaries.get(scope) ?? 0,
      typeof kwargs.id === "string" ? kwargs.id : "",
      identity.occurrence
    ])
    let key = this.entryKeyByMessageKey.get(messageKey) ?? messageKey
    let localOccurrence: number | undefined
    if (!this.entries.has(key)) {
      const candidates = this.keysByUnscopedIdentity.get(
        JSON.stringify([identity.sourceId, identity.occurrence])
      )
      const candidate = candidates?.size === 1 ? candidates.values().next().value : undefined
      const pending =
        candidate === undefined ? undefined : this.pendingValuesIdentities.get(candidate)
      if (
        candidate !== undefined &&
        pending &&
        (this.boundaries.get(scope) ?? 0) <= pending.boundaryEpoch
      ) {
        // Values can precede all tokens and have no namespace. Claim only this
        // explicit placeholder, never a real root message with an empty scope.
        key = candidate
        localOccurrence = pending.localOccurrence
        this.entryKeyByMessageKey.set(messageKey, key)
        this.pendingValuesIdentities.delete(key)
        for (const { scopedKey, alias } of pending.indexes) {
          this.latestKeyByIdentity.delete(scopedKey)
          const scopes = this.keysByUnscopedIdentity.get(alias)
          scopes?.delete(pending.scope)
          if (scopes?.size === 0) this.keysByUnscopedIdentity.delete(alias)
        }
      }
    }
    this.indexLocalIdentity(kwargs, scope, key, localOccurrence)
    this.indexIdentity(kwargs, scope, key)
    this.write(key, text, mode)
    return true
  }

  private indexIdentity(
    kwargs: Record<string, unknown>,
    scope: string,
    key: string
  ): IdentityIndex[] {
    const identity = providerIdentity(kwargs)
    const indexes: IdentityIndex[] = []
    for (const id of [kwargs.id, identity.sourceId]) {
      if (typeof id !== "string") continue
      for (const occurrence of [identity.occurrence, null]) {
        const scopedKey = JSON.stringify([scope, id, occurrence])
        this.latestKeyByIdentity.set(scopedKey, key)
        // Values can omit scope/occurrence. Index the unique candidate rather
        // than scanning the run's aliases every time a values frame arrives.
        const alias = JSON.stringify([id, occurrence])
        let scopes = this.keysByUnscopedIdentity.get(alias)
        if (!scopes) {
          scopes = new Map()
          this.keysByUnscopedIdentity.set(alias, scopes)
        }
        scopes.set(scope, key)
        indexes.push({ scopedKey, alias })
      }
    }
    return indexes
  }

  private indexLocalIdentity(
    kwargs: Record<string, unknown>,
    scope: string,
    key: string,
    declaredLocalOccurrence?: number
  ): void {
    if (this.localOccurrenceByEntry.has(key)) return
    const identity = providerIdentity(kwargs)
    const source = JSON.stringify([scope, identity.sourceId])
    const occurrence = declaredLocalOccurrence ?? (this.localCountsBySource.get(source) ?? 0) + 1
    this.localCountsBySource.set(
      source,
      Math.max(this.localCountsBySource.get(source) ?? 0, occurrence)
    )
    this.localOccurrenceByEntry.set(key, occurrence)
    this.scopeByEntry.set(key, scope)
    // This is only a current-segment lookup ordinal. It is never written as a
    // global provider occurrence, which may start after an older user's turn.
    for (const id of [kwargs.id, identity.sourceId]) {
      if (typeof id !== "string") continue
      const alias = JSON.stringify([id, occurrence])
      let scopes = this.localKeysByIdentity.get(alias)
      if (!scopes) {
        scopes = new Map()
        this.localKeysByIdentity.set(alias, scopes)
      }
      scopes.set(scope, key)
    }
  }

  /** Values carry complete messages, without the token stream's scope metadata. */
  applySnapshot(value: unknown, metadata?: unknown, localOccurrence?: number): void {
    const message = record(value)
    if (!message) return
    const kwargs = record(message.kwargs) ?? message
    const content = kwargs.content
    if (typeof content !== "string" && !Array.isArray(content)) return
    const identity = providerIdentity(kwargs)
    let key = this.latestKeyByIdentity.get(
      JSON.stringify([messageScope(metadata), identity.sourceId, identity.occurrence])
    )
    if (key === undefined && metadata === undefined) {
      // Root values omit the producing node's namespace. Only a unique identity
      // can be safely rebased; never guess the last of two different subgraphs.
      const candidates = this.keysByUnscopedIdentity.get(
        JSON.stringify([identity.sourceId, identity.occurrence])
      )
      if (candidates && candidates.size > 1) return
      if (candidates?.size === 1) key = candidates.values().next().value
    }
    if (key === undefined && localOccurrence !== undefined) {
      const candidates = this.localKeysByIdentity.get(
        JSON.stringify([identity.sourceId, localOccurrence])
      )
      key = candidates?.get(messageScope(metadata))
      if (key === undefined && metadata === undefined && candidates && candidates.size > 1) return
      if (key === undefined && metadata === undefined && candidates?.size === 1) {
        key = candidates.values().next().value
      }
      if (key !== undefined) {
        // Adopt the normalized tuple as an alias for the already observed local
        // cycle, without changing its position or pretending its ordinal is global.
        this.indexIdentity(kwargs, this.scopeByEntry.get(key)!, key)
      }
    }
    if (key !== undefined) this.write(key, extractStreamAssistantText(content), "snapshot")
    else if (metadata === undefined) {
      // Keep unknown namespace separate from the real empty/root namespace.
      // Retaining this entry's key when claimed also preserves message order.
      const placeholder = `values:${this.segment}:${this.nextValuesIdentity++}`
      const indexes = this.indexIdentity(kwargs, placeholder, placeholder)
      this.pendingValuesIdentities.set(placeholder, {
        scope: placeholder,
        indexes,
        boundaryEpoch: this.boundaryEpoch,
        localOccurrence
      })
      this.write(placeholder, extractStreamAssistantText(content), "snapshot")
    } else
      this.processMessage([
        message,
        {
          ...record(metadata),
          [STREAM_MESSAGE_CONTENT_MODE_KEY]: "snapshot"
        }
      ])
  }

  private write(key: string, text: string, mode: "delta" | "snapshot"): void {
    const entry = this.entries.get(key) ?? { text: "", truncated: false }
    if (mode === "snapshot") {
      this.retained -= entry.text.length
      entry.text = ""
      entry.truncated = false
    }
    if (!entry.truncated) {
      const retained = text.slice(0, Math.max(0, this.maxChars - this.retained))
      entry.text += retained
      this.retained += retained.length
      entry.truncated = retained.length < text.length
    }
    this.entries.set(key, entry)
    this.cached = undefined
  }

  /** A new Goal subturn may reuse provider IDs but still belongs in the run log. */
  beginSegment(): void {
    this.segment += 1
    this.boundaryEpoch = 0
    this.boundaries.clear()
    this.latestKeyByIdentity.clear()
    this.keysByUnscopedIdentity.clear()
    this.entryKeyByMessageKey.clear()
    this.pendingValuesIdentities.clear()
    this.localKeysByIdentity.clear()
    this.localOccurrenceByEntry.clear()
    this.localCountsBySource.clear()
    this.scopeByEntry.clear()
  }

  reset(): void {
    this.entries.clear()
    this.boundaries.clear()
    this.latestKeyByIdentity.clear()
    this.keysByUnscopedIdentity.clear()
    this.entryKeyByMessageKey.clear()
    this.pendingValuesIdentities.clear()
    this.localKeysByIdentity.clear()
    this.localOccurrenceByEntry.clear()
    this.localCountsBySource.clear()
    this.scopeByEntry.clear()
    this.nextValuesIdentity = 0
    this.boundaryEpoch = 0
    this.segment = 0
    this.retained = 0
    this.cached = ""
  }

  get retainedCharacters(): number {
    return this.retained
  }

  get text(): string {
    if (this.cached !== undefined) return this.cached
    const parts: string[] = []
    for (const entry of this.entries.values()) {
      parts.push(entry.text)
      if (entry.truncated) {
        parts.push("\n...(truncated)")
        break
      }
    }
    return (this.cached = parts.join(""))
  }
}
