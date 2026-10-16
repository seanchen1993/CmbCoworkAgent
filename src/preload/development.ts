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
    setMode: (input) =>
      invoke("mods:development:set-mode", input) as ReturnType<DevelopmentApi["setMode"]>,
    approve: (input) =>
      invoke("mods:development:approve", input) as ReturnType<DevelopmentApi["approve"]>,
    stop: (input) => invoke("mods:development:stop", input) as ReturnType<DevelopmentApi["stop"]>,
    promote: (input) =>
      invoke("mods:development:promote", input) as ReturnType<DevelopmentApi["promote"]>,
    requestReuse: (input) =>
      invoke("mods:development:request-reuse", input) as ReturnType<DevelopmentApi["requestReuse"]>,
    approveReuse: (input) =>
      invoke("mods:development:approve-reuse", input) as ReturnType<DevelopmentApi["approveReuse"]>,
    undoComposition: (input) =>
      invoke("mods:development:undo-composition", input) as ReturnType<DevelopmentApi["undoComposition"]>,
    cancelComposition: (input) =>
      invoke("mods:development:cancel-composition", input) as ReturnType<DevelopmentApi["cancelComposition"]>,
    undoTrial: (input) =>
      invoke("mods:development:undo-trial", input) as ReturnType<DevelopmentApi["undoTrial"]>,
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
