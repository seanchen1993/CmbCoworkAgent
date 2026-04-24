export function joinHookText(
  existing: string | undefined,
  next: string | undefined,
  separator = "\n"
): string | undefined {
  if (!next) return existing
  return existing ? `${existing}${separator}${next}` : next
}
