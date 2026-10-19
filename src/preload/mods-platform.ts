import type { PlatformUiApi } from "../shared/mods/v2/platform-ui-api"

export function createPlatformBridge(
  invoke: (channel: string, input: unknown) => Promise<unknown>
): PlatformUiApi {
  return {
    platformSurfaceList: (threadId) =>
      invoke("mods:platform-surface-list", { threadId }) as ReturnType<
        PlatformUiApi["platformSurfaceList"]
      >,
    platformSurfaceRead: (threadId, address) =>
      invoke("mods:platform-surface-read", { threadId, address }) as ReturnType<
        PlatformUiApi["platformSurfaceRead"]
      >,
    platformSurfaceOpen: (threadId, address, intentId) =>
      invoke("mods:platform-surface-open", { threadId, address, intentId }) as ReturnType<
        PlatformUiApi["platformSurfaceOpen"]
      >,
    platformSurfaceAct: (threadId, address, action) =>
      invoke("mods:platform-surface-act", { threadId, address, action }) as Promise<void>,
    platformSurfaceClose: (threadId, address) =>
      invoke("mods:platform-surface-close", { threadId, address }) as Promise<void>,
    platformSurfaceDisable: (threadId, address) =>
      invoke("mods:platform-surface-disable", { threadId, address }) as Promise<void>,
    platformSurfaceEnable: (threadId, address) =>
      invoke("mods:platform-surface-enable", { threadId, address }) as Promise<void>,
    platformBehaviorList: (threadId) =>
      invoke("mods:platform-behavior-list", { threadId }) as ReturnType<
        PlatformUiApi["platformBehaviorList"]
      >,
    platformBehaviorPreview: (threadId, selected) =>
      invoke("mods:platform-behavior-preview", { threadId, selected }) as ReturnType<
        PlatformUiApi["platformBehaviorPreview"]
      >,
    platformBehaviorApply: (threadId, previewId, revision) =>
      invoke("mods:platform-behavior-apply", { threadId, previewId, revision }) as Promise<void>,
    platformBehaviorDisable: (threadId) =>
      invoke("mods:platform-behavior-disable", { threadId }) as Promise<void>
  }
}
