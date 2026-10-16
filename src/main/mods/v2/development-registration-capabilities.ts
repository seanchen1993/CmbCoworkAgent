import type { FunctionRegistration } from "../../../shared/mods/v2/contracts"

/** Exact native registration facts; patterns never imply a wildcard trial grant. */
export function developmentRegistrationCapabilities(
  registrations: readonly FunctionRegistration[]
): string[] {
  return [...new Set(registrations.map((registration) => `event:${registration.pattern}`))]
}
