function cloneValue<T>(value: T): T {
  if (value === undefined) return value
  return JSON.parse(JSON.stringify(value)) as T
}

function normalizeSchemaValue(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map((item) => normalizeSchemaValue(item))
  }

  if (!value || typeof value !== "object") {
    return value
  }

  const source = value as Record<string, unknown>
  const normalized: Record<string, unknown> = {}

  for (const [key, child] of Object.entries(source)) {
    if (key === "required" && child == null) {
      normalized[key] = []
      continue
    }
    normalized[key] = normalizeSchemaValue(child)
  }

  return normalized
}

export function normalizeJsonSchema<T extends Record<string, unknown> | undefined>(schema: T): T {
  if (!schema) return schema
  return normalizeSchemaValue(cloneValue(schema)) as T
}

export class SchemaCache {
  private normalized = new Map<string, Record<string, unknown>>()

  get(schema?: Record<string, unknown>): Record<string, unknown> | undefined {
    if (!schema) return undefined
    const key = JSON.stringify(schema)
    const cached = this.normalized.get(key)
    if (cached) {
      return cloneValue(cached)
    }

    const normalized = normalizeJsonSchema(schema)
    this.normalized.set(key, cloneValue(normalized))
    return normalized
  }

  clear(): void {
    this.normalized.clear()
  }
}
