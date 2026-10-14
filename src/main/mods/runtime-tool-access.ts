import type { ToolPermissionResult } from "../../shared/tool-permission"

/** These names are supplied by the runtime that owns the backend, never by a guest. */
export interface ModRuntimeToolAccess {
  blockedToolNames?: ReadonlySet<string>
  allowedToolNames?: ReadonlySet<string>
  permissionToolName?: string
  permissionToolAliases?: readonly string[]
}

export function queryModRuntimeToolAccess(
  scope: ModRuntimeToolAccess,
  target: string
): ToolPermissionResult {
  if (
    scope.allowedToolNames &&
    ![
      target,
      target.replace(/^(?:host:|function:)/, ""),
      scope.permissionToolName,
      ...(scope.permissionToolAliases ?? [])
    ].some((name) => name && scope.allowedToolNames!.has(name))
  )
    return { decision: "deny", reason: "MODS_RUNTIME_TOOL_DENIED" }
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
