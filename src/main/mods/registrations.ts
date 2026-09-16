import type { ModManifest, ModRegistration } from "../../shared/mods/types"
import { ModError } from "./errors"

export function validateModRegistrations(
  manifest: ModManifest,
  registrations: ModRegistration[]
): void {
  if (!Array.isArray(registrations) || registrations.length > 64)
    throw new ModError("MODS_REGISTRATION_LIMIT")
  const ids = new Set<string>()
  for (const registration of registrations) {
    if (
      !registration ||
      typeof registration.id !== "string" ||
      !/^[a-zA-Z0-9_.-]{1,100}$/.test(registration.id) ||
      ids.has(registration.id) ||
      !manifest.events.includes(registration.event)
    )
      throw new ModError("MODS_REGISTRATION_INVALID")
    ids.add(registration.id)
    if (
      registration.event === "tool.call" &&
      (!Array.isArray(registration.tools) ||
        !registration.tools.length ||
        registration.tools.some((id) => !manifest.tools.includes(id)))
    )
      throw new ModError("MODS_UNDECLARED_TOOL")
    if (
      registration.event === "command.run" &&
      (!registration.command?.startsWith(`${manifest.id}:`) || registration.command.length > 160)
    )
      throw new ModError("MODS_COMMAND_NAMESPACE")
    if (registration.event === "ui.render" && registration.slot !== "tool.result.after")
      throw new ModError("MODS_UI_SLOT_UNSUPPORTED")
  }
}
