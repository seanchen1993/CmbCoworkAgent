import type { ProjectFunctionSourceApi } from "../shared/project-runtime/function-source"
export function createNativeProjectSourceBridge(
  invoke: (channel: string, input: unknown) => Promise<unknown>,
  prefix: string
): ProjectFunctionSourceApi {
  const ipcRenderer = {
    invoke: <T>(channel: string, input: unknown): Promise<T> => invoke(channel, input) as Promise<T>
  }
  return {
    config: {
      configList: () => Promise.reject(Error("PROJECT_CONFIG_OPERATION_UNSUPPORTED")),
      configSet: () => Promise.reject(Error("PROJECT_CONFIG_OPERATION_UNSUPPORTED")),
      userConfig: (threadId: string, pluginId: string, expectedWorkspace?: string) =>
        ipcRenderer.invoke(`${prefix}:user-config`, {
          threadId,
          pluginId,
          ...(expectedWorkspace !== undefined ? { expectedWorkspace } : {})
        }),
      migrateUserConfig: (
        threadId: string,
        view: import("../shared/mods/v2/user-config-view").FunctionUserConfigView
      ) =>
        ipcRenderer.invoke(`${prefix}:user-config-migrate`, {
          threadId,
          pluginId: view.pluginId,
          digest: view.digest,
          migrationDigest: view.migration?.digest,
          revision: view.savedRevision,
          workspace: view.workspace
        }),
      saveSensitiveUserConfig: (
        threadId: string,
        view: import("../shared/mods/v2/user-config-view").FunctionUserConfigView,
        key: string,
        action: import("../shared/mods/v2/user-config-view").SensitiveFunctionUserConfigAction
      ) =>
        ipcRenderer.invoke(`${prefix}:user-config-secret-save`, {
          threadId,
          pluginId: view.pluginId,
          digest: view.digest,
          key,
          action,
          revision: view.savedRevision,
          workspace: view.workspace
        }),
      applyUserConfig: (
        threadId: string,
        view: import("../shared/mods/v2/user-config-view").FunctionUserConfigView
      ) =>
        ipcRenderer.invoke(`${prefix}:user-config-apply`, {
          threadId,
          pluginId: view.pluginId,
          digest: view.digest,
          revision: view.savedRevision,
          workspace: view.workspace
        }),
      reloadUserConfig: (
        threadId: string,
        view: import("../shared/mods/v2/user-config-view").FunctionUserConfigView
      ) =>
        ipcRenderer.invoke(`${prefix}:user-config-reload`, {
          threadId,
          pluginId: view.pluginId,
          digest: view.digest,
          revision: view.savedRevision,
          workspace: view.workspace
        }),
      pickUserConfigPath: (
        threadId: string,
        view: import("../shared/mods/v2/user-config-view").FunctionUserConfigView,
        key: string
      ) =>
        ipcRenderer.invoke(`${prefix}:user-config-pick-path`, {
          threadId,
          pluginId: view.pluginId,
          digest: view.digest,
          key,
          revision: view.savedRevision,
          workspace: view.workspace
        }),
      saveUserConfig: (
        threadId: string,
        view: import("../shared/mods/v2/user-config-view").FunctionUserConfigView,
        key: string,
        value: import("../shared/mods/v2/config").FunctionConfigValue
      ) =>
        ipcRenderer.invoke(`${prefix}:user-config-save`, {
          threadId,
          pluginId: view.pluginId,
          digest: view.digest,
          key,
          value,
          revision: view.savedRevision,
          workspace: view.workspace
        })
    },
    read: (projectId: string) => ipcRenderer.invoke(`${prefix}:mods-read`, projectId),
    approve: (
      input: Parameters<
        import("../shared/project-runtime/function-source").ProjectFunctionSourceApi["approve"]
      >[0]
    ) => ipcRenderer.invoke(`${prefix}:mods-approve`, input)
  }
}
