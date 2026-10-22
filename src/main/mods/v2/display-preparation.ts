import { createHash } from "node:crypto"
import type { ModJson } from "../../../shared/mods/types"
import {
  isModObject,
  matchesEventPattern,
  ModFunctionError,
  type FunctionGuest
} from "../../../shared/mods/v2/contracts"
import { FUNCTION_UI_SITES } from "../../../shared/mods/v2/sites"
import { namedStateAddress } from "./named-state"
import { functionUiResolveRuntimeBinding } from "./ui-resolve-runtime-binding"
import type { FunctionUiResolveHostLifetime } from "./ui-resolve-host-lifetime"
import {
  analyzeStaticUiRenderSummary,
  bindStaticUiRenderSummary,
  type StaticUiRenderProof
} from "./static-ui-render-summary"

export const FUNCTION_DISPLAY_STATIC_SOURCE_LIMIT = 128 * 1024
const protocol = "mods.display.preparation/v1"
const nativeBrand: unique symbol = Symbol("NativeDisplayPreparation")
export interface FunctionPreparedDisplayProof {
  readonly [nativeBrand]: true
  readonly codeDigest: string
  readonly components: readonly string[]
  readonly reusableComponents: readonly string[]
  readonly readsNamedState: StaticUiRenderProof["readsNamedState"]
}
interface Source {
  code: string
  registrations: string
  proof?: StaticUiRenderProof | FunctionPreparedDisplayProof | null
  assertCurrent(): void
}
const sources = new WeakMap<FunctionGuest, Source>()
const digest = (value: string) => createHash("sha256").update(value).digest("hex")
const registrationDigest = (guest: Pick<FunctionGuest, "registrations">) =>
  digest(
    JSON.stringify(
      guest.registrations.map((row) => [
        row.id,
        row.pattern,
        row.hasMatcher ?? null,
        row.hasCatch,
        row.platformCapability ?? null
      ])
    )
  )

/** Only FunctionGuestRuntime.create calls this after the actual native registration finishes. */
export function registerFunctionDirectDisplaySource(guest: FunctionGuest, code: string): void {
  if (sources.has(guest)) throw new ModFunctionError("MODS_DISPLAY_PREPARATION_IDENTITY")
  sources.set(guest, {
    code,
    registrations: registrationDigest(guest),
    assertCurrent() {
      if (guest.stats.disposed) throw new ModFunctionError("MODS_UNLOADED")
    }
  })
}

/** A native activity proxy inherits the exact opaque source binding, not JSON metadata. */
export function aliasFunctionDisplayPreparation(source: FunctionGuest, alias: FunctionGuest): void {
  const entry = sources.get(source)
  if (!entry) return
  if (sources.has(alias)) throw new ModFunctionError("MODS_DISPLAY_PREPARATION_IDENTITY")
  entry.assertCurrent()
  sources.set(alias, entry)
}

export function functionPreparedDisplayProof(
  guest: FunctionGuest,
  code: string | undefined,
  analyze = analyzeStaticUiRenderSummary
): StaticUiRenderProof | FunctionPreparedDisplayProof | null {
  const source = sources.get(guest)
  if (!source) return null // Arbitrary guests and old utility peers cannot request Main AST analysis.
  source.assertCurrent()
  if (code !== source.code || registrationDigest(guest) !== source.registrations) return null
  if (source.proof === undefined) {
    source.proof =
      code && code.length <= FUNCTION_DISPLAY_STATIC_SOURCE_LIMIT
        ? (bindStaticUiRenderSummary(analyze(code), code, guest.registrations) ?? null)
        : null
  }
  source.assertCurrent()
  return source.proof
}

/** Runs in the existing native utility load handler, outside QuickJS and before the load reply. */
export function prepareFunctionDisplayEnvelope(
  guest: FunctionGuest,
  code: string,
  runtimeId: string
): ModJson {
  const relevant = guest.registrations.some(
    (row) =>
      matchesEventPattern(row.pattern, "ui.render") ||
      matchesEventPattern(row.pattern, "ui.resolve")
  )
  let proof = relevant ? functionPreparedDisplayProof(guest, code) : null
  if (proof) {
    try {
      // Preparation budgets cannot make an otherwise loadable plugin fail to load.
      // Unsupported dependency metadata stays on the legacy path instead.
      for (const refs of Object.values(proof.readsNamedState)) {
        for (const ref of refs) namedStateAddress(ref)
      }
    } catch {
      proof = null
    }
  }
  return {
    protocol,
    runtimeId,
    codeDigest: digest(code),
    registrationsDigest: registrationDigest(guest),
    ...(proof
      ? {
          state: "proved",
          components: [...proof.components],
          reusableComponents: [...proof.reusableComponents],
          readsNamedState: JSON.parse(JSON.stringify(proof.readsNamedState)) as ModJson
        }
      : { state: "unknown" })
  }
}

