import type { FunctionUiSite } from "../../../shared/mods/v2/sites"

/** Renderer row identity only. It never selects an execution, approval or native data owner. */
export function functionSiteRowIdentity(
  component: FunctionUiSite,
  ids: readonly string[]
): string | undefined {
  if (!ids.length || ids.length > 32 || ids.some((id) => typeof id !== "string" || !id))
    return undefined
  const identity = JSON.stringify([component, ...ids])
  // Leave room for the bounded cache-admission tuple, including escaped native IDs.
  if (identity.length > 2048 - 64 || JSON.stringify([component, identity]).length > 2048)
    return undefined
  return identity
}
