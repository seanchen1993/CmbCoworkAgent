import type { ClawProfile } from "./claw"

/** Move one selected capability without changing its version or component configuration. */
export function moveClawCapability(
  profile: ClawProfile,
  pluginId: string,
  direction: -1 | 1
): ClawProfile {
  const index = profile.capabilities.findIndex((item) => item.pluginId === pluginId)
  const target = index + direction
  if (index < 0 || target < 0 || target >= profile.capabilities.length) return profile
  const capabilities = [...profile.capabilities]
  const moved = capabilities[index]
  capabilities[index] = capabilities[target]
  capabilities[target] = moved
  return { ...profile, capabilities }
}
