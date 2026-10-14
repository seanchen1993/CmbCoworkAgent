import type { DevelopmentApi } from "../shared/mods/development"

export function createDevelopmentBridge(
  invoke: (channel: string, input: unknown) => Promise<unknown>,
  subscribe: (channel: string, callback: (payload: unknown) => void) => () => void
): DevelopmentApi {
  return {
    status: (input) =>
      invoke("mods:development:status", input) as ReturnType<DevelopmentApi["status"]>,
    setEnabled: (input) =>
      invoke("mods:development:set-enabled", input) as ReturnType<DevelopmentApi["setEnabled"]>,
    approve: (input) =>
      invoke("mods:development:approve", input) as ReturnType<DevelopmentApi["approve"]>,
    stop: (input) => invoke("mods:development:stop", input) as ReturnType<DevelopmentApi["stop"]>,
    promote: (input) =>
      invoke("mods:development:promote", input) as ReturnType<DevelopmentApi["promote"]>,
    onChanged: (callback) =>
      subscribe("mods:development-changed", (value) => {
        if (
          value &&
          typeof value === "object" &&
          "threadId" in value &&
          typeof value.threadId === "string"
        )
          callback({ threadId: value.threadId })
      })
  }
}
