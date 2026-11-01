import type { DeveloperEditorApi, DeveloperEditorEvent } from "../shared/mods/v2/developer-editor"

/** Fixed native navigation channels only; no arbitrary IPC, sender or launch arguments. */
export function createEditorNavigationBridge(
  invoke: (channel: string, input: unknown) => Promise<unknown>,
  subscribe: (callback: (event: DeveloperEditorEvent) => void) => () => void
): DeveloperEditorApi {
  return {
    editorNavigationAccept: (id) =>
      invoke("mods:editor-navigation-accept", { id }) as ReturnType<
        DeveloperEditorApi["editorNavigationAccept"]
      >,
    editorNavigationAck: (ack) => invoke("mods:editor-navigation-ack", ack) as Promise<void>,
    editorNavigationClose: (id) => invoke("mods:editor-navigation-close", { id }) as Promise<void>,
    editorNavigationLaunchExternal: (id) =>
      invoke("mods:editor-navigation-launch-external", { id }) as ReturnType<
        DeveloperEditorApi["editorNavigationLaunchExternal"]
      >,
    onEditorNavigation: subscribe
  }
}
