import { withRuntimePluginSource } from "../plugins/runtime-source-scope"

/** Native controller observation starts after a model turn; it never inherits that turn's token. */
export function dispatchManagedTurnObservation(
  observe: () => Promise<void>,
  onError: (error: unknown) => void
): void {
  setImmediate(() => {
    void withRuntimePluginSource(undefined, () => Promise.resolve().then(observe)).catch(onError)
  })
}
