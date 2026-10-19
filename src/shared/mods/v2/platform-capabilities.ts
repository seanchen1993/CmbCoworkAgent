import type { ModJson, ModObject } from "../types"

export const PLATFORM_CAPABILITY_API = "devclaw.capability/v1" as const
export const PLATFORM_VIEW_OPEN_METHODS: readonly string[] = [
  "platform.list",
  "platform.read",
  "platform.subscribe",
  "platform.poll",
  "platform.unsubscribe",
  "platform.publish",
  "state.get",
  "state.set",
  "store.get",
  "store.keys",
  "store.set",
  "store.delete",
  "session.id",
  "clock.after",
  "clock.every",
  "ui.open",
  "ui.invalidate"
]
export const PLATFORM_VIEW_CLEANUP_METHODS: readonly string[] = [
  "platform.unsubscribe",
  "state.get",
  "state.set",
  "store.get",
  "store.set",
  "store.delete",
  "session.id"
]
export interface PlatformCapabilityRef {
  provider: string
  id: string
  /** Exact semantic protocol version. An update never silently selects another version. */
  version: string
}
export interface PlatformCapabilityAction {
  id: string
  title: string
  inputSchema: ModObject
  outputSchema: ModObject
  requiredPermissions: string[]
  cancellable: boolean
  idempotency: "keyed"
}
export interface PlatformCapabilityDescriptor {
  apiVersion: typeof PLATFORM_CAPABILITY_API
  id: string
  version: string
  title: string
  scope: "conversation" | "workspace"
  stateSchema: ModObject
  actions: PlatformCapabilityAction[]
  /** Bounded declarative data; each consuming native extension validates its own schema. */
  presentation?: ModObject
}
export interface PlatformCapabilitySource {
  provider: string
  digest: string
  generation: string
}
export interface PlatformCapabilityInfo {
  ref: PlatformCapabilityRef
  descriptor: PlatformCapabilityDescriptor
  source: PlatformCapabilitySource
  available: boolean
  reason?: string
}
/** An intention only. The host binds workspace, physical thread and incarnation. */
export interface PlatformCurrentTarget {
  kind: "current"
}
export interface PlatformCapabilityQuery {
  ref: PlatformCapabilityRef
  target: PlatformCurrentTarget
}
export interface PlatformCapabilityState {
  status: "ready" | "unknown"
  revision: number
  source: PlatformCapabilitySource
  value?: ModJson
  reason?: string
}
export interface PlatformCapabilityEvent {
  revision: number
  value: ModJson
  source: PlatformCapabilitySource
}
export interface PlatformCapabilityPoll {
  subscriptionId: string
  revision: number
  events: PlatformCapabilityEvent[]
  /** Buffer overflow, a revision gap or a reconnect requires an authoritative read. */
  resync: boolean
}
export interface PlatformCapabilityActionInput extends PlatformCapabilityQuery {
  action: string
  input: ModObject
  requestKey: string
}
export interface PlatformCapabilityActionResult {
  requestKey: string
  status: "running" | "succeeded" | "failed" | "cancelled" | "unknown"
  value?: ModJson
  error?: string
}
export interface PlatformCapabilityDiagnostics {
  providers: number
  subscriptions: number
  inFlight: number
  unknownRequests: number
  completedRequests: number
  failedRequests: number
  cancelledRequests: number
}
export interface PlatformCapabilitySdk {
  list(): Promise<{ status: "ready" | "unknown"; capabilities: PlatformCapabilityInfo[] }>
  read(query: PlatformCapabilityQuery): Promise<PlatformCapabilityState>
  subscribe(query: PlatformCapabilityQuery): Promise<{ subscriptionId: string; revision: number }>
  poll(input: { subscriptionId: string; afterRevision: number }): Promise<PlatformCapabilityPoll>
  unsubscribe(input: { subscriptionId: string }): Promise<void>
  publish(input: {
    id: string
    version: string
    target: PlatformCurrentTarget
    value: ModJson
    expectedRevision?: number
  }): Promise<PlatformCapabilityState>
  act(
    input: PlatformCapabilityActionInput,
    options?: { signal?: AbortSignal }
  ): Promise<PlatformCapabilityActionResult>
  cancel(
    input: PlatformCapabilityQuery & { requestKey: string }
  ): Promise<PlatformCapabilityActionResult>
  status(
    input: PlatformCapabilityQuery & { requestKey: string }
  ): Promise<PlatformCapabilityActionResult>
}
