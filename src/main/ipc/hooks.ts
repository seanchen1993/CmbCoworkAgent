import { IpcMain, shell } from "electron"
import {
  getHooks,
  getEnabledSkillHookMetadata,
  getHookLoggingConfig,
  getHookLogDir,
  saveHookLoggingConfig,
  upsertHook,
  deleteHook,
  setHookEnabled,
  getWorkspaceHooks,
  trustAllWorkspaceHooks,
  trustWorkspaceHookFile
} from "../storage"
import type { UntrustedWorkspaceHook } from "../storage"
import type { HookLoggingConfig, SkillHookMetadata } from "../types"
import { notifyHookLoggingChanged, notifyHooksChanged } from "../hooks/notifications"
import { clearOnceStateForHook } from "../hooks/runner"
import {
  isSupportedHookEvent,
  SUPPORTED_HOOK_EVENTS,
  HookConfig,
  HookEvent,
  HookOnBlockConfig,
  HookType,
  PromptHookFallback,
  HookUpsert,
  getTimeoutBounds
} from "../hooks/types"

const VALID_EVENTS = new Set<HookEvent>(SUPPORTED_HOOK_EVENTS)
const VALID_TYPES = new Set<HookType>(["command", "prompt"])
const VALID_FALLBACKS = new Set<PromptHookFallback>(["allow", "block"])

function validateOnBlockConfig(onBlock: HookOnBlockConfig | undefined): void {
  if (onBlock === undefined) return
  if (!onBlock || typeof onBlock !== "object" || Array.isArray(onBlock)) {
    throw new Error("onBlock 必须为对象")
  }

  const fields: Array<keyof HookOnBlockConfig> = [
    "reason",
    "systemMessage",
    "additionalContext",
    "requiredSkill"
  ]
  for (const field of fields) {
    const value = onBlock[field]
    if (value !== undefined && typeof value !== "string") {
      throw new Error(`onBlock.${field} 必须为字符串`)
    }
  }
}

function validateHookConfig(config: HookUpsert): void {
  if (!config.event || !isSupportedHookEvent(config.event) || !VALID_EVENTS.has(config.event)) {
    throw new Error("无效的事件类型")
  }

  const hookType = config.type ?? "command"
  if (!VALID_TYPES.has(hookType)) {
    throw new Error("无效的 Hook 类型，必须为 command 或 prompt")
  }

  if (hookType === "command") {
    if (!config.command || typeof config.command !== "string" || !config.command.trim()) {
      throw new Error("命令不能为空")
    }
  } else {
    // prompt hook
    if (!config.prompt || typeof config.prompt !== "string" || !config.prompt.trim()) {
      throw new Error("策略描述不能为空")
    }
    if (config.fallback !== undefined && !VALID_FALLBACKS.has(config.fallback)) {
      throw new Error("fallback 必须为 allow 或 block")
    }
  }

  if (config.timeout !== undefined) {
    const t = config.timeout
    // PR-13a: bounds depend on handler type + (future) async flag. The async
    // field doesn't exist on HookUpsert yet (PR-15 adds it); read defensively
    // so this code keeps working unchanged when that lands.
    const isAsync = (config as { async?: boolean }).async === true
    const bounds = getTimeoutBounds(config.type, isAsync)
    if (!Number.isInteger(t) || t < bounds.min || t > bounds.max) {
      throw new Error(
        `超时时间必须在 ${bounds.min}ms 到 ${bounds.max}ms 之间（${config.type ?? "command"}${
          isAsync ? "/async" : "/sync"
        }）`
      )
    }
  }

  // PR-13b — new optional fields
  if (config.shell !== undefined && !["bash", "powershell", "sh"].includes(config.shell)) {
    throw new Error("shell 必须为 bash / powershell / sh")
  }
  if (config.statusMessage !== undefined && typeof config.statusMessage !== "string") {
    throw new Error("statusMessage 必须为字符串")
  }
  if (config.model !== undefined && typeof config.model !== "string") {
    throw new Error("model 必须为字符串")
  }

  validateOnBlockConfig(config.onBlock)

  if (
    config.forcedOutcome !== undefined &&
    config.forcedOutcome !== "always-revise" &&
    config.forcedOutcome !== "always-halt"
  ) {
    throw new Error("forcedOutcome 必须为 always-revise 或 always-halt")
  }
  if (config.forcedReason !== undefined && typeof config.forcedReason !== "string") {
    throw new Error("forcedReason 必须为字符串")
  }
  if (config.persistAfterInterrupt !== undefined && typeof config.persistAfterInterrupt !== "boolean") {
    throw new Error("persistAfterInterrupt 必须为布尔值")
  }
}

