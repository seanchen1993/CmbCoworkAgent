import type { FunctionConfigRow, FunctionConfigSetResult, FunctionConfigValue } from "./config"
import type { FunctionUserConfigView } from "./user-config-view"
import type { SensitiveFunctionUserConfigAction } from "./user-config-view"

export interface FunctionConfigApi {
  configList(threadId: string): Promise<FunctionConfigRow[]>
  configSet(
    threadId: string,
    key: string,
    value: FunctionConfigValue
  ): Promise<FunctionConfigSetResult>
  userConfig(threadId: string, pluginId: string, expectedWorkspace?: string): Promise<FunctionUserConfigView>
  saveSensitiveUserConfig(
    threadId: string,
    view: FunctionUserConfigView,
    key: string,
    action: SensitiveFunctionUserConfigAction
  ): Promise<FunctionUserConfigView>
  applyUserConfig(threadId: string, view: FunctionUserConfigView): Promise<FunctionUserConfigView>
  reloadUserConfig(threadId: string, view: FunctionUserConfigView): Promise<FunctionUserConfigView>
  pickUserConfigPath(
    threadId: string,
    view: FunctionUserConfigView,
    key: string
  ): Promise<string | undefined>
  saveUserConfig(
    threadId: string,
    view: FunctionUserConfigView,
    key: string,
    value: FunctionConfigValue
  ): Promise<FunctionUserConfigView>
}
