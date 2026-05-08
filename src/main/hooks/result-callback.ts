import { BrowserWindow, type WebContents } from "electron"
import type { HookResultCallback } from "./runner"
import type { HookConfig, HookEvent, HookResult } from "./types"

const MAX_STDOUT_PREVIEW_CHARS = 4_000
const MAX_STDERR_PREVIEW_CHARS = 8_000
const MAX_ADDITIONAL_CONTEXT_PREVIEW_CHARS = 4_000

function truncatePreview(text: string | undefined, maxChars: number): string {
  if (!text) return ""
  if (text.length <= maxChars) return text
  return `${text.slice(0, maxChars)}\n...[truncated ${text.length - maxChars} chars]`
}

function sendHookResult(
  webContents: WebContents,
  channel: string,
  event: HookEvent,
  hook: HookConfig,
  result: HookResult
): void {
  if (webContents.isDestroyed()) return

  const hookType = hook.type ?? "command"
  const label =
    hookType === "command" ? (hook.command ?? "").slice(0, 60) : (hook.prompt ?? "").slice(0, 60)
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
      stdout: truncatePreview(result.stdout, MAX_STDOUT_PREVIEW_CHARS),
      stderr: truncatePreview(result.stderr, MAX_STDERR_PREVIEW_CHARS),
      additionalContext: truncatePreview(
        result.additionalContext,
        MAX_ADDITIONAL_CONTEXT_PREVIEW_CHARS
      ),
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
