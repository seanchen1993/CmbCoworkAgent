import type { AuthoringPreviewApi } from "../shared/mods/authoring-preview"
export function createAuthoringPreviewBridge(
  invoke: (channel: string, payload: unknown) => Promise<unknown>
): AuthoringPreviewApi {
  return {
    start: (input) =>
      invoke("mods:authoring-preview-start", input) as ReturnType<AuthoringPreviewApi["start"]>,
    cancel: async (input) => {
      await invoke("mods:authoring-preview-cancel", input)
    }
  }
}
