export function sanitizeHarnessNameInput(value: string): string {
  return value.replace(/\s+/g, "")
}

export function isImeComposing(
  refComposing: boolean,
  nativeEvent?: { isComposing?: boolean } | null
): boolean {
  return refComposing || Boolean(nativeEvent?.isComposing)
}

export function resolveNormalizedInputValue(
  rawValue: string,
  composing: boolean,
  normalize?: (value: string) => string
): string {
  if (!normalize || composing) return rawValue
  return normalize(rawValue)
}
