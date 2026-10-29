/**
 * Review contract for cmb.mods/v1, 2026-09-16.
 * This file is a design artifact, not an installed SDK or production implementation.
 * Every value crossing the guest boundary also requires a host-owned runtime schema.
 */

export type Json = null | boolean | number | string | Json[] | JsonObject
export type JsonObject = { [key: string]: Json }

declare const brand: unique symbol
export type Opaque<Kind extends string> = string & { readonly [brand]: Kind }
export type ResultReceipt = Opaque<"result-receipt">
export type ArtifactRef = Opaque<"approved-artifact">

export type ToolEffect = "read" | "write" | "unknown"
export type ExecutionStatus =
  | "not_started"
  | "running"
  | "succeeded"
  | "failed"
  | "cancel_requested"
  | "cancelled"
  | "unknown"

export interface CallIdentity {
  readonly callId: string
  readonly parentCallId?: string
  readonly threadId: string
  readonly threadBranchId: string
  readonly turnId: string
  readonly agentId: string
  readonly workspaceId: string
  readonly origin:
    | { readonly kind: "model" }
    | { readonly kind: "mod"; readonly modId: string }
    | { readonly kind: "user-action"; readonly modId: string }
  readonly grantEpoch: number
  readonly policyEpoch: number
}

export interface ToolDescriptor {
  readonly id: string
  readonly providerId: string
  readonly effect: ToolEffect
}

/** Guest-native signal proxy. No host AbortSignal object crosses the boundary. */
export interface Cancellation {
  readonly aborted: boolean
  readonly reason?: "cancelled" | "deadline" | "revoked" | "unloaded"
  onAbort(listener: () => void): () => void
}

export interface Next<Input, Output> {
  (input: Input): Promise<Output>
  readonly signal: Cancellation
}

/** All text, data and artifacts are subject to final publication policy. */
export interface Projection {
  readonly text: string
  readonly data?: Json
  readonly artifacts?: readonly ArtifactRef[]
}

export interface ToolEvent {
  readonly identity: CallIdentity
  readonly tool: ToolDescriptor
  readonly args: JsonObject
}

/** The host verifies receipt ownership and keeps status outside guest control. */
export interface ToolResultView {
  readonly receipt: ResultReceipt
  readonly execution: ExecutionStatus
  readonly publication: "available" | "suppressed"
  readonly projection: Projection
}

export type ToolReply =
  | {
      readonly kind: "result"
      readonly receipt: ResultReceipt
      readonly projection: Projection
    }
  | { readonly kind: "deny"; readonly reason: string }

export interface ContextBlock {
  readonly text: string
  readonly source: string
}

export interface ContextEvent {
  readonly identity: CallIdentity
  readonly blocks: readonly ContextBlock[]
}

export interface CommandEvent {
  readonly identity: CallIdentity
  readonly command: string
  readonly args: JsonObject
}

export interface UiEvent {
  readonly identity: CallIdentity
  readonly slot: "tool.result.after" | "turn.summary"
  readonly model: JsonObject
  readonly nodes: readonly UiNode[]
}

export type UiNode =
  | { readonly type: "text" | "code" | "badge"; readonly text: string }
  | { readonly type: "card"; readonly title: string; readonly children: readonly UiNode[] }
  | {
      readonly type: "table"
      readonly columns: readonly string[]
      readonly rows: readonly (readonly string[])[]
    }
  | {
      readonly type: "button"
      readonly label: string
      readonly command: string
      readonly args: JsonObject
    }
  | { readonly type: "artifact-link"; readonly label: string; readonly artifact: ArtifactRef }

/** Tools are always dispatched by the host; allowed targets depend on the event. */
export interface Capabilities {
  readonly tools: {
    invoke(toolId: string, args: JsonObject): Promise<ToolResultView>
  }
  readonly context: {
    get(field: "project.name" | "project.conventions" | "thread.mode"): Promise<Json>
  }
  readonly store: {
    get(key: string): Promise<Json | null>
    set(key: string, value: Json): Promise<void>
    delete(key: string): Promise<void>
  }
  readonly log: {
    write(level: "info" | "warn" | "error", code: string, fields?: JsonObject): void
  }
}

export interface HookOptions {
  readonly id: string
  readonly before?: readonly string[]
  readonly after?: readonly string[]
}

export type ToolHandler = (
  capabilities: Capabilities,
  event: ToolEvent,
  next: Next<{ readonly args: JsonObject }, ToolResultView>
) => Promise<ToolReply>

export type ContextHandler = (
  capabilities: Capabilities,
  event: ContextEvent,
  next: Next<ContextEvent, readonly ContextBlock[]>
) => Promise<readonly ContextBlock[]>

export type CommandHandler = (
  capabilities: Capabilities,
  event: CommandEvent,
  next: Next<CommandEvent, Projection>
) => Promise<Projection>

/** Rendering has no I/O capabilities. Action binding is performed by the host. */
export type UiHandler = (
  event: UiEvent,
  next: Next<UiEvent, readonly UiNode[]>
) => Promise<readonly UiNode[]>

export interface Registrar {
  tool(options: HookOptions & { readonly toolIds: readonly string[] }, handler: ToolHandler): void
  context(options: HookOptions, handler: ContextHandler): void
  command(options: HookOptions & { readonly command: string }, handler: CommandHandler): void
  ui(options: HookOptions & { readonly slot: UiEvent["slot"] }, handler: UiHandler): void
}

/** Registration cannot call host capabilities; commands must belong to this Mod. */
export interface ModModule {
  register(on: Registrar): void
  dispose?(): void
}

/**
 * Host-managed policy ABI, NOT part of the ordinary Mod registration interface.
 * Installation requires separate trusted provenance. Both operations are pure.
 * These input copies exist only in the isolated policy runtime.
 */
export interface ManagedPolicy {
  admit(input: {
    readonly identity: CallIdentity
    readonly tool: ToolDescriptor
    readonly finalArgs: JsonObject
  }): Promise<{ readonly allow: true } | { readonly allow: false; readonly code: string }>

  filter(input: {
    readonly publicationId: string
    readonly stage: "before-observers" | "final"
    readonly content: Projection
    readonly fields: JsonObject
  }): Promise<
    | {
        readonly allow: true
        readonly content: Projection
        readonly fields: JsonObject
        readonly ruleIds: readonly string[]
      }
    | { readonly allow: false; readonly code: string }
  >
}

/** This recipe illustrates result editing, without replacing execution facts. */
export const resultAnnotationExample: ModModule = {
  register(on) {
    on.tool({ id: "annotate", toolIds: ["host:read_file"] }, async (_$, event, next) => {
      const result = await next({ args: event.args })
      return {
        kind: "result",
        receipt: result.receipt,
        projection: {
          ...result.projection,
          text: `${result.projection.text}\n[Project guidance applied]`
        }
      }
    })
  }
}
