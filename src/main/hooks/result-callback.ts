import { BrowserWindow, type WebContents } from "electron"
import type { HookResultCallback } from "./runner"
import type { HookConfig, HookEvent, HookResult } from "./types"

function sendHookResult(webContents: WebContents, channel: string, event: HookEvent, hook: HookConfig, result: HookResult): void {
  if (webContents.isDestroyed()) return

  const hookType = hook.type ?? "command"
  const label = hookType === "command"
    ? (hook.command ?? "").slice(0, 60)
    : (hook.prompt ?? "").slice(0, 60)
  const toolSuffix = hook.matcher && hook.matcher !== "*" ? `/${hook.matcher}` : ""

  webContents.send(channel, {
    type: "custom",
    data: {
      type: "hook_executed",
      event,
      hookType,
      label,
      toolSuffix,
      exitCode: result.exitCode,
      blocked: result.blocked,
      decision: result.decision,
      stdout: result.stdout?.slice(0, 500) ?? "",
      stderr: result.stderr?.slice(0, 200) ?? "",
      systemMessage: result.systemMessage
    }
  })
}

export function makeHookResultCallback(window: BrowserWindow, channel: string): HookResultCallback {
  return (event: HookEvent, hook: HookConfig, result: HookResult): void => {
    if (window.isDestroyed()) return
    sendHookResult(window.webContents, channel, event, hook, result)
  }
}

export function makeBroadcastHookResultCallback(channel: string): HookResultCallback {
  return (event: HookEvent, hook: HookConfig, result: HookResult): void => {
    for (const window of BrowserWindow.getAllWindows()) {
      if (window.isDestroyed()) continue
      sendHookResult(window.webContents, channel, event, hook, result)
    }
  }
}
