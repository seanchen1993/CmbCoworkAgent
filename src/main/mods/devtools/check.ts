import { compileFunctionPlugin } from "../v2/loader"
import { FunctionGuestRuntime } from "../v2/guest-runtime"
import { CLAUDE_EVENT_NAMES } from "../../../shared/mods/v2/event-catalog"
import { matchesEventPattern, type FunctionGuest } from "../../../shared/mods/v2/contracts"
import type { ModObject } from "../../../shared/mods/types"

export async function checkFunctionPlugin(
  directory: string,
  load: (code: string, options: ModObject) => Promise<FunctionGuest> = FunctionGuestRuntime.create
) {
  const compiled = await compileFunctionPlugin(directory)
  const guest = await load(compiled.code, compiled.options)
  try {
    const registrations = guest.registrations.map((registration) => ({
      ...registration,
      events: [...CLAUDE_EVENT_NAMES, "completion.check"].filter((name) =>
        name === "completion.check"
          ? registration.pattern === name
          : matchesEventPattern(registration.pattern, name)
      )
    }))
    const unknown = registrations.filter((row) => row.events.length === 0).map((row) => row.pattern)
    return {
      valid: unknown.length === 0,
      name: compiled.name,
      profile: compiled.profile,
      digest: compiled.digest,
      sources: compiled.sources,
      registrations,
      diagnostics: unknown.map((pattern) => ({ code: "MODS_EVENT_PROVIDER_REQUIRED", pattern })),
      scope: "package-and-registration-check",
      authorized: false
    }
  } finally {
    await guest.dispose()
  }
}
