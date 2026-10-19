import type { IpcMain, IpcMainInvokeEvent } from "electron"
import { isModObject, ModFunctionError } from "../../shared/mods/v2/contracts"
import { isFunctionConfigValue } from "../../shared/mods/v2/config"
import type { FunctionModsManager } from "../mods/v2/manager"
import { currentNativeConfigurationScope } from "../mods/v2/native-configuration-scope"

export function registerFunctionConfigHandlers(
  ipc: IpcMain,
  defaultManager: FunctionModsManager | undefined,
  scope: (event: IpcMainInvokeEvent, threadId: string) => string,
  choose?: (event: IpcMainInvokeEvent, kind: "file" | "directory") => Promise<string | undefined>,
  confirmMigration?: (
    event: IpcMainInvokeEvent,
    view: import("../../shared/mods/v2/user-config-view").FunctionUserConfigView
  ) => Promise<boolean>,
  captureNativeScope?: (event: IpcMainInvokeEvent, threadId: string) => () => void,
  route?: {
    prefix: string
    invoke(
      event: IpcMainInvokeEvent,
      input: unknown,
      run: (manager: FunctionModsManager) => unknown
    ): unknown
  }
): void {
  const handle = <T>(
    channel: string,
    handler: (event: IpcMainInvokeEvent, input: T, manager: FunctionModsManager) => unknown
  ) => {
    ipc.handle(route ? channel.replace("mods:", route.prefix) : channel, (event, input) =>
      route
        ? route.invoke(event, input, (manager) => handler(event, input, manager))
        : handler(event, input, defaultManager!)
    )
  }
  const access = (event: IpcMainInvokeEvent, threadId: string) => {
    if (typeof threadId !== "string" || !threadId)
      throw new ModFunctionError("MODS_CONFIG_ARGUMENTS")
    const workspace = scope(event, threadId)
    const assertCaptured = captureNativeScope?.(event, threadId)
    const controller = new AbortController()
    const guard = () => {
      assertCaptured?.()
      if (scope(event, threadId) !== workspace)
        throw new ModFunctionError("MODS_CONFIG_SCOPE_CHANGED")
    }
    return { workspace, signal: controller.signal, guard }
  }
  handle("mods:config-list", async (event, threadId: string, manager) => {
    const a = access(event, threadId)
    return manager.configList(a.workspace, threadId, a.signal, a.guard)
  })
  handle("mods:config-set", async (event, input: unknown, manager) => {
    if (
      !isModObject(input) ||
      typeof input.threadId !== "string" ||
      typeof input.key !== "string" ||
      !input.key ||
      !isFunctionConfigValue(input.value) ||
      Object.keys(input).some((key) => !["threadId", "key", "value"].includes(key))
    )
      throw new ModFunctionError("MODS_CONFIG_ARGUMENTS")
    const a = access(event, input.threadId)
    return manager.configSet(
      a.workspace,
      input.threadId,
      input.key,
      input.value,
      { kind: "composer" },
      a.signal,
      a.guard
    )
  })
  handle("mods:user-config", async (event, input: unknown, manager) => {
    if (
      !isModObject(input) ||
      typeof input.threadId !== "string" ||
      typeof input.pluginId !== "string" ||
      !input.pluginId ||
      (input.expectedWorkspace !== undefined && typeof input.expectedWorkspace !== "string") ||
      Object.keys(input).some((key) => !["threadId", "pluginId", "expectedWorkspace"].includes(key))
    )
      throw new ModFunctionError("MODS_CONFIG_ARGUMENTS")
    const a = access(event, input.threadId)
    if (input.expectedWorkspace !== undefined && input.expectedWorkspace !== a.workspace)
      throw new ModFunctionError("MODS_CONFIG_SCOPE_CHANGED")
    return manager.userConfig(a.workspace, input.threadId, input.pluginId, a.signal, a.guard)
  })
  handle("mods:user-config-migrate", async (event, input: unknown, manager) => {
    if (
      !isModObject(input) ||
      typeof input.threadId !== "string" ||
      typeof input.pluginId !== "string" ||
      !input.pluginId ||
      typeof input.workspace !== "string" ||
      !input.workspace ||
      typeof input.digest !== "string" ||
      !/^[a-f0-9]{64}$/.test(input.digest) ||
      typeof input.migrationDigest !== "string" ||
      !/^[a-f0-9]{64}$/.test(input.migrationDigest) ||
      !Number.isSafeInteger(input.revision) ||
      Number(input.revision) < 0 ||
      Object.keys(input).some(
        (key) =>
          !["threadId", "pluginId", "workspace", "digest", "migrationDigest", "revision"].includes(
            key
          )
      )
    )
      throw new ModFunctionError("MODS_CONFIG_ARGUMENTS")
    const a = access(event, input.threadId),
      frame = event.sender.mainFrame
    const guard = () => {
      a.guard()
      if (event.sender.isDestroyed() || event.sender.mainFrame !== frame)
        throw new ModFunctionError("MODS_CONFIG_SCOPE_CHANGED")
    }
    if (input.workspace !== a.workspace) throw new ModFunctionError("MODS_CONFIG_SCOPE_CHANGED")
    const view = await manager.userConfig(
      a.workspace,
      input.threadId,
      input.pluginId,
      a.signal,
      guard
    )
    if (
      view.digest !== input.digest ||
      view.savedRevision !== input.revision ||
      view.migration?.digest !== input.migrationDigest ||
      !view.migration.canApply
    )
      throw new ModFunctionError("MODS_USER_CONFIG_MIGRATION_CHANGED")
    if (!confirmMigration)
      throw new ModFunctionError("MODS_USER_CONFIG_MIGRATION_CONFIRMATION_REQUIRED")
    const nativeContent = currentNativeConfigurationScope()?.assertContentCurrent
    guard(); nativeContent?.()
    const confirmed = await confirmMigration(event, view)
    guard(); nativeContent?.()
    if (!confirmed) return view
    return manager.migrateUserConfig(
      a.workspace,
      input.threadId,
      input.pluginId,
      input.digest,
      Number(input.revision),
      input.migrationDigest,
      a.signal,
      guard
    )
  })
  handle("mods:user-config-save", async (event, input: unknown, manager) => {
    if (
      !isModObject(input) ||
      typeof input.threadId !== "string" ||
      typeof input.pluginId !== "string" ||
      !input.pluginId ||
      typeof input.digest !== "string" ||
      !input.digest ||
      typeof input.key !== "string" ||
      typeof input.workspace !== "string" ||
      !input.workspace ||
      !isFunctionConfigValue(input.value) ||
      !Number.isSafeInteger(input.revision) ||
      Number(input.revision) < 0 ||
      Object.keys(input).some(
        (key) =>
          !["threadId", "pluginId", "digest", "key", "value", "revision", "workspace"].includes(key)
      )
    )
      throw new ModFunctionError("MODS_CONFIG_ARGUMENTS")
    const a = access(event, input.threadId)
    if (input.workspace !== a.workspace) throw new ModFunctionError("MODS_CONFIG_SCOPE_CHANGED")
    return manager.saveUserConfig(
      a.workspace,
      input.threadId,
      input.pluginId,
      input.digest,
      input.key,
      input.value,
      Number(input.revision),
      a.signal,
      a.guard
    )
  })
  handle("mods:user-config-secret-save", async (event, input: unknown, manager) => {
    if (
      !isModObject(input) ||
      typeof input.threadId !== "string" ||
      typeof input.pluginId !== "string" ||
      !input.pluginId ||
      typeof input.digest !== "string" ||
      !input.digest ||
      typeof input.key !== "string" ||
      !input.key ||
      typeof input.workspace !== "string" ||
      !input.workspace ||
      !Number.isSafeInteger(input.revision) ||
      Number(input.revision) < 0 ||
      !isModObject(input.action) ||
      (input.action.operation !== "set" && input.action.operation !== "clear") ||
      (input.action.operation === "set"
        ? !isFunctionConfigValue(input.action.value) ||
          Object.keys(input.action).some((key) => !["operation", "value"].includes(key))
        : Object.keys(input.action).some((key) => key !== "operation")) ||
      Object.keys(input).some(
        (key) =>
          !["threadId", "pluginId", "digest", "key", "workspace", "revision", "action"].includes(
            key
          )
      )
    )
      throw new ModFunctionError("MODS_CONFIG_ARGUMENTS")
    const a = access(event, input.threadId)
    if (input.workspace !== a.workspace) throw new ModFunctionError("MODS_CONFIG_SCOPE_CHANGED")
    const controller = new AbortController()
    const lost = () => controller.abort(new ModFunctionError("MODS_CONFIG_SCOPE_CHANGED"))
    event.sender.once("destroyed", lost)
    try {
      return await manager.saveSensitiveUserConfig(
        a.workspace,
        input.threadId,
        input.pluginId,
        input.digest,
        input.key,
        input.action as import("../../shared/mods/v2/user-config-view").SensitiveFunctionUserConfigAction,
        Number(input.revision),
        controller.signal,
        a.guard
      )
    } finally {
      event.sender.removeListener("destroyed", lost)
    }
  })
  handle("mods:user-config-pick-path", async (event, input: unknown, manager) => {
    if (
      !isModObject(input) ||
      typeof input.threadId !== "string" ||
      typeof input.pluginId !== "string" ||
      !input.pluginId ||
      typeof input.digest !== "string" ||
      !input.digest ||
      typeof input.key !== "string" ||
      !input.key ||
      typeof input.workspace !== "string" ||
      !input.workspace ||
      !Number.isSafeInteger(input.revision) ||
      Number(input.revision) < 0 ||
      Object.keys(input).some(
        (key) => !["threadId", "pluginId", "digest", "key", "workspace", "revision"].includes(key)
      )
    )
      throw new ModFunctionError("MODS_CONFIG_ARGUMENTS")
    const a = access(event, input.threadId)
    if (a.workspace !== input.workspace) throw new ModFunctionError("MODS_CONFIG_SCOPE_CHANGED")
    if (!choose) throw new ModFunctionError("MODS_CONFIG_PATH_UNAVAILABLE")
    const controller = new AbortController()
    const lost = () => controller.abort(new ModFunctionError("MODS_CONFIG_SCOPE_CHANGED"))
    event.sender.once("destroyed", lost)
    try {
      return await manager.pickUserConfigPath(
        a.workspace,
        input.threadId,
        input.pluginId,
        input.digest,
        input.key,
        Number(input.revision),
        controller.signal,
        a.guard,
        (kind) => choose(event, kind)
      )
    } finally {
      event.sender.removeListener("destroyed", lost)
    }
  })
  const application =
    (reload: boolean) =>
    async (event: IpcMainInvokeEvent, input: unknown, manager: FunctionModsManager) => {
      if (
        !isModObject(input) ||
        typeof input.threadId !== "string" ||
        typeof input.pluginId !== "string" ||
        !input.pluginId ||
        typeof input.digest !== "string" ||
        !input.digest ||
        typeof input.workspace !== "string" ||
        !input.workspace ||
        !Number.isSafeInteger(input.revision) ||
        Number(input.revision) < 0 ||
        Object.keys(input).some(
          (key) => !["threadId", "pluginId", "digest", "workspace", "revision"].includes(key)
        )
      )
        throw new ModFunctionError("MODS_CONFIG_ARGUMENTS")
      const a = access(event, input.threadId)
      if (input.workspace !== a.workspace) throw new ModFunctionError("MODS_CONFIG_SCOPE_CHANGED")
      const controller = new AbortController()
      const lost = () => controller.abort(new ModFunctionError("MODS_CONFIG_SCOPE_CHANGED"))
      if (reload) event.sender.once("destroyed", lost)
      try {
        return await (reload ? manager.reloadUserConfig : manager.applyUserConfig).call(
          manager,
          a.workspace,
          input.threadId,
          input.pluginId,
          input.digest,
          Number(input.revision),
          reload ? controller.signal : a.signal,
          a.guard
        )
      } finally {
        if (reload) event.sender.removeListener("destroyed", lost)
      }
    }
  handle("mods:user-config-apply", application(false))
  handle("mods:user-config-reload", application(true))
}
