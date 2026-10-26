type JsonRecord = Record<string, unknown>

function record(value: unknown): JsonRecord {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as JsonRecord) : {}
}

/** Resolve native keywords or legacy .keyword subfields without enabling fielddata/scripts. */
export function indexedKeywordField(fields: unknown, name: string): string | undefined {
  const mapping = record(fields)
  for (const candidate of [name, `${name}.keyword`]) {
    const types = Object.values(record(mapping[candidate])).map(record)
    if (
      types.length &&
      types.every(
        (type) =>
          ["keyword", "constant_keyword"].includes(String(type.type)) &&
          type.aggregatable === true &&
          (type.non_aggregatable_indices == null ||
            (Array.isArray(type.non_aggregatable_indices) &&
              type.non_aggregatable_indices.length === 0))
      )
    )
      return candidate
  }
  return undefined
}
