import {
  ModFunctionError,
  type FunctionGuest,
  type FunctionRegistration
} from "../../../shared/mods/v2/contracts"
import type { FunctionRuntimeClient } from "./runtime-client"
import type { FunctionUiResolveHostLifetime } from "./ui-resolve-host-lifetime"

export interface FunctionUiResolveRuntimeBinding {
  readonly client: FunctionRuntimeClient
  readonly runtimeId: string
  readonly physical: FunctionUiResolveHostLifetime
  readonly registrations: readonly Readonly<FunctionRegistration>[]
  assertCurrent(): void
}

const bindings = new WeakMap<FunctionGuest, FunctionUiResolveRuntimeBinding>()

/** Called only on the actual native load response. No lookup by guest name/stats/JSON metadata. */
export function bindFunctionUiResolveRuntime(
  guest: FunctionGuest,
  client: FunctionRuntimeClient,
  runtimeId: string,
  physical: FunctionUiResolveHostLifetime,
  assertGuestCurrent: () => void
): void {
  if (bindings.has(guest)) throw new ModFunctionError("MODS_UI_RESOLVE_IDENTITY")
  physical.assertCurrent()
  assertGuestCurrent()
  const registrations = Object.freeze(guest.registrations.map((row) => Object.freeze({ ...row })))
  bindings.set(
    guest,
    Object.freeze({
      client,
      runtimeId,
      physical,
      registrations,
      assertCurrent() {
        physical.assertCurrent()
        assertGuestCurrent()
      }
    })
  )
}

/** Activity proxy aliases inherit the exact native binding, never a recomputed identity. */
export function aliasFunctionUiResolveRuntime(source: FunctionGuest, alias: FunctionGuest): void {
  const binding = bindings.get(source)
  if (!binding) return // In-process controlled guests retain their independent native adapters.
  if (bindings.has(alias)) throw new ModFunctionError("MODS_UI_RESOLVE_IDENTITY")
  binding.assertCurrent()
  bindings.set(alias, binding)
}

export function functionUiResolveRuntimeBinding(
  guest: FunctionGuest
): FunctionUiResolveRuntimeBinding {
  const binding = bindings.get(guest)
  if (!binding) throw new ModFunctionError("MODS_UI_RESOLVE_TRANSPORT_REQUIRED")
  binding.assertCurrent()
  return binding
}