/** Private Main channel: construct only in RuntimeClient around its authenticated load reply.
 * No SDK/renderer entry constructs this object or receives bind(). JSON alone is not a source proof.
 */
export class FunctionDisplayPreparationChannel {
  constructor(
    private readonly owner: { client: object; physical: FunctionUiResolveHostLifetime },
    private readonly assertPhysicalCurrent: () => void
  ) {}

  bind(
    guest: FunctionGuest,
    code: string,
    runtimeId: string,
    wire: ModJson | undefined,
    assertGuestCurrent: () => void
  ): void {
    this.assertPhysicalCurrent()
    assertGuestCurrent()
    if (sources.has(guest)) throw new ModFunctionError("MODS_DISPLAY_PREPARATION_IDENTITY")
    const binding = functionUiResolveRuntimeBinding(guest)
    if (
      binding.client !== this.owner.client ||
      binding.physical !== this.owner.physical ||
      binding.runtimeId !== runtimeId ||
      registrationDigest(binding) !== registrationDigest(guest)
    )
      throw new ModFunctionError("MODS_DISPLAY_PREPARATION_IDENTITY")
    binding.assertCurrent()
    const source: Source = {
      code,
      registrations: registrationDigest(guest),
      proof: null,
      assertCurrent: () => {
        binding.assertCurrent()
        this.assertPhysicalCurrent()
        assertGuestCurrent()
      }
    }
    if (wire !== undefined) source.proof = this.validate(guest, code, runtimeId, wire)
    source.assertCurrent()
    sources.set(guest, source)
  }

  private validate(
    guest: FunctionGuest,
    code: string,
    runtimeId: string,
    wire: ModJson
  ): FunctionPreparedDisplayProof | null {
    const fail = (): never => {
      throw new ModFunctionError("MODS_DISPLAY_PREPARATION_INVALID")
    }
    if (
      !isModObject(wire) ||
      wire.protocol !== protocol ||
      wire.runtimeId !== runtimeId ||
      wire.codeDigest !== digest(code) ||
      wire.registrationsDigest !== registrationDigest(guest) ||
      Object.keys(wire).some(
        (key) =>
          ![
            "protocol",
            "runtimeId",
            "codeDigest",
            "registrationsDigest",
            "state",
            "components",
            "reusableComponents",
            "readsNamedState"
          ].includes(key)
      )
    )
      return fail()
    if (wire.state === "unknown") {
      if (["components", "reusableComponents", "readsNamedState"].some((key) => key in wire))
        return fail()
      return null
    }
    if (
      wire.state !== "proved" ||
      code.length > FUNCTION_DISPLAY_STATIC_SOURCE_LIMIT ||
      !Array.isArray(wire.components) ||
      !Array.isArray(wire.reusableComponents) ||
      !isModObject(wire.readsNamedState)
    )
      return fail()
    const sites: readonly string[] = ["Pane", ...FUNCTION_UI_SITES]
    const list = (value: ModJson[]): string[] => {
      if (
        value.length > sites.length ||
        value.some((item) => typeof item !== "string" || !sites.includes(item)) ||
        new Set(value).size !== value.length
      )
        return fail()
      return value as string[]
    }
    const components = list(wire.components),
      reusableComponents = list(wire.reusableComponents)
    if (reusableComponents.some((component) => !components.includes(component))) return fail()
    const refs: Record<string, Array<{ plugin: string; key: string; id?: string }>> = {}
    for (const [component, values] of Object.entries(wire.readsNamedState)) {
      if (!components.includes(component) || !Array.isArray(values) || values.length > 30000)
        return fail()
      refs[component] = values.map((value) => {
        const ref = namedStateAddress(value)
        return Object.freeze({
          plugin: ref.plugin as string,
          key: ref.key as string,
          ...(ref.id === undefined ? {} : { id: ref.id as string })
        })
      })
      Object.freeze(refs[component])
    }
    return Object.freeze({
      [nativeBrand]: true as const,
      codeDigest: wire.codeDigest as string,
      components: Object.freeze([...components]),
      reusableComponents: Object.freeze([...reusableComponents]),
      readsNamedState: Object.freeze(refs)
    })
  }
}
