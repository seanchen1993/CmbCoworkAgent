import type { ModObject } from "../../../shared/mods/types"
import { matchesEventPattern, type FunctionGuest } from "../../../shared/mods/v2/contracts"
import {
  FUNCTION_PASSIVE_DISPLAY_SITES,
  FUNCTION_UI_SITES,
  type FunctionUiSite
} from "../../../shared/mods/v2/sites"
import { FUNCTION_DISPLAY_PROTOCOL } from "./display-rollout"
import { analyzeStaticUiRenderSummary, type StaticUiRenderProof } from "./static-ui-render-summary"

import {
  functionPreparedDisplayProof,
  FUNCTION_DISPLAY_STATIC_SOURCE_LIMIT,
  type FunctionPreparedDisplayProof
} from "./display-preparation"
export { FUNCTION_DISPLAY_STATIC_SOURCE_LIMIT } from "./display-preparation"
export interface FunctionDisplayRoutingPlugin {
  guest: FunctionGuest
  code?: string
}
export interface FunctionDisplayRoute {
  native: boolean
  expectedRefs: ModObject[]
}
interface CachedProof {
  code?: string
  registrations: string
  proof?: StaticUiRenderProof | FunctionPreparedDisplayProof | null
  retired: boolean
}

/** Pure route analysis only. The manager still owns grants, source fences and execution. */
export class FunctionDisplayRouting {
  private readonly proofs = new WeakMap<FunctionGuest, CachedProof>()

  constructor(private readonly analyze = analyzeStaticUiRenderSummary) {}

  qualify(
    plugins: readonly FunctionDisplayRoutingPlugin[],
    component: FunctionUiSite
  ): FunctionDisplayRoute | undefined {
    if (!FUNCTION_UI_SITES.some((site) => site === component)) return
    let native = true
    const refs = new Map<string, ModObject>()
    for (const plugin of plugins) {
      if (plugin.guest.stats.disposed) return
      const registrations = JSON.stringify(
        plugin.guest.registrations.map((row) => [
          row.id,
          row.pattern,
          row.hasMatcher,
          row.hasCatch,
          !!row.platformCapability
        ])
      )
      let cached = this.proofs.get(plugin.guest)
      if (!cached) {
        cached = { code: plugin.code, registrations, retired: false }
        this.proofs.set(plugin.guest, cached)
      }
      if (cached.retired || cached.code !== plugin.code || cached.registrations !== registrations) {
        cached.retired = true
        cached.proof = null
        return
      }
      if (
        !plugin.guest.registrations.some(
          (row) =>
            matchesEventPattern(row.pattern, "ui.render") ||
            matchesEventPattern(row.pattern, "ui.resolve")
        )
      )
        continue
      const prepared = functionPreparedDisplayProof(plugin.guest, plugin.code, this.analyze)
      if (cached.proof === undefined) cached.proof = prepared
      else if (cached.proof !== prepared) return
      const proof = cached.proof
      if (!proof) return
      if (!proof.components.includes(component)) continue
      if (!proof.reusableComponents.includes(component)) return
      native = false
      for (const ref of proof.readsNamedState[component] ?? []) {
        const key = JSON.stringify([ref.plugin, ref.key, ref.id ?? null])
        refs.set(key, {
          plugin: ref.plugin,
          key: ref.key,
          ...(ref.id === undefined ? {} : { id: ref.id })
        })
      }
    }
    if (
      refs.size &&
      plugins.some((plugin) =>
        plugin.guest.registrations.some((row) => matchesEventPattern(row.pattern, "state.get"))
      )
    )
      return
    return { native, expectedRefs: [...refs.values()] }
  }
}

/** Host discovery data, not a new guest API or a complete SDK compatibility claim. */
export function describeFunctionDisplayRouting() {
  return {
    protocol: FUNCTION_DISPLAY_PROTOCOL,
    owner: "host" as const,
    siteVocabulary: [...FUNCTION_UI_SITES],
    passiveSites: [...FUNCTION_PASSIVE_DISPLAY_SITES],
    limits: { staticSourceCodeUnits: FUNCTION_DISPLAY_STATIC_SOURCE_LIMIT },
    supported: [
      "literal-component-routing",
      "proved-passive-callbacks",
      "literal-named-state-dependencies"
    ],
    limited: [
      "proof-bound-to-exact-guest-code-and-registrations",
      "native-utility-preparation-required-old-peers-use-legacy",
      "named-state-without-state-get-interception"
    ],
    legacyFallback: [
      "unknown-or-dynamic-matcher",
      "ui-resolve",
      "unproved-middleware-or-effects",
      "changed-source-identity"
    ],
    grantsAuthority: false,
    claimsCompleteSdkCompatibility: false
  }
}
