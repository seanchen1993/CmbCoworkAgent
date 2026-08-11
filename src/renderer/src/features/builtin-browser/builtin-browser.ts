export const BUILTIN_BROWSER_COMMAND_ID = "builtin-browser"
export const BUILTIN_BROWSER_PROMPT_PREFIX = "使用内置浏览器 browser_*工具："

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

export function formatBuiltinBrowserPrompt(input: string): string {
  return `${BUILTIN_BROWSER_PROMPT_PREFIX}${input}`
}

export function parseBuiltinBrowserPrompt(input: string): {
  visibleText: string
  browserSelected: boolean
} {
  if (!input.startsWith(BUILTIN_BROWSER_PROMPT_PREFIX)) {
    return { visibleText: input, browserSelected: false }
  }
  return {
    visibleText: input.slice(BUILTIN_BROWSER_PROMPT_PREFIX.length),
    browserSelected: true
  }
}
