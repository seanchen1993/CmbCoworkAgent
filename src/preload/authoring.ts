import type { AuthoringApi } from "../shared/mods/authoring"

export function createAuthoringBridge(
  invoke: (channel: string, payload: unknown) => Promise<unknown>
): AuthoringApi {
  return {
    prune: (input) => invoke("mods:authoring-prune", input) as ReturnType<AuthoringApi["prune"]>,
    remove: (input) => invoke("mods:authoring-remove", input) as ReturnType<AuthoringApi["remove"]>,
    list: (threadId) =>
      invoke("mods:authoring-list", { threadId }) as ReturnType<AuthoringApi["list"]>,
    read: (input) => invoke("mods:authoring-read", input) as ReturnType<AuthoringApi["read"]>,
    generate: (input) =>
      invoke("mods:authoring-generate", input) as ReturnType<AuthoringApi["generate"]>,
    save: (input) => invoke("mods:authoring-save", input) as ReturnType<AuthoringApi["save"]>,
    restore: (input) =>
      invoke("mods:authoring-restore", input) as ReturnType<AuthoringApi["restore"]>
  }
}
