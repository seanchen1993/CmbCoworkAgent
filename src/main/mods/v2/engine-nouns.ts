import { AsyncLocalStorage } from "node:async_hooks"
import type { ModJson, ModObject } from "../../../shared/mods/types"
import {
  MOD_TIERS,
  ModFunctionError,
  isModObject,
  matchesEventPattern,
  type FunctionInvocation
} from "../../../shared/mods/v2/contracts"
import { encodeModJson } from "../../../shared/mods/validation"
import type { FunctionPlugin } from "./dispatcher"

const validName = (name: string): boolean =>
  /^[a-z][a-zA-Z0-9_-]{0,79}$/.test(name) &&
  !["plugin", "__proto__", "constructor", "prototype"].includes(name)

export interface FunctionEngineProviderBinding {
  readonly plugin: FunctionPlugin
  readonly handle: string
  readonly method: string
}

/** Handles are meaningful only in the owning guest and this session's immutable fold. */
export class FunctionEngineNouns {
  private table?: ModObject
  private readonly providers = new Map<string, FunctionEngineProviderBinding>()
  private readonly delegates = new AsyncLocalStorage<readonly FunctionPlugin[]>()

  constructor(
    private readonly plugins: readonly FunctionPlugin[],
    private readonly assertLive: (plugin?: FunctionPlugin) => void,
    private readonly invocationContext: () => Pick<FunctionInvocation, "dispatchCutNs"> = () => ({})
  ) {}

  async build(signal: AbortSignal): Promise<void> {
    const chain = [...this.plugins]
      .sort((a, b) => MOD_TIERS.indexOf(a.tier) - MOD_TIERS.indexOf(b.tier))
      .flatMap((plugin) =>
        plugin.guest.registrations
          .filter((registration) => matchesEventPattern(registration.pattern, "engine.create"))
          .map((registration) => ({ plugin, registration }))
      )
    // With no fold, retain precisely the previous SDK surface and startup cost.
    if (!chain.length) return
    const core: ModObject = Object.create(null)
    for (const plugin of this.plugins)
      for (const capability of plugin.capabilities) {
        const [noun, method] = capability.split(".")
        if (!validName(noun) || !validName(method))
          throw new ModFunctionError("MODS_ENGINE_NOUN_INVALID")
        const descriptor = (core[noun] ??= { provider: "", methods: {} }) as ModObject
        const methods = descriptor.methods as ModObject
        methods[method] = "core"
      }
    const input = { plugins: this.plugins.map((plugin) => plugin.name) }
    const fold = async (index: number): Promise<ModObject> => {
      signal.throwIfAborted()
      if (index === chain.length) return core
      const { plugin, registration } = chain[index]
      this.assertLive(plugin)
      if (!(await plugin.guest.matches(registration.id, input))) return fold(index + 1)
      let beneath: Promise<ModObject> | undefined
      const answer = await plugin.guest.invoke(
        registration.id,
        input,
        async (method, args) => {
          this.assertLive(plugin)
          if (method !== "next")
            throw new ModFunctionError("MODS_ENGINE_BUILD_CALL", "MODS_ENGINE_BUILD_CALL", true)
          if (!isModObject(args) || !isModObject(args.input) || args.tier !== undefined)
            throw new ModFunctionError("MODS_ENGINE_BUILD_NEXT", "MODS_ENGINE_BUILD_NEXT", true)
          beneath ??= fold(index + 1)
          return { value: await beneath }
        },
        {
          event: "engine.create",
          origin: { plugin: "engine", tier: "core" },
          capabilities: [],
          plugin: { name: plugin.name, root: plugin.root },
          modelProtocol: plugin.modelProtocol ?? "result-v1",
          signal,
          ownBudgetMs: 0,
          ...this.invocationContext()
        }
      )
      const inherited = beneath ? await beneath : {}
      this.assertLive(plugin)
      if (!isModObject(answer.value)) throw new ModFunctionError("MODS_ENGINE_NOUN_INVALID")
      const result = answer.value
      if (Object.keys(result).length > 64) throw new ModFunctionError("MODS_ENGINE_NOUN_LIMIT")
      for (const [noun, descriptor] of Object.entries(result)) {
        if (!validName(noun) || !isModObject(descriptor) || !isModObject(descriptor.methods))
          throw new ModFunctionError("MODS_ENGINE_NOUN_INVALID")
        if (Object.hasOwn(inherited, noun)) {
          if (encodeModJson(descriptor) !== encodeModJson(inherited[noun]))
            throw new ModFunctionError(
              "MODS_ENGINE_NOUN_REPLACED",
              `MODS_ENGINE_NOUN_REPLACED: ${plugin.name}:${noun}`
            )
          continue
        }
        if (Object.hasOwn(core, noun)) throw new ModFunctionError("MODS_ENGINE_NOUN_REPLACED")
        if (
          descriptor.provider !== plugin.name ||
          Object.keys(descriptor).some((key) => !["provider", "methods"].includes(key)) ||
          Object.keys(descriptor.methods).length > 64 ||
          Object.entries(descriptor.methods).some(
            ([method, handle]) =>
              !validName(method) || typeof handle !== "string" || !/^\d{1,4}$/.test(handle)
          )
        )
          throw new ModFunctionError("MODS_ENGINE_NOUN_INVALID")
      }
      return result
    }
    // Never publish half a build. Runtime replacement creates an entirely new table.
    const table = await fold(0)
    const providers = new Map<string, FunctionEngineProviderBinding>()
    for (const [noun, descriptor] of Object.entries(table)) {
      if (!isModObject(descriptor) || descriptor.provider === "") continue
      const plugin = this.plugins.find(plugin => plugin.name === descriptor.provider)
      if (!plugin || !isModObject(descriptor.methods))
        throw new ModFunctionError("MODS_ENGINE_PROVIDER_UNAVAILABLE")
      for (const [name, handle] of Object.entries(descriptor.methods)) {
        if (typeof handle !== "string") throw new ModFunctionError("MODS_ENGINE_PROVIDER_UNAVAILABLE")
        const method = `${noun}.${name}`
        providers.set(method, Object.freeze({ plugin, handle, method }))
      }
    }
    this.assertLive()
    signal.throwIfAborted()
    this.table = table
    this.providers.clear()
    for (const [method, binding] of providers) this.providers.set(method, binding)
  }

