declare const nativeStreamOperationResult: unique symbol

export interface NativeStreamOperation<TResult = unknown> {
  readonly [nativeStreamOperationResult]: TResult
}

export interface NativeStreamBoundary {
  readonly operation: NativeStreamOperation
  readonly agent: object
  readonly graph: object
  readonly actualConfig: object
  readonly actualState: unknown
  readonly initializationSkipped: boolean
  readonly kind: "preflight" | "dispatch"
  assertDataCurrent(): void
}

/** SDK execution provenance only. This does not grant application or checkpoint authority. */
export declare function createNativeStreamOperation<
  TAgent extends { stream: (...args: never[]) => Promise<unknown> }
>(agent: TAgent, ...args: Parameters<TAgent["stream"]>):
  NativeStreamOperation<Awaited<ReturnType<TAgent["stream"]>>>

/** Returns the exact original iterable shell; successful settlement is not physical drain. */
export declare function executeNativeStreamOperation<TResult>(
  operation: NativeStreamOperation<TResult>
): Promise<TResult>

/** Available only at the genuine synchronous lexical callee entry, never after an await. */
export declare function readNativeStreamBoundary(
  graph: object, config: object, kind: "preflight" | "dispatch"
): NativeStreamBoundary | undefined
