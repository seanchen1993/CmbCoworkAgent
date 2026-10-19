/** Main-only provenance: the action's display title is not provider-generated context. */
const originalText = new WeakMap<object, string>()
export function retainOriginalActionText<T extends object>(result: T, text: unknown): T {
  if (typeof text === "string") originalText.set(result, text)
  return result
}
export function readOriginalActionText(result: object): string | undefined {
  return originalText.get(result)
}
