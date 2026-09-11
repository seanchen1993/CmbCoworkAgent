// Relative (not "@/") so this module stays importable from unit tests that
// don't resolve the "@/" path alias for runtime values.
import {
  BUILTIN_BROWSER_NO_SCREENSHOT_PROMPT_PREFIX,
  BUILTIN_BROWSER_PROMPT_PREFIX
} from "../../../../shared/user-input-transport"

export { BUILTIN_BROWSER_NO_SCREENSHOT_PROMPT_PREFIX, BUILTIN_BROWSER_PROMPT_PREFIX }

export const BUILTIN_BROWSER_COMMAND_ID = "builtin-browser"
const LEGACY_BUILTIN_BROWSER_PROMPT_PREFIX =
  "使用内置浏览器 browser_*工具。仅当当前模型支持图片识别/视觉输入时，才允许调用截图工具；否则不要调用截图工具，改用 DOM 快照、文本、locator、evaluate 等非视觉方式："
export const BUILTIN_BROWSER_SCREENSHOT_DISABLED_PROMPT = "（不允许使用截图功能）"

let builtinBrowserScreenshotEnabled = false
const builtinBrowserScreenshotListeners = new Set<() => void>()

export function isBuiltinBrowserScreenshotEnabled(): boolean {
  return builtinBrowserScreenshotEnabled
}

export function setBuiltinBrowserScreenshotEnabled(enabled: boolean): void {
  if (builtinBrowserScreenshotEnabled === enabled) return
  builtinBrowserScreenshotEnabled = enabled
  for (const listener of builtinBrowserScreenshotListeners) listener()
}

export function subscribeBuiltinBrowserScreenshot(listener: () => void): () => void {
  builtinBrowserScreenshotListeners.add(listener)
  return () => builtinBrowserScreenshotListeners.delete(listener)
}

export function getBuiltinBrowserPromptPrefix(
  screenshotEnabled = isBuiltinBrowserScreenshotEnabled()
): string {
  return screenshotEnabled
    ? BUILTIN_BROWSER_PROMPT_PREFIX
    : BUILTIN_BROWSER_NO_SCREENSHOT_PROMPT_PREFIX
}

export const BUILTIN_BROWSER_COMMAND = {
  id: BUILTIN_BROWSER_COMMAND_ID,
  title: "内置浏览器",
  command: "/browser",
  usage: "/browser <浏览器任务>",
  description: "使用内置浏览器 browser_* 工具执行网页操作",
  insertText: "",
  keywords: ["browser", "内置浏览器", "浏览器", "网页操作"]
}

export function isBuiltinBrowserSlashCommand(command: { id: string }): boolean {
  return command.id === BUILTIN_BROWSER_COMMAND_ID
}

export function formatBuiltinBrowserPrompt(
  input: string,
  screenshotEnabled = isBuiltinBrowserScreenshotEnabled()
): string {
  return `${getBuiltinBrowserPromptPrefix(screenshotEnabled)}${input}`
}

export function parseBuiltinBrowserPrompt(input: string): {
  visibleText: string
  browserSelected: boolean
} {
  if (input.startsWith(BUILTIN_BROWSER_NO_SCREENSHOT_PROMPT_PREFIX)) {
    return {
      visibleText: input.slice(BUILTIN_BROWSER_NO_SCREENSHOT_PROMPT_PREFIX.length),
      browserSelected: true
    }
  }
  if (input.startsWith(LEGACY_BUILTIN_BROWSER_PROMPT_PREFIX)) {
    return {
      visibleText: input.slice(LEGACY_BUILTIN_BROWSER_PROMPT_PREFIX.length),
      browserSelected: true
    }
  }
  if (!input.startsWith(BUILTIN_BROWSER_PROMPT_PREFIX)) {
    return { visibleText: input, browserSelected: false }
  }
  return {
    visibleText: input.slice(BUILTIN_BROWSER_PROMPT_PREFIX.length),
    browserSelected: true
  }
}
