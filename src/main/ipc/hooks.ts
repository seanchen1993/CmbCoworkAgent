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
import { fireSetupMaintenance } from "../hooks/session-lifecycle"
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
const VALID_TYPES = new Set<HookType>(["command", "prompt", "http"])
const VALID_FALLBACKS = new Set<PromptHookFallback>(["allow", "block"])
const VALID_USER_CONTEXT_FIELDS = new Set([
  "sap_id",
  "yst_id",
  "name",
  "origin_org_id",
  "org_name",
  "path_name",
  "origin_path_id",
  "yst_id_token"
])

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
    throw new Error("无效的 Hook 类型，必须为 command / prompt / http")
  }

  if (hookType === "command") {
    if (!config.command || typeof config.command !== "string" || !config.command.trim()) {
      throw new Error("命令不能为空")
    }
  } else if (hookType === "http") {
    // PR-14 — URL is required and must look like http(s); no SSRF guard
    // (§13.2 decision 1). Headers / allowedEnvVars are shape-checked but the
    // content-level interpolation happens at runtime, not here.
    if (!config.url || typeof config.url !== "string" || !/^https?:\/\//i.test(config.url.trim())) {
      throw new Error("HTTP Hook 的 url 必须是 http(s):// 开头的字符串")
    }
    if (config.headers !== undefined) {
      if (typeof config.headers !== "object" || Array.isArray(config.headers)) {
        throw new Error("headers 必须为字符串到字符串的对象")
      }
      for (const [k, v] of Object.entries(config.headers)) {
        if (typeof k !== "string" || typeof v !== "string") {
          throw new Error("headers 必须为字符串到字符串的对象")
        }
      }
    }
    if (config.allowedEnvVars !== undefined) {
      if (!Array.isArray(config.allowedEnvVars)) {
        throw new Error("allowedEnvVars 必须为字符串数组")
      }
      for (const v of config.allowedEnvVars) {
        if (typeof v !== "string") throw new Error("allowedEnvVars 必须为字符串数组")
      }
    }
    if (config.fallback !== undefined && !VALID_FALLBACKS.has(config.fallback)) {
      throw new Error("fallback 必须为 allow 或 block")
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
  // PR-15
  if (config.async !== undefined && typeof config.async !== "boolean") {
    throw new Error("async 必须为布尔值")
  }
  if (config.event === "Setup" && config.async === true) {
    throw new Error("Setup Hook 必须同步执行，不能启用 async")
  }
  // PR-16
  if (config.if !== undefined && typeof config.if !== "string") {
    throw new Error("if 必须为字符串")
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
  if (config.injectUserContext !== undefined) {
    if (typeof config.injectUserContext !== "boolean") {
      if (
        !config.injectUserContext ||
        typeof config.injectUserContext !== "object" ||
        Array.isArray(config.injectUserContext)
      ) {
        throw new Error("injectUserContext 必须为布尔值或对象")
      }
      if (
        config.injectUserContext.enabled !== undefined &&
        typeof config.injectUserContext.enabled !== "boolean"
      ) {
        throw new Error("injectUserContext.enabled 必须为布尔值")
      }
      if (config.injectUserContext.include !== undefined) {
        if (!Array.isArray(config.injectUserContext.include)) {
          throw new Error("injectUserContext.include 必须为数组")
        }
        for (const field of config.injectUserContext.include) {
          if (!VALID_USER_CONTEXT_FIELDS.has(field)) {
            throw new Error(`injectUserContext.include 包含不支持的字段: ${field}`)
          }
        }
      }
    }
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

  // PR-11 — User-initiated Setup maintenance re-run (bypasses the
  // per-workspace init dedupe). UI exposes a "重新初始化工作区" button that
  // invokes this; the actual hook chain is owned by session-lifecycle.
  ipcMain.handle(
    "hooks:setup:maintenance",
    async (_event, workspacePath: string): Promise<void> => {
      if (!workspacePath) return
      await fireSetupMaintenance(workspacePath)
    }
  )
}
