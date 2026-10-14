/** A declarative verdict, never a reusable approval or an execution permit. */
export type ToolPermissionResult = {
  decision: "allow" | "ask" | "deny"
  reason?: string
  rule?: string
  /** Informational upstream event name, never proof that a classic hook ran. */
  hook?: string
  /** The original question's ceiling, never a hook-supplied approval. */
  ceiling?: "allow" | "ask" | "deny"
}

/** Optional hooks may tighten host policy; they cannot remove a mandatory host gate. */
export function constrainToolPermission(
  proposed: ToolPermissionResult,
  mandatory: ToolPermissionResult
): ToolPermissionResult {
  const rank = { allow: 0, ask: 1, deny: 2 }
  return rank[mandatory.decision] > rank[proposed.decision] ? mandatory : proposed
}
