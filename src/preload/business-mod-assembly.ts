import type { BusinessModAssemblyApi } from "../shared/business-mod-assembly-api"

export function createBusinessModAssemblyBridge(
  invoke: (channel: string, input: unknown) => Promise<unknown>
): BusinessModAssemblyApi {
  const call =
    <K extends keyof BusinessModAssemblyApi>(method: K) =>
    (input: Parameters<BusinessModAssemblyApi[K]>[0]) =>
      invoke(`plugins:business-mods:${method}`, input) as ReturnType<BusinessModAssemblyApi[K]>
  return {
    sources: call("sources"),
    inspect: call("inspect"),
    preview: call("preview"),
    create: call("create"),
    list: call("list"),
    check: call("check"),
    install: call("install"),
    export: call("export")
  }
}