  capabilities(plugin: FunctionPlugin): string[] {
    if (!this.table) return plugin.capabilities
    return [
      ...plugin.capabilities.filter((method) => Object.hasOwn(this.table!, method.split(".")[0])),
      ...Object.entries(this.table).flatMap(([noun, descriptor]) =>
        isModObject(descriptor) && descriptor.provider !== ""
          ? Object.keys(descriptor.methods as ModObject).map((method) => `${noun}.${method}`)
          : []
      )
    ]
  }

  assertAccess(plugin: FunctionPlugin, method: string): void {
    for (const active of [...(this.delegates.getStore() ?? []), plugin]) {
      this.assertLive(active)
      if (!this.capabilities(active).includes(method))
        throw new ModFunctionError("MODS_CAPABILITY_DENIED", "MODS_CAPABILITY_DENIED", true)
    }
  }

  provider(method: string): FunctionEngineProviderBinding | undefined {
    const [noun, name] = method.split(".")
    const descriptor = this.table?.[noun]
    if (!isModObject(descriptor) || descriptor.provider === "") return undefined
    const plugin = this.plugins.find((plugin) => plugin.name === descriptor.provider)
    const handle = (descriptor.methods as ModObject)[name]
    if (!plugin || typeof handle !== "string")
      throw new ModFunctionError("MODS_ENGINE_PROVIDER_UNAVAILABLE")
    const binding = this.providers.get(method)
    if (!binding || binding.plugin !== plugin || binding.handle !== handle)
      throw new ModFunctionError("MODS_ENGINE_PROVIDER_UNAVAILABLE")
    return binding
  }

  async delegated<T>(caller: FunctionPlugin, run: () => Promise<T>): Promise<T> {
    const parents = this.delegates.getStore() ?? []
    if (parents.length >= 16) throw new ModFunctionError("MODS_DISPATCH_DEPTH")
    return this.delegates.run([...parents, caller], run)
  }

  async invoke(
    caller: FunctionPlugin,
    method: string,
    input: ModObject,
    signal: AbortSignal,
    capability: (
      plugin: FunctionPlugin,
      method: string,
      args: ModJson,
      signal: AbortSignal,
      provider: FunctionEngineProviderBinding
    ) => Promise<ModJson | undefined>
  ): Promise<ModJson | undefined> {
    const provider = this.provider(method)
    if (!provider) throw new ModFunctionError("MODS_ENGINE_PROVIDER_UNAVAILABLE")
    this.assertAccess(caller, method)
    this.assertLive(provider.plugin)
    const result = await provider.plugin.guest.invoke(
      "provider",
      input,
      async (nestedMethod, args, nestedSignal) => {
        this.assertAccess(provider.plugin, nestedMethod)
        const value = await capability(provider.plugin, nestedMethod, args, nestedSignal, provider)
        return value === undefined ? {} : { value }
      },
      {
        event: method,
        origin: { plugin: caller.name, tier: caller.tier },
        provider: provider.handle,
        capabilities: this.capabilities(provider.plugin),
        plugin: { name: provider.plugin.name, root: provider.plugin.root },
        modelProtocol: provider.plugin.modelProtocol ?? "result-v1",
        signal,
        timeoutMs: 120000,
        ...this.invocationContext()
      }
    )
    this.assertAccess(caller, method)
    this.assertLive(provider.plugin)
    signal.throwIfAborted()
    return result.value
  }
}