export function registerHooksHandlers(ipcMain: IpcMain): void {
  console.log("[Hooks] Registering hooks IPC handlers...")

  ipcMain.handle("hooks:list", async (): Promise<HookConfig[]> => {
    return getHooks()
  })

  ipcMain.handle("hooks:logging:get", async (): Promise<HookLoggingConfig> => {
    return getHookLoggingConfig()
  })

  ipcMain.handle(
    "hooks:logging:save",
    async (_event, updates: Partial<HookLoggingConfig>): Promise<HookLoggingConfig> => {
      const sanitized: Partial<HookLoggingConfig> = {}
      if (typeof updates?.enabled === "boolean") sanitized.enabled = updates.enabled
      if (typeof updates?.diagnostic === "boolean") sanitized.diagnostic = updates.diagnostic
      const updated = saveHookLoggingConfig(sanitized)
      notifyHookLoggingChanged(updated)
      return updated
    }
  )

  ipcMain.handle("hooks:logging:getLogDir", async (): Promise<string> => {
    return getHookLogDir()
  })

  ipcMain.handle("hooks:logging:openLogDir", async (): Promise<{ success: boolean; error?: string }> => {
    try {
      const result = await shell.openPath(getHookLogDir())
      if (result) return { success: false, error: result }
      return { success: true }
    } catch (e) {
      return { success: false, error: e instanceof Error ? e.message : String(e) }
    }
  })

  ipcMain.handle("hooks:skills:list", async (): Promise<SkillHookMetadata[]> => {
    return getEnabledSkillHookMetadata()
  })

  ipcMain.handle("hooks:create", async (_event, config: HookUpsert): Promise<{ id: string }> => {
    validateHookConfig(config)
    const id = upsertHook(config)
    // Fresh hook id, no prior state to clear, but stay symmetric for clarity.
    clearOnceStateForHook(id)
    notifyHooksChanged("global-hook-created")
    return { id }
  })

  ipcMain.handle(
    "hooks:update",
    async (_event, config: HookUpsert & { id: string }): Promise<{ id: string }> => {
      if (!config.id) {
        throw new Error("Hook ID 不能为空")
      }
      validateHookConfig(config)
      const id = upsertHook(config)
      // Hook content may have changed (command, matcher, once flag, …) — drop
      // stale once-fired entries so the next match runs the new definition.
      clearOnceStateForHook(id)
      notifyHooksChanged("global-hook-updated")
      return { id }
    }
  )

  ipcMain.handle("hooks:delete", async (_event, id: string): Promise<void> => {
    deleteHook(id)
    clearOnceStateForHook(id)
    notifyHooksChanged("global-hook-deleted")
  })

  ipcMain.handle(
    "hooks:setEnabled",
    async (_event, { id, enabled }: { id: string; enabled: boolean }): Promise<void> => {
      setHookEnabled(id, enabled)
      // Toggle is treated as "fresh start" — disable→enable resets once. Aligns
      // with CC's register/unregister semantics (where enable = re-register).
      clearOnceStateForHook(id)
      notifyHooksChanged("global-hook-enabled-changed")
    }
  )

  // ── Workspace Hooks ──

  ipcMain.handle(
    "hooks:workspace:list",
    async (_event, workspacePath: string): Promise<HookConfig[]> => {
      if (!workspacePath) return []
      return getWorkspaceHooks(workspacePath)
    }
  )

  ipcMain.handle("hooks:workspace:untrusted", async (): Promise<UntrustedWorkspaceHook[]> => {
    // Workspace command hooks are now trusted by default — always return empty.
    return []
  })

  ipcMain.handle(
    "hooks:workspace:trustAll",
    async (_event, workspacePath: string): Promise<void> => {
      if (!workspacePath) return
      trustAllWorkspaceHooks(workspacePath)
    }
  )

  ipcMain.handle(
    "hooks:workspace:trustFile",
    async (
      _event,
      {
        workspacePath,
        fileName,
        filePath
      }: { workspacePath: string; fileName: string; filePath: string }
    ): Promise<void> => {
      if (!workspacePath || !fileName || !filePath) return
      trustWorkspaceHookFile(workspacePath, fileName, filePath)
    }
  )
}
