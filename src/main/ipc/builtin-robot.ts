import { BrowserWindow, type IpcMain } from "electron"
import type {
  BuiltinRobotGrantableFeature,
  BuiltinRobotRemoteAccessOverview,
  BuiltinRobotSettings,
  BuiltinRobotStatus
} from "../types"
import { builtinRobotManager } from "../services/im/manager"
import {
  imRemoteApprovalService,
  remoteApprovalDesktopNotice
} from "../services/im/remote-approval-service"
import {
  imRemoteUserInputService,
  type ImRemoteUserInputAnswerNotice
} from "../services/im/remote-user-input-service"

function broadcastStatus(status: BuiltinRobotStatus): void {
  for (const window of BrowserWindow.getAllWindows()) {
    if (!window.isDestroyed() && !window.webContents.isDestroyed()) {
      window.webContents.send("builtinRobot:status", status)
    }
  }
}

function broadcastRemoteApprovalAudit(
  record: Parameters<typeof remoteApprovalDesktopNotice>[0]
): void {
  const fullMessage = remoteApprovalDesktopNotice(record)
  const message =
    fullMessage.length <= 500
      ? fullMessage
      : `${fullMessage.slice(0, 500)}…（完整记录已写入对应会话）`
  for (const window of BrowserWindow.getAllWindows()) {
    if (!window.isDestroyed() && !window.webContents.isDestroyed()) {
      window.webContents.send(`agent:stream:${record.threadId}`, {
        type: "custom",
        data: { type: "hook_notice", message }
      })
    }
  }
}

function broadcastRemoteUserInputAnswer(notice: ImRemoteUserInputAnswerNotice): void {
  for (const window of BrowserWindow.getAllWindows()) {
    if (!window.isDestroyed() && !window.webContents.isDestroyed()) {
      window.webContents.send(`agent:stream:${notice.threadId}`, {
        type: "custom",
        data: { type: "hook_notice", message: notice.message }
      })
    }
  }
}

function settingsPatch(value: unknown): Partial<BuiltinRobotSettings> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("机器人设置无效")
  }
  const input = value as Record<string, unknown>
  const result: Partial<BuiltinRobotSettings> = {}
  if (typeof input.enabled === "boolean") result.enabled = input.enabled
  if (input.remoteAccess === "inbox-only" || input.remoteAccess === "inbox-and-features") {
    result.remoteAccess = input.remoteAccess
  }
  if (typeof input.remoteApprovalEnabled === "boolean") {
    result.remoteApprovalEnabled = input.remoteApprovalEnabled
  }
  if (Number.isSafeInteger(input.waitingDesktopTtlMinutes)) {
    result.waitingDesktopTtlMinutes = Number(input.waitingDesktopTtlMinutes)
  }
  return result
}

function nonEmptyString(value: unknown, label: string): string {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${label}无效`)
  return value.trim()
}

function remoteAccessToggle(value: unknown): { id: string; enabled: boolean } {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("远程授权参数无效")
  }
  const input = value as Record<string, unknown>
  if (typeof input.enabled !== "boolean") throw new Error("远程授权参数无效")
  return {
    id: nonEmptyString(input.id, "授权目标"),
    enabled: input.enabled
  }
}

function featureRemoteAccessToggle(value: unknown): {
  projectId: string
  featureSlug: string
  enabled: boolean
} {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Feature 授权参数无效")
  }
  const input = value as Record<string, unknown>
  if (typeof input.enabled !== "boolean") throw new Error("Feature 授权参数无效")
  return {
    projectId: nonEmptyString(input.projectId, "项目"),
    featureSlug: nonEmptyString(input.featureSlug, "Feature"),
    enabled: input.enabled
  }
}

let statusSubscriptionRegistered = false

export function registerBuiltinRobotHandlers(ipcMain: IpcMain): void {
  if (!statusSubscriptionRegistered) {
    statusSubscriptionRegistered = true
    builtinRobotManager.subscribe(broadcastStatus)
    imRemoteApprovalService.subscribeAudit(broadcastRemoteApprovalAudit)
    imRemoteUserInputService.subscribeAnswer(broadcastRemoteUserInputAnswer)
  }
  ipcMain.handle("builtinRobot:getStatus", (): BuiltinRobotStatus => {
    return builtinRobotManager.getStatus()
  })
  ipcMain.handle(
    "builtinRobot:getRemoteAccess",
    (): BuiltinRobotRemoteAccessOverview => builtinRobotManager.getRemoteAccessOverview()
  )
  ipcMain.handle(
    "builtinRobot:setThreadRemoteAccess",
    (_event, value: unknown): Promise<BuiltinRobotRemoteAccessOverview> => {
      const input = remoteAccessToggle(value)
      return builtinRobotManager.setThreadRemoteAccess(input.id, input.enabled)
    }
  )
  ipcMain.handle(
    "builtinRobot:setFeatureRemoteAccess",
    (_event, value: unknown): Promise<BuiltinRobotRemoteAccessOverview> => {
      const input = featureRemoteAccessToggle(value)
      return builtinRobotManager.setFeatureRemoteAccess(
        input.projectId,
        input.featureSlug,
        input.enabled
      )
    }
  )
  ipcMain.handle(
    "builtinRobot:listGrantableFeatures",
    (): Promise<BuiltinRobotGrantableFeature[]> => builtinRobotManager.listGrantableFeatures()
  )
  ipcMain.handle(
    "builtinRobot:saveSettings",
    (_event, updates: unknown): Promise<BuiltinRobotStatus> =>
      builtinRobotManager.updateSettings(settingsPatch(updates))
  )
  ipcMain.handle("builtinRobot:reconnect", (): Promise<BuiltinRobotStatus> => {
    return builtinRobotManager.reconnect()
  })
  ipcMain.handle("builtinRobot:disconnect", (): Promise<BuiltinRobotStatus> => {
    return builtinRobotManager.disconnect()
  })
  ipcMain.handle("builtinRobot:cleanupLegacy", (_event, input: unknown): BuiltinRobotStatus => {
    const confirmed =
      Boolean(input) &&
      typeof input === "object" &&
      !Array.isArray(input) &&
      (input as Record<string, unknown>).confirmed === true
    return builtinRobotManager.cleanupLegacyCredentials(confirmed)
  })
}
