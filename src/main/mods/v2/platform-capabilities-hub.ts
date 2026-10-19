import { createHash, randomUUID } from "node:crypto"
import type { ModJson } from "../../../shared/mods/types"
import type {
  PlatformCapabilitySource,
  PlatformCapabilityState,
  PlatformCapabilityPoll
} from "../../../shared/mods/v2/platform-capabilities"
import { platformCopy, platformError, platformRevision } from "./platform-capabilities-validation"

export interface PlatformCapabilityPersistence {
  get(namespace: string, key: string): ModJson | undefined
  set(namespace: string, key: string, value: ModJson): void
  keys(namespace: string): string[]
}
interface Subscription {
  owner: object
  key: string
  events: Array<{ revision: number; value: ModJson; source: PlatformCapabilitySource }>
  bytes: number
  dropped: number
  revision: number
}
/** One manager-owned broker, including workspace notifications across current sessions. */
export class PlatformCapabilityHub {
  private readonly subscriptions = new Map<string, Subscription>()
  private readonly live = new Map<string, Map<object, () => void>>()
  constructor(private readonly store: PlatformCapabilityPersistence) {}

  private sourceKey(source: PlatformCapabilitySource): string {
    return JSON.stringify([source.provider, source.digest, source.generation])
  }
  addSource(owner: object, source: PlatformCapabilitySource, assertCurrent = () => {}): void {
    const key = this.sourceKey(source),
      owners = this.live.get(key) ?? new Map<object, () => void>()
    owners.set(owner, assertCurrent)
    this.live.set(key, owners)
  }
  private sourceActive(source: PlatformCapabilitySource): boolean {
    for (const check of this.live.get(this.sourceKey(source))?.values() ?? []) {
      try {
        check()
        return true
      } catch {
        /* A native source fact can only lose authority. */
      }
    }
    return false
  }
  closeOwner(owner: object): void {
    for (const [key, sources] of this.live) {
      sources.delete(owner)
      if (!sources.size) this.live.delete(key)
    }
    for (const [id, row] of this.subscriptions)
      if (row.owner === owner) this.subscriptions.delete(id)
  }
  close(): void {
    this.live.clear()
    this.subscriptions.clear()
  }
  namespace(workspace: string, threadId: string, incarnation: string): string {
    return JSON.stringify(["native.platform/v1", workspace, threadId, incarnation])
  }
  stateKey(scope: string): string {
    return "state:" + createHash("sha256").update(scope).digest("hex")
  }
  read(
    namespace: string,
    scope: string,
    source: PlatformCapabilitySource
  ): PlatformCapabilityState {
    const saved = this.store.get(namespace, this.stateKey(scope))
    if (!saved) return { status: "unknown", revision: 0, source, reason: "not-published" }
    if (
      !saved ||
      typeof saved !== "object" ||
      Array.isArray(saved) ||
      typeof saved.revision !== "number" ||
      !saved.source ||
      typeof saved.source !== "object" ||
      Array.isArray(saved.source) ||
      typeof saved.source.provider !== "string" ||
      typeof saved.source.digest !== "string" ||
      typeof saved.source.generation !== "string" ||
      [saved.source.provider, saved.source.digest, saved.source.generation].some(
        (value) => value.length > 200
      ) ||
      saved.value === undefined
    )
      platformError("MODS_PLATFORM_STATE_CORRUPT")
    const revision = platformRevision(saved.revision)
    const observed = saved.source as unknown as PlatformCapabilitySource
    if (
      observed.provider !== source.provider ||
      observed.digest !== source.digest ||
      !this.sourceActive(observed)
    )
      return { status: "unknown", revision, source: observed, reason: "source-inactive" }
    return platformCopy({ status: "ready", revision, source: observed, value: saved.value })
  }
  save(namespace: string, key: string, value: ModJson): void {
    if (Buffer.byteLength(JSON.stringify(value)) > 64000)
      platformError("MODS_PLATFORM_RECORD_LIMIT")
    if (this.store.get(namespace, key) === undefined && this.store.keys(namespace).length >= 256)
      platformError("MODS_PLATFORM_RECORD_LIMIT")
    this.store.set(namespace, key, platformCopy(value))
  }
  record(namespace: string, key: string): ModJson | undefined {
    return this.store.get(namespace, key)
  }
  publish(
    namespace: string,
    scope: string,
    source: PlatformCapabilitySource,
    value: ModJson,
    expectedRevision?: number
  ): PlatformCapabilityState {
    if (Buffer.byteLength(JSON.stringify(value)) > 16000) platformError("MODS_PLATFORM_STATE_LIMIT")
    const previous = this.read(namespace, scope, source)
    if (expectedRevision !== undefined && platformRevision(expectedRevision) !== previous.revision)
      platformError("MODS_PLATFORM_STATE_CHANGED")
    if (
      previous.status === "ready" &&
      JSON.stringify(previous.value) === JSON.stringify(value) &&
      this.sourceKey(previous.source) === this.sourceKey(source)
    )
      return previous
    const revision = previous.revision + 1
    if (!Number.isSafeInteger(revision)) platformError("MODS_PLATFORM_REVISION")
    const state: PlatformCapabilityState = {
      status: "ready",
      revision,
      source,
      value: platformCopy(value)
    }
    this.save(namespace, this.stateKey(scope), state as unknown as ModJson)
    const key = JSON.stringify([namespace, scope])
    for (const row of this.subscriptions.values())
      if (row.key === key) {
        const event = { revision, value: state.value!, source }
        row.events.push(event)
        row.bytes += Buffer.byteLength(JSON.stringify(event))
        row.revision = revision
        while (row.events.length > 32 || row.bytes > 64000) {
          const removed = row.events.shift()!
          row.bytes -= Buffer.byteLength(JSON.stringify(removed))
          row.dropped = removed.revision
        }
      }
    return platformCopy(state)
  }
  subscribe(owner: object, namespace: string, scope: string, state: PlatformCapabilityState) {
    if (
      this.subscriptions.size >= 128 ||
      [...this.subscriptions.values()].filter((row) => row.owner === owner).length >= 16
    )
      platformError("MODS_PLATFORM_SUBSCRIPTION_LIMIT")
    const subscriptionId = randomUUID()
    const events =
      state.status === "ready"
        ? [{ revision: state.revision, value: state.value!, source: state.source }]
        : []
    this.subscriptions.set(subscriptionId, {
      owner,
      key: JSON.stringify([namespace, scope]),
      events,
      bytes: events.reduce((sum, event) => sum + Buffer.byteLength(JSON.stringify(event)), 0),
      dropped: 0,
      revision: state.revision
    })
    return { subscriptionId, revision: state.revision }
  }
  poll(owner: object, id: string, after: number): PlatformCapabilityPoll {
    const row = this.subscriptions.get(id)
    if (!row || row.owner !== owner) platformError("MODS_PLATFORM_SUBSCRIPTION_EXPIRED")
    platformRevision(after)
    const active = new Map<string, boolean>()
    const resync =
      after < row.dropped ||
      after > row.revision ||
      row.events.some((event) => {
        if (event.revision <= after) return false
        const key = this.sourceKey(event.source)
        if (!active.has(key)) active.set(key, this.sourceActive(event.source))
        return !active.get(key)
      }) ||
      (row.events.length > 0 && after < row.events[0].revision - 1)
    const events = resync ? [] : row.events.filter((event) => event.revision > after)
    return platformCopy({ subscriptionId: id, revision: row.revision, events, resync })
  }
  unsubscribe(owner: object, id: string): void {
    const row = this.subscriptions.get(id)
    if (row && row.owner !== owner) platformError("MODS_PLATFORM_SUBSCRIPTION_OWNER")
    this.subscriptions.delete(id)
  }
  count(owner: object): number {
    return [...this.subscriptions.values()].filter((row) => row.owner === owner).length
  }
}
