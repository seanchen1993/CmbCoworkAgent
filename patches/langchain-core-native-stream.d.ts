declare const nativeRunnableStreamBrand: unique symbol

export interface NativeRunnableStreamOperation<TResult = unknown> {
  readonly [nativeRunnableStreamBrand]: TResult
}
export interface NativeRunnableStreamFacts {
  readonly operation: NativeRunnableStreamOperation
  readonly receiver: object
  readonly input: unknown
  readonly options: unknown
  readonly actualConfig: object | undefined
  readonly actualSignal: unknown
  readonly selectedIterator: Function
  readonly iteratorOwner: object
  readonly iteratorDescriptor: Readonly<PropertyDescriptor>
}
export interface NativeRunnableStreamBoundary extends NativeRunnableStreamFacts {
  readonly actualConfig: object
  assertDataCurrent(): void
}
export interface NativeRunnableStreamSettlement extends NativeRunnableStreamFacts {
  readonly status: "fulfilled" | "rejected"
  readonly value: unknown
  readonly reason: unknown
  readonly entered: boolean
  readonly iteratorEntered: boolean
}

/** Execution facts, never an application Source or receiver authority. */
export declare function createNativeRunnableStreamOperation<TResult = unknown>(
  receiver: object, input: unknown, options?: unknown
): NativeRunnableStreamOperation<TResult>
/** Returns the actual iterable shell. Its successful setup is not physical drain. */
export declare function executeNativeRunnableStreamOperation<TResult>(
  operation: NativeRunnableStreamOperation<TResult>
): Promise<TResult>
/** Only the genuine synchronous selected iterator entry can expose this boundary. */
export declare function readNativeRunnableStreamBoundary(
  receiver: object, actualConfig: object
): NativeRunnableStreamBoundary | undefined
/** Reporting a real failure does not restore a failed execution capability. */
export declare function readNativeRunnableStreamSettlement(
  operation: NativeRunnableStreamOperation
): NativeRunnableStreamSettlement | undefined
