import type { NativeRunnableStreamOperation } from "@langchain/core/native-stream-origin"

declare const nativePregelStreamBrand: unique symbol
export interface NativePregelStreamOperation<TResult = unknown> {
  readonly [nativePregelStreamBrand]: TResult
}
export interface NativePregelStreamFacts {
  readonly operation: NativePregelStreamOperation
  readonly graph: object
  readonly input: unknown
  readonly options: unknown
  readonly actualConfig: object | undefined
  readonly coreOperation: NativeRunnableStreamOperation | undefined
  readonly selectedIterator: Function
  readonly iteratorOwner: object
  readonly iteratorDescriptor: Readonly<PropertyDescriptor>
}
export interface NativePregelStreamExecutionFacts extends NativePregelStreamFacts {
  assertDataCurrent(): void
}
export interface NativePregelStreamSettlement extends NativePregelStreamFacts {
  readonly status: "fulfilled" | "rejected"
  readonly value: unknown
  readonly reason: unknown
  readonly entered: boolean
  readonly partialEntered: boolean
}

/** The graph must be a real completed Pregel constructor. No Source is granted. */
export declare function createNativePregelStreamOperation<TResult = unknown>(
  graph: object, input: unknown, options?: unknown
): NativePregelStreamOperation<TResult>
/** Returns the original iterable shell, without declaring its iterator physically drained. */
export declare function executeNativePregelStreamOperation<TResult>(
  operation: NativePregelStreamOperation<TResult>
): Promise<TResult>
export declare function readNativePregelStreamOperation(
  operation: NativePregelStreamOperation, graph: object, input: unknown, options?: unknown
): NativePregelStreamExecutionFacts | undefined
/** A failed execution remains failed; this only reports its actual outcome. */
export declare function readNativePregelStreamSettlement(
  operation: NativePregelStreamOperation
): NativePregelStreamSettlement | undefined

declare const checkpointCallBrand: unique symbol
export interface NativePregelCheckpointCall { readonly [checkpointCallBrand]: true }
export interface NativePregelCheckpointCallFacts {
  readonly operation: NativePregelStreamOperation
  readonly coreOperation: NativeRunnableStreamOperation
  readonly graph: object
  readonly input: unknown
  readonly iteratorConfig: object
  readonly initializeParams: object
  readonly initializeReceiver: object
  readonly checkpointer: object
  readonly checkpointConfig: object
  readonly selectedGetTuple: Function
}
export interface NativePregelCheckpointCallCurrent extends NativePregelCheckpointCallFacts {
  assertDataCurrent(): void
}
export interface NativePregelCheckpointCallSettlement extends NativePregelCheckpointCallFacts {
  readonly status: "fulfilled" | "rejected"
  readonly value: unknown
  readonly reason: unknown
  readonly claimed: boolean
}
/** Only the actual Graph child's synchronous Core iterator boundary can create this shell. */
export declare function createNativePregelCheckpointIterator(
  operation: NativePregelStreamOperation, graph: object, input: unknown, iteratorConfig: object
): AsyncGenerator<unknown, unknown, unknown>
export declare function readNativePregelCheckpointIteratorOrigin(
  operation: NativePregelStreamOperation
): Readonly<{ graph: object; originalIterator: Function; receiver: object;
  descriptor: Readonly<PropertyDescriptor>; assertDataCurrent(): void }> | undefined
/** Pointer comparison only: this never invokes or registers the supplied function. */
export declare function claimNativePregelCheckpointCall(
  checkpointer: object, checkpointConfig: object, selectedGetTuple: Function
): NativePregelCheckpointCall | undefined
export declare function readNativePregelCheckpointCall(
  call: NativePregelCheckpointCall
): NativePregelCheckpointCallCurrent | undefined
/** Reports the actual getTuple settlement without restoring execution permission. */
export declare function readNativePregelCheckpointSettlement(
  operation: NativePregelStreamOperation
): NativePregelCheckpointCallSettlement | undefined
