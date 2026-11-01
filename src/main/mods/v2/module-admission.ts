import {
  MOD_TIERS,
  ModFunctionError,
  matchesEventPattern,
  type FunctionGuest,
  type FunctionRegistration
} from "../../../shared/mods/v2/contracts"
import {
  validateFunctionPluginRegisterInput,
  validateFunctionPluginRegisterResult,
  type FunctionPluginRegisterInput,
  type FunctionPluginRegisterResult
} from "../../../shared/mods/v2/plugin-register"
import type { FunctionPlugin } from "./dispatcher"
import type { FunctionCompiledAdmissionModule } from "./loader"
import { aliasFunctionDisplayPreparation } from "./display-preparation"
import { subsetFunctionUiResolveRuntime } from "./ui-resolve-runtime-binding"

interface Candidate {
  plugin: FunctionPlugin
  original: FunctionGuest
  registrations: readonly FunctionRegistration[]
  admitted: FunctionRegistration[]
  ids: Set<string>
  modules: readonly FunctionCompiledAdmissionModule[]
  clients: Set<string>
}

/** A host-only registration view; the VM and plugin/state/grant identity stay unchanged. */
export class FunctionModuleAdmission {
  readonly plugins: FunctionPlugin[]
  readonly gated: boolean
  private readonly candidates: Candidate[] = []
  constructor(readonly all: readonly FunctionPlugin[]) {
    this.gated =
      all.some((plugin) => plugin.admission) &&
      all.some((plugin) =>
        plugin.guest.registrations.some((row) =>
          matchesEventPattern(row.pattern, "plugin.register")
        )
      )
    this.plugins = this.gated ? [] : [...all]
    if (!this.gated) return
    for (const plugin of [...all].sort(
      (a, b) => MOD_TIERS.indexOf(a.tier) - MOD_TIERS.indexOf(b.tier)
    )) {
      const original = plugin.guest
      const candidate: Candidate = {
        plugin,
        original,
        registrations: [...original.registrations],
        admitted: [],
        ids: new Set(),
        modules: plugin.admission?.modules ?? [
          {
            id: "native",
            clients: [],
            uses: { events: [], calls: [] },
            unknown: "source has no static admission declaration"
          }
        ],
        clients: new Set()
      }
      const ids = candidate.ids
      const view = new Proxy(original, {
        get(target, key) {
          if (key === "registrations") return candidate.admitted
          if (key === "matches")
            return (
              id: string,
              ...args: Parameters<FunctionGuest["matches"]> extends [string, ...infer Rest]
                ? Rest
                : never
            ) => {
              if (!ids.has(id)) throw new ModFunctionError("MODS_MODULE_NOT_ADMITTED")
              return target.matches(id, ...args)
            }
          if (key === "invoke")
            return (...args: Parameters<FunctionGuest["invoke"]>) => {
              if (
                (candidate.registrations.some((row) => row.id === args[0]) && !ids.has(args[0])) ||
                !candidate.admitted.length
              )
                throw new ModFunctionError("MODS_MODULE_NOT_ADMITTED")
              return target.invoke(...args)
            }
          const value = Reflect.get(target, key, target)
          return typeof value === "function" ? value.bind(target) : value
        }
      })
      plugin.guest = view
      aliasFunctionDisplayPreparation(original, view)
      this.candidates.push(candidate)
    }
  }

  async run(
    signal: AbortSignal,
    judge: (input: FunctionPluginRegisterInput) => Promise<FunctionPluginRegisterResult>,
    admitted: (plugin: FunctionPlugin, first: boolean) => void,
    refused: (plugin: FunctionPlugin, module: string, reason: string) => void
  ): Promise<void> {
    if (!this.gated) return
    for (const candidate of this.candidates) {
      const { plugin } = candidate
      const entries = new Set<string>()
      for (const module of candidate.modules) {
        signal.throwIfAborted()
        const rows = candidate.registrations.filter(
          (row) =>
            row.module === module.id || (row.module === undefined && candidate.modules.length === 1)
        )
        const unknown =
          (module.requires?.some((id) => !entries.has(id))
            ? "required component module was not admitted"
            : undefined) ??
          module.unknown ??
          (rows.some((row) => !module.uses.events.includes(row.pattern))
            ? "registered events disagree with the static declaration"
            : undefined)
        let result: FunctionPluginRegisterResult
        if (unknown) result = { refuse: `Cannot safely inspect ${module.id}: ${unknown}` }
        else {
          const input: FunctionPluginRegisterInput = {
            name: plugin.name,
            root: plugin.root,
            tier: plugin.tier === "core" ? "builtin" : plugin.tier,
            ...(plugin.admission?.version ? { version: plugin.admission.version } : {}),
            provenance: plugin.admission?.provenance ?? `${plugin.name}@local`,
            uses: structuredClone(module.uses)
          }
          let valid = true
          try {
            validateFunctionPluginRegisterInput(input)
          } catch {
            valid = false
          }
          result = valid
            ? await judge(input)
            : { refuse: "Static module declaration exceeds the supported admission contract" }
        }
        signal.throwIfAborted()
        validateFunctionPluginRegisterResult(result)
        if ("refuse" in result) {
          refused(plugin, module.id, result.refuse)
          continue
        }
        const first = !this.plugins.includes(plugin)
        candidate.admitted.push(...rows)
        entries.add(module.id)
        rows.forEach((row) => candidate.ids.add(row.id))
        module.clients.forEach((path) => candidate.clients.add(path))
        if (first) this.plugins.push(plugin)
        admitted(plugin, first)
      }
      subsetFunctionUiResolveRuntime(candidate.original, plugin.guest, candidate.admitted)
      if (!this.plugins.includes(plugin)) await candidate.original.dispose()
    }
  }

  assertClient(plugin: string, module: string): void {
    if (!this.gated) return
    if (
      !this.candidates.some(
        (item) =>
          item.plugin.name === plugin &&
          this.plugins.includes(item.plugin) &&
          item.clients.has(module)
      )
    )
      throw new ModFunctionError("MODS_CLIENT_MODULE_NOT_ADMITTED")
  }
}
