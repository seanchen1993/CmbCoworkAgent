import { IpcMain } from "electron"
import {
  getHooks,
  getEnabledSkillHookMetadata,
  upsertHook,
  deleteHook,
  setHookEnabled,
  getWorkspaceHooks,
  trustAllWorkspaceHooks,
  trustWorkspaceHookFile
} from "../storage"
import type { UntrustedWorkspaceHook } from "../storage"
import type { SkillHookMetadata } from "../types"
import { notifyHooksChanged } from "../hooks/notifications"
import {
  isSupportedHookEvent,
  SUPPORTED_HOOK_EVENTS,
  HookConfig,
  HookEvent,
  HookOnBlockConfig,
  HookType,
  PromptHookFallback,
  HookUpsert
} from "../hooks/types"

const VALID_EVENTS = new Set<HookEvent>(SUPPORTED_HOOK_EVENTS)
const VALID_TYPES = new Set<HookType>(["command", "prompt"])
const VALID_FALLBACKS = new Set<PromptHookFallback>(["allow", "block"])
const TIMEOUT_MIN = 1_000
const TIMEOUT_MAX = 60_000

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
    if (!Number.isInteger(t) || t < TIMEOUT_MIN || t > TIMEOUT_MAX) {
      throw new Error(`超时时间必须在 ${TIMEOUT_MIN}ms 到 ${TIMEOUT_MAX}ms 之间`)
    }
  }

  validateOnBlockConfig(config.onBlock)
}

export function registerHooksHandlers(ipcMain: IpcMain): void {
  console.log("[Hooks] Registering hooks IPC handlers...")

  ipcMain.handle("hooks:list", async (): Promise<HookConfig[]> => {
    return getHooks()
  })

  ipcMain.handle("hooks:skills:list", async (): Promise<SkillHookMetadata[]> => {
    return getEnabledSkillHookMetadata()
  })

  ipcMain.handle("hooks:create", async (_event, config: HookUpsert): Promise<{ id: string }> => {
    validateHookConfig(config)
    const id = upsertHook(config)
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
      notifyHooksChanged("global-hook-updated")
      return { id }
    }
  )

  ipcMain.handle("hooks:delete", async (_event, id: string): Promise<void> => {
    deleteHook(id)
    notifyHooksChanged("global-hook-deleted")
  })

  ipcMain.handle(
    "hooks:setEnabled",
    async (_event, { id, enabled }: { id: string; enabled: boolean }): Promise<void> => {
      setHookEnabled(id, enabled)
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
