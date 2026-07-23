import { BrowserWindow, type IpcMain } from "electron"
import type {
  BuiltinRobotSettings,
  BuiltinRobotStatus,
  BuiltinRobotTakeoverRequest,
  BuiltinRobotTakeoverResult
} from "../types"
import { builtinRobotManager } from "../services/im/manager"

function broadcastStatus(status: BuiltinRobotStatus): void {
  for (const window of BrowserWindow.getAllWindows()) {
    if (!window.isDestroyed() && !window.webContents.isDestroyed()) {
      window.webContents.send("builtinRobot:status", status)
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
  if (Number.isSafeInteger(input.waitingDesktopTtlMinutes)) {
    result.waitingDesktopTtlMinutes = Number(input.waitingDesktopTtlMinutes)
  }
  return result
}

function takeoverRequest(value: unknown): BuiltinRobotTakeoverRequest {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("接管参数无效")
  }
  const input = value as Record<string, unknown>
  if (
    typeof input.conversationKey !== "string" ||
    !input.conversationKey.trim() ||
    !Number.isSafeInteger(input.expectedDeviceEpoch) ||
    Number(input.expectedDeviceEpoch) < 1 ||
    (input.mode !== "normal" && input.mode !== "force")
  ) {
    throw new Error("接管参数无效")
  }
  return {
    conversationKey: input.conversationKey.trim(),
    expectedDeviceEpoch: Number(input.expectedDeviceEpoch),
    mode: input.mode
  }
}

let statusSubscriptionRegistered = false

export function registerBuiltinRobotHandlers(ipcMain: IpcMain): void {
  if (!statusSubscriptionRegistered) {
    statusSubscriptionRegistered = true
    builtinRobotManager.subscribe(broadcastStatus)
  }
  ipcMain.handle("builtinRobot:getStatus", (): BuiltinRobotStatus => {
    return builtinRobotManager.getStatus()
  })
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
  ipcMain.handle(
    "builtinRobot:takeover",
    (_event, request: unknown): Promise<BuiltinRobotTakeoverResult> =>
      builtinRobotManager.takeover(takeoverRequest(request))
  )
  ipcMain.handle("builtinRobot:cleanupLegacy", (_event, input: unknown): BuiltinRobotStatus => {
    const confirmed =
      Boolean(input) &&
      typeof input === "object" &&
      !Array.isArray(input) &&
      (input as Record<string, unknown>).confirmed === true
    return builtinRobotManager.cleanupLegacyCredentials(confirmed)
  })
}
