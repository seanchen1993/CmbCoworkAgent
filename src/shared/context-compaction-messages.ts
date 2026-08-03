function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined
}

function hasSummarizationSource(value: unknown): boolean {
  return asRecord(value)?.lc_source === "summarization"
}

/**
 * Detect the structural marker attached by deepagents summarization middleware.
 *
 * Check both shapes used at process boundaries: serialized LangChain messages
 * keep metadata under `kwargs.additional_kwargs`, while deserialized checkpoint
 * messages can expose `additional_kwargs` directly.
 */
export function isSerializedSummarizationMessage(message: unknown): boolean {
  const record = asRecord(message)
  if (!record) return false
  const kwargs = asRecord(record.kwargs)
  return (
    hasSummarizationSource(record.additional_kwargs) ||
    hasSummarizationSource(kwargs?.additional_kwargs)
  )
}
