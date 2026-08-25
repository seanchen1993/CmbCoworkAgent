import {
  formatBuiltinBrowserPrompt,
  isBuiltinBrowserSlashCommand,
  parseBuiltinBrowserPrompt
} from "./builtin-browser"

const BUILTIN_BROWSER_TITLE_SOURCE = "使用内置浏览器"

export function isBuiltinBrowserCommandSelection(
  command: { id: string } | null | undefined
): boolean {
  return Boolean(command && isBuiltinBrowserSlashCommand(command))
}

export function resolveBuiltinBrowserVisibleUserText(params: {
  browserSelected: boolean
  fallbackUserText: string
  rawMessage: string
}): string {
  if (params.browserSelected) return params.rawMessage
  return params.rawMessage || params.fallbackUserText
}

export function formatBuiltinBrowserTransportMessage(
  rawMessage: string,
  browserSelected: boolean
): string {
  if (!browserSelected) return rawMessage
  return formatBuiltinBrowserPrompt(rawMessage)
}

export function formatBuiltinBrowserTranscriptMessage(
  displayContent: string,
  browserSelected: boolean
): string {
  if (!browserSelected) return displayContent
  return formatBuiltinBrowserPrompt(displayContent)
}

export function getBuiltinBrowserTitleSource(browserSelected: boolean): string {
  if (!browserSelected) return ""
  return BUILTIN_BROWSER_TITLE_SOURCE
}

export function parseBuiltinBrowserEditDraft(input: string): {
  browserSelected: boolean
  visibleText: string
} {
  return parseBuiltinBrowserPrompt(input)
}

export function parseUserVisibleBuiltinBrowserContent(input: string): {
  browserSelected: boolean
  visibleText: string
} {
  return parseBuiltinBrowserPrompt(input)
}

export function stripBuiltinBrowserPrompt(input: string): string {
  return parseBuiltinBrowserPrompt(input).visibleText
}

export function shouldRemoveBuiltinBrowserChipWithBackspace(params: {
  browserSelected: boolean
  inputLength: number
  isComposing: boolean
  key: string
}): boolean {
  return (
    params.key === "Backspace" &&
    !params.isComposing &&
    params.browserSelected &&
    params.inputLength === 0
  )
}
