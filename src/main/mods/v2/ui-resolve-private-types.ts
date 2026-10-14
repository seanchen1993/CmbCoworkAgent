import type { QuickJSContext, QuickJSHandle, QuickJSRuntime } from "quickjs-emscripten"
import type { FunctionUiSite } from "../../../shared/mods/v2/sites"

/** Utility/main host objects only. These are never ModJSON or guest-selected identifiers. */
export interface FunctionUiResolveAssembly {
  readonly hostIdentity: object
  readonly signal: AbortSignal
}
export interface FunctionUiResolvePeer {
  readonly assembly: FunctionUiResolveAssembly
  readonly actor: object
  readonly runtime: QuickJSRuntime
  readonly context: QuickJSContext
  assertCurrent(): void
}
export type FunctionUiResolveComponent = "Pane" | FunctionUiSite
export interface FunctionUiResolveTarget {
  readonly assembly: FunctionUiResolveAssembly
  readonly consumer: FunctionUiResolvePeer
  readonly component: FunctionUiResolveComponent
}
export interface FunctionUiResolveDefinition {
  readonly peer: FunctionUiResolvePeer
  readonly registration: object
  assertCurrent(): void
}
export interface FunctionUiResolveReceipt {
  readonly consumer: FunctionUiResolvePeer
  readonly component: FunctionUiResolveComponent
  readonly identity: object
  readonly signal: AbortSignal
  assertCurrent(): void
}
export interface FunctionUiResolveSyncBudget {
  readonly expiresAt: number
  readonly depth: number
  assertRemaining(): void
}
export interface FunctionUiResolveCall {
  readonly constructorName:
    | "Box"
    | "Text"
    | "Button"
    | "Input"
    | "Select"
    | "Link"
    | "Code"
    | "Svg"
    | "Markdown"
    | "Client"
  readonly definition: FunctionUiResolveDefinition
  readonly target: FunctionUiResolveTarget
  readonly resident: FunctionUiResolvePeer
  readonly receipt: FunctionUiResolveReceipt
  readonly budget: FunctionUiResolveSyncBudget
}
export interface FunctionUiResolvePropsProof {
  readonly peer: FunctionUiResolvePeer
  readonly rootKey: string | undefined
  /** Borrowed handles, valid only until the synchronous root call finishes. */
  readonly children: QuickJSHandle | undefined
  readonly actions: object
  callback(name: string): QuickJSHandle | undefined
  assertCurrent(): void
}
export interface FunctionUiResolveHostReceipt {
  readonly consumer: FunctionUiResolvePeer
  readonly component: FunctionUiResolveComponent
  readonly identity: object
  readonly signal: AbortSignal
  assertCurrent(): void
}
export interface FunctionUiResolveConstructorScope {
  /** Lifecycle only. A normal-return held SDK branch must not inherit the 50ms CPU cut. */
  assertCurrent(): void
  /**
   * Restore the actual peer CPU/SDK context afterwards; never pump unrelated guest jobs.
   * Data/reconnect suppress effects on ALL ordinary, module and constructor SDK routes. A caught
   * denial is sticky; a nested constructor cannot upgrade a data ancestor. Only constructor
   * admits SDK under call.definition's actual ui.resolve registration, never Q's ui.render.
   */
  runSync<T>(
    call: FunctionUiResolveCall,
    peer: FunctionUiResolvePeer,
    budget: FunctionUiResolveSyncBudget,
    phase: "constructor" | "data" | "reconnect",
    run: () => T
  ): T
  /** Release only synchronous root work; admitted SDK work remains until real settlement. */
  finishNormal(): void
  /** Fence new effects without pretending already entered host work has settled. */
  finishFailure(error: unknown): void
}
export interface FunctionUiResolveDriver {
  /** Invoked only for a new outer call. Nested calls retain its original receipt and cut. */
  captureCurrent(
    target: FunctionUiResolveTarget,
    resident: FunctionUiResolvePeer
  ): FunctionUiResolveHostReceipt
  createConstructorScope(
    definition: FunctionUiResolveDefinition,
    receipt: FunctionUiResolveReceipt
  ): FunctionUiResolveConstructorScope
  /** Private original root/children provenance, never a callable function passed to a peer. */
  captureActions(call: FunctionUiResolveCall, originalProps: QuickJSHandle): object
  /** Root return only. Must reject foreign actions and use Q's actual callback registry. */
  reconnect(
    call: FunctionUiResolveCall,
    props: FunctionUiResolvePropsProof,
    output: QuickJSHandle
  ): QuickJSHandle
}
export interface FunctionUiResolvePreparedTable {
  readonly target: FunctionUiResolveTarget
  readonly resident: FunctionUiResolvePeer
}
