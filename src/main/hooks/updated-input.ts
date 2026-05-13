function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
}

function isUnsafeMergeKey(key: string): boolean {
  return key === "__proto__" || key === "constructor" || key === "prototype"
}

function sanitizeUpdatedInputValue(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map((item) => sanitizeUpdatedInputValue(item))
  }

  if (!isPlainObject(value)) {
    return value
  }

  const sanitized: Record<string, unknown> = {}
  for (const [key, nestedValue] of Object.entries(value)) {
    if (isUnsafeMergeKey(key)) continue
    sanitized[key] = sanitizeUpdatedInputValue(nestedValue)
  }
  return sanitized
}

export function mergeUpdatedInput<T extends Record<string, unknown>>(
  base: T,
  updatedInput?: Record<string, unknown>
): T {
  if (!isPlainObject(updatedInput)) {
    return base
  }

  const merged: Record<string, unknown> = { ...base }
  for (const [key, value] of Object.entries(updatedInput)) {
    if (isUnsafeMergeKey(key)) continue
    const existing = merged[key]
    if (isPlainObject(existing) && isPlainObject(value)) {
      merged[key] = mergeUpdatedInput(existing, value)
      continue
    }
    merged[key] = sanitizeUpdatedInputValue(value)
  }

  return merged as T
}
