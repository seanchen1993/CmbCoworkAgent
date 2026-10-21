import type { PreparePluginStartUse } from "../shared/plugin-start-use"

export function createPluginStartUseBridge(
  invoke: (channel: string, input: unknown) => Promise<unknown>
) {
  return {
    prepareStartUse: ((input) => invoke("plugins:prepareStartUse", input)) as PreparePluginStartUse,
    enableStartUse: ((input) => invoke("plugins:enableStartUse", input)) as PreparePluginStartUse
  }
}
