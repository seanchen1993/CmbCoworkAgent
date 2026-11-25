// Relative (not "@/") so this module stays importable from unit tests that
// don't resolve the "@/" path alias for runtime values.
import {
  BOT_BROWSER_PROMPT_PREFIX,
  BUILTIN_BROWSER_NO_SCREENSHOT_PROMPT_PREFIX,
  BUILTIN_BROWSER_PROMPT_PREFIX,
  stripBuiltinBrowserInstructions,
  stripLegacyBuiltinBrowserInstructions
} from "../../../../shared/user-input-transport"

export { BUILTIN_BROWSER_NO_SCREENSHOT_PROMPT_PREFIX, BUILTIN_BROWSER_PROMPT_PREFIX }

export const BUILTIN_BROWSER_COMMAND_ID = "builtin-browser"
export const BUILTIN_BROWSER_SCREENSHOT_DISABLED_PROMPT = "（不允许使用截图功能）"

// Keep the MCP screenshot capability available. The builtin-browser skill owns
// the stricter model-vision/OCR eligibility check before the tool is invoked.
let builtinBrowserScreenshotEnabled = true
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
  description: "使用 devclaw-in-app-browser 技能执行安全的网页操作",
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
  const wrappedText = stripBuiltinBrowserInstructions(input)
  if (wrappedText !== null) {
    return { visibleText: wrappedText, browserSelected: true }
  }
  if (input.startsWith(BOT_BROWSER_PROMPT_PREFIX)) {
    return {
      visibleText: input.slice(BOT_BROWSER_PROMPT_PREFIX.length),
      browserSelected: true
    }
  }
  const legacyText = stripLegacyBuiltinBrowserInstructions(input)
  if (legacyText !== null) return { visibleText: legacyText, browserSelected: true }
  return { visibleText: input, browserSelected: false }
}
