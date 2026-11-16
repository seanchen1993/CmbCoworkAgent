/** Keep catalog refs intact and migrate IDs saved by older Design versions. */
export function normalizeDesignModelId(modelId: string | null | undefined): string | null {
  const trimmed = modelId?.trim()
  if (!trimmed) return null
  // Older versions incorrectly treated every non-custom ref as a custom ID.
  if (trimmed.startsWith("custom:builtin:")) return trimmed.slice("custom:".length)
  if (trimmed.startsWith("builtin:") || trimmed.startsWith("custom:")) return trimmed
  return `custom:${trimmed}`
}
