import type { ModJson, ModObject } from "../types"

export const MODS_V2_API = "cmb.mods/v2" as const
export const CLAUDE_MODS_PROFILE = "claude-code/2.1.278" as const
/** Bump when expanding host authority so an old digest grant cannot silently gain capabilities. */
export const FUNCTION_HOST_REVISION = "claude-295-tools-v91" as const
export const MOD_TIERS = ["prepend", "user", "append", "builtin", "core"] as const
export type ModTier = (typeof MOD_TIERS)[number]

export interface ModOrigin {
  readonly plugin: string
  readonly tier: ModTier
}

export interface FunctionRegistration {
  id: string
  pattern: string
  hasCatch: boolean
  /** Missing metadata retains remote matching for older runtime peers. */
  hasMatcher?: boolean
  /** Synchronous registration metadata. Discovery never invokes a hook or matcher. */
  platformCapability?: import("./platform-capabilities").PlatformCapabilityDescriptor
}

export interface ModTraceEntry {
  index: number
  plugin: string
  tier: ModTier
  event: string
  outcome: "returned" | "skipped" | "kept" | "caught" | "rejected" | "expired"
  ms: number
  received: ModObject
  returned?: ModJson
  reason?: string
  chunks?: number
}

export interface FunctionInvocation {
  /** Native frame admission handshake; not an SDK method or guest-controlled permission. */
  admission?: boolean
  event: string
  origin: ModOrigin
  capabilities: string[]
  plugin: { name: string; root: string }
  /** Host-captured protocol; never inferred from a guest's call arguments. */
  modelProtocol?: "legacy-v1" | "result-v1"
  caught?: { message?: string; called: boolean; kind?: "throw" | "timeout"; budget?: number }
  signal?: AbortSignal
  timeoutMs?: number
  /** Native own-time meter, independent of the absolute timeout. Zero is unmetered. */
  ownBudgetMs?: number
  /** Native shared wall cut; host-captured, omitted from the guest metadata and public SDK. */
  dispatchCutNs?: string
  streaming?: boolean
  operation?: boolean
  uiGeneration?: string
  /** Session-owned engine noun method handle, never chosen by a calling plugin. */
  provider?: string
  /** Host-owned callback handle invoked under a fresh module authority frame. */
  resourceCallback?: { handle: number; release: boolean }
  /** Native cleanup frame; never supplied by an SDK payload or an author descriptor. */
  platformCleanup?: boolean
  /** Native view initialization cannot invoke external effects or ordinary business actions. */
  platformUiOpen?: boolean
  /** Private per-pull generator protocol, never derived from an event payload. */
  streamCursor?: { action: "open" | "next" | "return"; id?: number }
  callback?: {
    handle: number
    generation: string
    kind: "onPress" | "onInput" | "onSubmit" | "onSelect" | "onLinkPress"
  }
}

/** Old private invocations retain their original absolute timeout unless explicitly opted in. */
export function functionInvocationTimeoutMs(
  options: Pick<FunctionInvocation, "timeoutMs" | "ownBudgetMs">
): number {
  return Math.min(
    Math.max(options.timeoutMs ?? (options.ownBudgetMs === undefined ? 5000 : 120000), 1),
    120000
  )
}

export interface FunctionHostReply {
  value?: ModJson
  trace?: ModTraceEntry[]
}

export type FunctionHostCall = (
  method: string,
  args: ModJson,
  signal: AbortSignal,
  /** Captured by native module transport only; never accepted from SDK argument JSON. */
  context?: { dispatchCutNs: string }
) => Promise<FunctionHostReply>

/** Both the isolated production proxy and the in-process test VM implement this contract. */
export interface FunctionGuest {
  readonly registrations: readonly FunctionRegistration[]
  /** Native VM proof captured after registration; missing peers cannot be auto reclaimed. */
  readonly registrationQuiescent?: boolean
  readonly stats: { disposed: boolean }
  /** One module-lifetime resource channel. It never extends an invocation's SDK authority. */
  bindModuleHost?(host: FunctionHostCall, onDispose?: () => void): void
  releaseResource?(handle: number): void | Promise<void>
  releaseStreamCursor?(handle: number): void | Promise<void>
  matches(id: string, event: ModObject): boolean | Promise<boolean>
  invoke(
    id: string,
    event: ModObject,
    host: FunctionHostCall,
    options: FunctionInvocation
  ): Promise<{ value?: ModJson; absent?: boolean }>
  dispose(): void | Promise<void>
  releaseUi(generation: string): void | Promise<void>
}

/** The host distinguishes downstream rejection from a failing optional hook. */
export class ModFunctionError extends Error {
  constructor(
    readonly code: string,
    message = code,
    readonly downstream = false
  ) {
    super(message)
    this.name = "ModFunctionError"
  }
}

export function isModObject(value: unknown): value is ModObject {
  return value !== null && typeof value === "object" && !Array.isArray(value)
}

export function isModJson(value: unknown): value is ModJson {
  if (value === null || typeof value === "string" || typeof value === "boolean") return true
  if (typeof value === "number") return Number.isFinite(value)
  if (Array.isArray(value)) return value.every((entry) => isModJson(entry))
  if (!isModObject(value)) return false
  return Object.values(value).every((entry) => isModJson(entry))
}

/** No regular expressions execute on the host while matching plugin event patterns. */
export function matchesEventPattern(pattern: string, event: string): boolean {
  const negative = pattern.startsWith("!")
  const positive = negative ? pattern.slice(1) : pattern
  const matches =
    positive === "*" ||
    positive === event ||
    (positive.endsWith(".*") && event.startsWith(positive.slice(0, -1)))
  return negative ? !matches : matches
}

export function validEventPattern(pattern: string): boolean {
  return pattern.length <= 160 && /^(?:\*|!?[a-z][\w-]*(?:\.[\w-]+)*(?:\.\*)?)$/.test(pattern)
}
