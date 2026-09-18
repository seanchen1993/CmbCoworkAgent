import type { ToolPermissionResult } from "../../shared/tool-permission"

/** These names are supplied by the runtime that owns the backend, never by a guest. */
export interface ModRuntimeToolAccess {
  blockedToolNames?: ReadonlySet<string>
  permissionToolName?: string
  permissionToolAliases?: readonly string[]
}

export function queryModRuntimeToolAccess(
  scope: ModRuntimeToolAccess,
  target: string
): ToolPermissionResult {
  const blocked = scope.blockedToolNames
  if (
    blocked?.size &&
    [
      target,
      target.replace(/^(?:host:|function:)/, ""),
      scope.permissionToolName,
      ...(scope.permissionToolAliases ?? [])
    ].some((name) => name && blocked.has(name))
  )
    return { decision: "deny", reason: "MODS_RUNTIME_TOOL_DENIED" }
  return { decision: "allow" }
}
