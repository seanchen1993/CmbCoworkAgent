/** Host custody of pre-publication tool facts. Never serialized into Mod input or accepted from JSON. */
const results = new WeakMap<object, string>()

export function bindHookExecutionResult<T extends object>(context: T, result: string): T {
  results.set(context, result)
  return context
}

export function hookExecutionResult(context: object): string | undefined {
  return results.get(context)
}
