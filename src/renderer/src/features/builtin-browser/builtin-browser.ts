export const BUILTIN_BROWSER_COMMAND_ID = "builtin-browser"
export const BUILTIN_BROWSER_PROMPT_PREFIX = "使用内置浏览器 browser_*工具："
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
    : `${BUILTIN_BROWSER_PROMPT_PREFIX.slice(0, -1)}${BUILTIN_BROWSER_SCREENSHOT_DISABLED_PROMPT}：`
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
  const screenshotDisabledPrefix = getBuiltinBrowserPromptPrefix(false)
  if (input.startsWith(screenshotDisabledPrefix)) {
    return {
      visibleText: input.slice(screenshotDisabledPrefix.length),
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
