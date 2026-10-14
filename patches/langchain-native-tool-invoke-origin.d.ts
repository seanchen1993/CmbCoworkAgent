import type { createAgent } from "./agents/index.js"
import type { ToolCall } from "@langchain/core/messages"
import type { RunnableConfig } from "@langchain/core/runnables"

declare const operationBrand: unique symbol
declare const selectionBrand: unique symbol
declare const outcomeBrand: unique symbol
export interface NativeToolInvokeOperation { readonly [operationBrand]: true }
export interface NativeToolInvokeSelection { readonly [selectionBrand]: true }
export interface NativeToolInvokeOutcome { readonly [outcomeBrand]: true }
export interface NativeToolInvokeSelectionFacts {
  readonly tool: object
  readonly receiver: object
  readonly invoke: Function
  readonly request: unknown
  readonly call: ToolCall
  readonly input: unknown
  readonly config: unknown
  readonly index: number
  readonly status: "selected" | "invoking" | "settled"
  readonly outcome: NativeToolInvokeOutcome | undefined
}
export declare const createNativeToolInvokeAgent: typeof createAgent
export declare function createNativeToolInvokeOperation(agent: object, call: ToolCall,
  config: RunnableConfig, state: unknown): NativeToolInvokeOperation
export declare function executeNativeToolInvokeOperation(operation: NativeToolInvokeOperation): Promise<unknown>
export declare function readNativeToolInvokeSelections(operation: NativeToolInvokeOperation): readonly NativeToolInvokeSelection[]
export declare function readNativeToolInvokeSelection(selection: NativeToolInvokeSelection,
  operation: NativeToolInvokeOperation): Readonly<NativeToolInvokeSelectionFacts> | undefined
export declare function readNativeToolInvokeOutcome(outcome: NativeToolInvokeOutcome,
  selection: NativeToolInvokeSelection, operation: NativeToolInvokeOperation):
  Readonly<{ status: "fulfilled"; value: unknown } | { status: "rejected"; reason: unknown }> | undefined
export declare function closeAndDrainNativeToolInvokeOperation(operation: NativeToolInvokeOperation): Promise<void>
