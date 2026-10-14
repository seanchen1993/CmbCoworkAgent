import { ModError } from "../mods/errors"

/** A synchronous host decision, never a renderer estimate or a runtime/session initializer. */
export function readModsChatDisplayCapability(
  manager: { isEnabled(workspace: string): boolean; protects(workspace: string): boolean },
  access: { workspace: string; assertCurrent(): void }
): boolean {
  access.assertCurrent()
  const enabled = manager.isEnabled(access.workspace)
  const protectedOutput = manager.protects(access.workspace)
  access.assertCurrent()
  if (typeof enabled !== "boolean" || typeof protectedOutput !== "boolean")
    throw new ModError("MODS_UI_SITE_PROTECTION_REQUIRED")
  return enabled || protectedOutput
}
