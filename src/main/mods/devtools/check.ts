import { compileFunctionPlugin } from "../v2/loader"
import { FunctionGuestRuntime } from "../v2/guest-runtime"
import { assessFunctionCompatibility } from "../../../shared/mods/v2/compatibility"
import type { FunctionGuest } from "../../../shared/mods/v2/contracts"
import type { ModObject } from "../../../shared/mods/types"
import { analyzeFunctionSdk } from "./sdk-usage"

export async function checkFunctionPlugin(
  directory: string,
  load: (code: string, options: ModObject) => Promise<FunctionGuest> = FunctionGuestRuntime.create
) {
  const compiled = await compileFunctionPlugin(directory, { captureSources: true })
  const sdkCompatibility = await analyzeFunctionSdk(compiled)
  const guest = await load(compiled.code, compiled.options)
  try {
    const compatibility = assessFunctionCompatibility(guest.registrations)
    const registrations = compatibility.registrations
    const unknown = registrations.filter((row) => row.events.length === 0).map((row) => row.pattern)
    return {
      valid: unknown.length === 0,
      packageValid: true,
      name: compiled.name,
      profile: compiled.profile,
      modelProtocol: compiled.modelProtocol,
      digest: compiled.digest,
      sources: compiled.sources,
      environment: compiled.environment,
      authorTypes: compiled.authorTypes,
      registrations,
      diagnostics: [
        ...unknown.map((pattern) => ({ code: "MODS_EVENT_PROVIDER_REQUIRED", pattern })),
        ...compatibility.diagnostics.filter((item) => !unknown.includes(item.pattern)),
        ...sdkCompatibility.diagnostics
      ],
      compatibility,
      sdkCompatibility,
      scope: "package-registration-and-sdk-check",
      authorized: false
    }
  } finally {
    await guest.dispose()
  }
}
