export function normalizePluginVersion(version?: string | null): string | undefined {
  const trimmed = String(version || "").trim()
  if (!trimmed) return undefined
  return trimmed.replace(/^v(?=\d)/i, "")
}

export function resolvePluginInstallVersion(
  manifestVersion?: string | null,
  overrideVersion?: string | null
): string {
  return (
    normalizePluginVersion(overrideVersion) ?? normalizePluginVersion(manifestVersion) ?? "1.0.0"
  )
}
